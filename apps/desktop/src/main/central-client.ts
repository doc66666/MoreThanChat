import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Directory,
  RelayEvent,
  RelayMessage,
  ServerSnapshot,
} from '@more-than-chat/central-protocol'
import {
  parseDirectory,
  parseRelayEvent,
} from '@more-than-chat/central-protocol'
import { ClientIdentity } from './identity-store'
import { AttachmentStore } from './attachments'
import { ChatStore } from './chat-store'

export const DEFAULT_CENTRAL_ADDRESS =
  process.env.MTC_DEFAULT_CENTRAL_URL ?? 'http://localhost:8787'
class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export function normalizeServerAddress(value: string): string {
  const url = new URL(value.trim())
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/'
  )
    throw new Error('请输入服务器根地址')
  if (
    url.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('远程中心服务器必须使用 HTTPS')
  return url.origin
}
export class CentralClient {
  #snapshot: ServerSnapshot
  #token: string | null = null
  #controller: AbortController | null = null
  #epoch = 0
  #configured = false
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #wantConnection = false
  #listeners = new Set<(snapshot: ServerSnapshot) => void>()
  #chatListeners = new Set<(state: unknown) => void>()
  #pluginListeners = new Set<
    (event: Extract<RelayEvent, { kind: 'plugin' }>) => void
  >()
  constructor(
    readonly identity: ClientIdentity,
    readonly store: ChatStore,
    readonly attachments: AttachmentStore,
    readonly directory: string,
  ) {
    this.#snapshot = {
      status: 'disconnected',
      address: DEFAULT_CENTRAL_ADDRESS,
      serverId: null,
      mode: null,
      userId: identity.userId,
      displayName: '我',
      error: null,
      directory: null,
    }
  }
  async load(): Promise<void> {
    const state = this.store.load()
    if (state) this.#snapshot.displayName = String(state.profile.displayName)
    try {
      const saved = JSON.parse(
        await readFile(
          path.join(this.directory, 'central-settings.json'),
          'utf8',
        ),
      ) as { address: string; displayName: string; autoConnect?: boolean }
      this.#snapshot.address = normalizeServerAddress(saved.address)
      this.#snapshot.displayName = saved.displayName.slice(0, 80)
      this.#configured = saved.autoConnect !== false
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.#snapshot.error = '中心服务器配置未能恢复'
    }
  }
  async restore(): Promise<void> {
    if (this.#configured)
      await this.connect(
        this.#snapshot.address,
        this.#snapshot.displayName,
      ).catch(() => undefined)
  }
  snapshot(): ServerSnapshot {
    return structuredClone(this.#snapshot)
  }
  subscribe(listener: (snapshot: ServerSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  onChat(listener: (state: unknown) => void): () => void {
    this.#chatListeners.add(listener)
    return () => this.#chatListeners.delete(listener)
  }
  onPlugin(
    listener: (event: Extract<RelayEvent, { kind: 'plugin' }>) => void,
  ): () => void {
    this.#pluginListeners.add(listener)
    return () => this.#pluginListeners.delete(listener)
  }
  #emit(): void {
    for (const callback of this.#listeners) callback(this.snapshot())
  }
  #signature(value: any, serverId: string): string {
    if (
      !value ||
      value.userId !== this.identity.userId ||
      typeof value.challenge !== 'string' ||
      value.challenge.length > 4096 ||
      typeof value.challengeId !== 'string'
    )
      throw new Error('无效身份挑战')
    const parsed = JSON.parse(value.challenge) as Record<string, unknown>
    if (
      Object.keys(parsed).length !== 4 ||
      parsed.protocolVersion !== 1 ||
      parsed.serverId !== serverId ||
      parsed.userId !== this.identity.userId ||
      typeof parsed.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(parsed.nonce)
    )
      throw new Error('身份挑战不匹配')
    return this.identity.sign(value.challenge)
  }
  async #request(
    route: string,
    method = 'GET',
    data?: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    const result = await fetch(this.#snapshot.address + '/v1/' + route, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.#token ? { authorization: 'Bearer ' + this.#token } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: signal ?? AbortSignal.timeout(10000),
    })
    const reader = result.body?.getReader()
    if (!reader) throw new Error('服务器没有返回响应体')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 32 * 1024 * 1024) throw new Error('服务器响应超出限制')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      error?: string
    }
    if (!result.ok) {
      let message =
        typeof value.error === 'string' ? value.error : '服务器请求失败'
      if (this.#token) message = message.split(this.#token).join('[redacted]')
      message = message
        .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
        .slice(0, 240)
      throw new ServerError(result.status, message)
    }
    return value
  }
  async connect(address: string, displayName: string): Promise<ServerSnapshot> {
    await this.disconnect(false)
    this.#snapshot = {
      ...this.#snapshot,
      address: normalizeServerAddress(address),
      displayName: displayName.trim().slice(0, 80) || '我',
      status: 'connecting',
      error: null,
      serverId: null,
      directory: null,
    }
    this.#emit()
    const epoch = ++this.#epoch
    this.#wantConnection = true
    try {
      const ping = await this.#request('ping')
      if (
        ping.protocolVersion !== 1 ||
        typeof ping.serverId !== 'string' ||
        !['public', 'private'].includes(ping.mode)
      )
        throw new Error('服务器协议不兼容')
      const challenge = await this.#request('challenge', 'POST', {
        publicKey: this.identity.publicKey,
        displayName: this.#snapshot.displayName,
      })
      const session = await this.#request('session', 'POST', {
        challengeId: challenge.challengeId,
        signature: this.#signature(challenge, ping.serverId),
      })
      if (
        session.serverId !== ping.serverId ||
        session.mode !== ping.mode ||
        typeof session.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(session.token)
      )
        throw new Error('认证会话无效')
      if (epoch !== this.#epoch) throw new Error('连接已取消')
      this.#token = session.token
      this.#snapshot = {
        ...this.#snapshot,
        status: 'connected',
        serverId: session.serverId,
        mode: session.mode,
        directory: session.directory,
      }
      const temporary = path.join(this.directory, 'central-settings.json.next')
      await writeFile(
        temporary,
        JSON.stringify({
          address: this.#snapshot.address,
          displayName: this.#snapshot.displayName,
        }),
        { mode: 0o600 },
      )
      await rename(
        temporary,
        path.join(this.directory, 'central-settings.json'),
      )
      this.#configured = true
      this.#projectDirectory(session.directory)
      this.#emit()
      this.#controller = new AbortController()
      void this.#loop(epoch, this.#controller.signal)
      return this.snapshot()
    } catch (e) {
      if (epoch === this.#epoch) {
        this.#snapshot.status = 'error'
        this.#snapshot.error = e instanceof Error ? e.message : '认证失败'
        this.#emit()
        if (this.#wantConnection)
          this.#retryTimer = setTimeout(() => {
            if (epoch === this.#epoch && this.#wantConnection)
              void this.connect(
                this.#snapshot.address,
                this.#snapshot.displayName,
              ).catch(() => undefined)
          }, 5000)
      }
      throw e
    }
  }
  async disconnect(manual = true): Promise<void> {
    this.#wantConnection = false
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    ++this.#epoch
    this.#controller?.abort()
    this.#controller = null
    if (this.#token)
      await this.#request(
        'logout',
        'POST',
        {},
        AbortSignal.timeout(2000),
      ).catch(() => undefined)
    this.#token = null
    this.#snapshot.status = 'disconnected'
    this.#snapshot.directory = null
    this.#emit()
    if (manual && this.#configured) {
      await writeFile(
        path.join(this.directory, 'central-settings.json'),
        JSON.stringify({
          address: this.#snapshot.address,
          displayName: this.#snapshot.displayName,
          autoConnect: false,
        }),
        { mode: 0o600 },
      )
    }
  }
  async #loop(epoch: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && epoch === this.#epoch) {
      try {
        const result = (await this.#request(
          'events',
          'GET',
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        )) as { events: RelayEvent[]; directory: Directory }
        if (epoch !== this.#epoch || signal.aborted) return
        if (!Array.isArray(result.events) || result.events.length > 20)
          throw new Error('服务器事件流无效')
        this.#projectDirectory(result.directory)
        const events = result.events.map(parseRelayEvent)
        for (const event of events) {
          if (event.kind === 'message') await this.#receive(event.message)
          else if (event.kind === 'plugin') {
            const fresh = this.store.savePluginEvent(
              this.#snapshot.serverId!,
              event,
            )
            if (fresh)
              for (const listener of this.#pluginListeners) {
                try {
                  listener(event)
                } catch {}
              }
          }
        }
        // Message files and SQLite are committed before the delivery receipt.
        if (events.length)
          await this.#request(
            'ack',
            'POST',
            { ids: events.map((event) => event.id) },
            signal,
          )
        this.#snapshot.status = 'connected'
        this.#snapshot.error = null
        this.#emit()
      } catch (error) {
        if (signal.aborted || epoch !== this.#epoch) return
        this.#snapshot.status = 'error'
        this.#snapshot.error =
          error instanceof Error ? error.message : '连接中断'
        this.#emit()
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, 2000)
          if (signal.aborted) finish()
          else signal.addEventListener('abort', finish, { once: true })
        })
        if (
          error instanceof ServerError &&
          error.status === 401 &&
          !signal.aborted
        ) {
          try {
            const challenge = await this.#request('challenge', 'POST', {
              publicKey: this.identity.publicKey,
              displayName: this.#snapshot.displayName,
            })
            const session = await this.#request('session', 'POST', {
              challengeId: challenge.challengeId,
              signature: this.#signature(challenge, this.#snapshot.serverId!),
            })
            if (epoch !== this.#epoch) return
            if (
              session.serverId !== this.#snapshot.serverId ||
              typeof session.token !== 'string' ||
              !/^[A-Za-z0-9_-]{43}$/.test(session.token)
            )
              throw new Error('地址对应的服务器已更换，请手动重新连接')
            this.#token = session.token
            this.#snapshot.status = 'connected'
            this.#snapshot.error = null
            this.#projectDirectory(session.directory)
            this.#emit()
          } catch {}
        }
      }
    }
  }
  async action(route: string, data: unknown): Promise<ServerSnapshot> {
    if (!this.#token) throw new Error('请先连接中心服务器')
    await this.#request(route, 'POST', data)
    this.#projectDirectory(await this.#request('directory'))
    this.#emit()
    return this.snapshot()
  }
  pluginInbox(groupId: string, pluginId: string): unknown[] {
    if (!this.#snapshot.serverId) return []
    return this.store.pluginInbox(this.#snapshot.serverId, groupId, pluginId)
  }
  #localId(remoteId: string): string {
    return this.#snapshot.serverId + ':' + remoteId
  }
  #dmId(peer: string): string {
    return (
      'dm_' +
      createHash('sha256')
        .update([this.identity.userId, peer].sort().join(':'))
        .digest('hex')
    )
  }
  #projectDirectory(directory: Directory): void {
    directory = parseDirectory(directory)
    for (const plugin of directory.plugins)
      if (
        createHash('sha256')
          .update(JSON.stringify(plugin.pack))
          .digest('hex') !== plugin.digest
      )
        throw new Error('插件包内容摘要不匹配')
    if (
      !this.#snapshot.serverId ||
      !directory?.self ||
      directory.self.id !== this.identity.userId ||
      !Array.isArray(directory.friends) ||
      !Array.isArray(directory.groups)
    )
      throw new Error('服务器目录无效')
    this.#snapshot.directory = directory
    const state = this.store.load()
    if (!state) return
    state.profile = {
      ...state.profile,
      id: this.identity.userId,
      displayName: this.#snapshot.displayName,
      avatar: this.#snapshot.displayName.slice(0, 2),
    }
    for (const item of [
      ...directory.friends.map((friend) => ({
        remoteId: this.#dmId(friend.id),
        targetId: friend.id,
        title: friend.displayName,
        kind: 'direct',
      })),
      ...directory.groups.map((group) => ({
        remoteId: group.id,
        targetId: group.id,
        title: group.name,
        kind: 'group',
      })),
    ]) {
      const id = this.#localId(item.remoteId),
        existing = state.conversations.find((c) => c.id === id)
      const conversation = {
        id,
        title: item.title,
        subtitle: '中心服务器 · ' + (item.kind === 'group' ? '群聊' : '好友'),
        avatar: item.title.slice(0, 2),
        accent: item.kind === 'group' ? '#655be7' : '#21855e',
        kind: item.kind,
        unread: existing?.unread ?? 0,
        pinned: existing?.pinned ?? false,
        updatedAt: existing?.updatedAt ?? Date.now(),
        transportId: 'builtin.central',
        serverId: this.#snapshot.serverId,
        targetId: item.targetId,
        remoteId: item.remoteId,
      }
      if (existing) Object.assign(existing, conversation)
      else {
        state.conversations.push(conversation)
        state.messages[id] = []
      }
    }
    this.store.save(state, { serverId: this.#snapshot.serverId, directory })
    this.#publishChat()
  }
  #publishChat(): void {
    const state = this.store.load()
    for (const callback of this.#chatListeners) callback(state)
  }
  async #receive(message: RelayMessage): Promise<void> {
    const serverId = this.#snapshot.serverId
    const state = this.store.load()
    if (!state || !this.#snapshot.serverId)
      throw new Error('本地消息存储未就绪')
    const conversationId = this.#localId(message.conversationId),
      conversation = state.conversations.find((c) => c.id === conversationId)
    if (!conversation) throw new Error('收件会话不在当前服务器目录中')
    const list = state.messages[conversationId] ?? []
    if (
      list.some(
        (m) =>
          m.id === message.id ||
          (m.senderId === message.senderId &&
            m.clientMessageId === message.clientMessageId),
      )
    )
      return
    const attachment = message.attachment
      ? await this.attachments.receive(message.attachment)
      : undefined
    if (serverId !== this.#snapshot.serverId)
      throw new Error('收件期间服务器已切换，暂不确认旧服务器消息')
    list.push({
      id: message.id,
      clientMessageId: message.clientMessageId,
      conversationId,
      senderId: message.senderId,
      senderName: message.senderName,
      senderAvatar: message.senderName.slice(0, 2),
      role: message.senderId === this.identity.userId ? 'self' : 'peer',
      type: 'text',
      text: message.text,
      createdAt: message.createdAt,
      status: 'sent',
      serverId,
      ...(attachment ? { attachment } : {}),
    })
    state.messages[conversationId] = list
    conversation.updatedAt = message.createdAt
    if (state.activeConversationId !== conversationId)
      conversation.unread = Number(conversation.unread) + 1
    this.store.save(state)
    this.#publishChat()
  }
  async send(input: {
    conversationId: string
    clientMessageId: string
    text: string
    attachmentId?: string
  }): Promise<{ eventId: string; acceptedAt: number }> {
    const epoch = this.#epoch
    const state = this.store.load(),
      conversation = state?.conversations.find(
        (c) => c.id === input.conversationId,
      )
    if (
      !state ||
      !conversation ||
      conversation.serverId !== this.#snapshot.serverId ||
      !this.#token ||
      this.#snapshot.status !== 'connected'
    )
      throw new Error('此会话需要连接它所属的中心服务器')
    const attachment = input.attachmentId
      ? await this.attachments.read(input.attachmentId)
      : undefined
    const result = await this.#request('messages', 'POST', {
      clientMessageId: input.clientMessageId,
      targetKind: conversation.kind,
      targetId: conversation.targetId,
      text: input.text,
      ...(attachment ? { attachment } : {}),
    })
    if (epoch !== this.#epoch)
      throw new Error('发送期间服务器已切换；请在原服务器核对消息')
    const ref = attachment
      ? {
          id: attachment.id,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
          ...(attachment.durationMs === undefined
            ? {}
            : { durationMs: attachment.durationMs }),
        }
      : undefined
    const latest = this.store.load()!
    const list = latest.messages[input.conversationId] ?? []
    const previous = list.findIndex(
      (m) =>
        m.clientMessageId === input.clientMessageId &&
        m.senderId === this.identity.userId,
    )
    const message = {
      id: result.messageId,
      clientMessageId: input.clientMessageId,
      conversationId: input.conversationId,
      senderId: this.identity.userId,
      senderName: this.#snapshot.displayName,
      senderAvatar: this.#snapshot.displayName.slice(0, 2),
      role: 'self',
      type: 'text',
      text: input.text,
      createdAt: result.acceptedAt,
      status: 'sent',
      serverId: this.#snapshot.serverId,
      ...(ref ? { attachment: ref } : {}),
    }
    if (previous >= 0) list[previous] = message
    else list.push(message)
    latest.messages[input.conversationId] = list
    const c = latest.conversations.find((c) => c.id === input.conversationId)!
    c.updatedAt = result.acceptedAt
    this.store.save(latest)
    this.#publishChat()
    return { eventId: result.messageId, acceptedAt: result.acceptedAt }
  }
}
