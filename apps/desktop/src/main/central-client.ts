import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
  parseMessageReceipt,
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
function serverAddressKey(value:string):string {
  const url=new URL(value)
  return ['localhost','127.0.0.1','[::1]'].includes(url.hostname)?url.protocol+'//loopback:'+url.port:url.origin
}
export class CentralClient {
  #snapshot: ServerSnapshot
  #token: string | null = null
  #controller: AbortController | null = null
  #epoch = 0
  #configured = false
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #wantConnection = false
  #readingId: string | null = null
  #draining = false
  #workerTimer: ReturnType<typeof setTimeout> | undefined
  #supportsReceipts = false
  #settingsWrites: Promise<void> = Promise.resolve()
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
    readonly confirmServerMove?: (serverId:string,previous:string,next:string)=>Promise<boolean>,
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
    connection?: {address:string;token:string|null},
  ): Promise<any> {
    const token=connection?connection.token:this.#token
    const result = await fetch((connection?.address??this.#snapshot.address) + '/v1/' + route, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
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
      if (token) message = message.split(token).join('[redacted]')
      message = message
        .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
        .slice(0, 240)
      throw new ServerError(result.status, message)
    }
    return value
  }
  async connect(address: string, displayName: string): Promise<ServerSnapshot> {
    const targetAddress=normalizeServerAddress(address)
    const epoch=++this.#epoch
    await this.#stopConnection()
    if(epoch!==this.#epoch)throw new Error('连接已取消')
    this.#snapshot = {
      ...this.#snapshot,
      address: targetAddress,
      displayName: displayName.trim().slice(0, 80) || '我',
      status: 'connecting',
      error: null,
      serverId: null,
      directory: null,
    }
    this.#emit()
    const controller=new AbortController()
    this.#controller=controller
    const request=(route:string,method='GET',data?:unknown)=>this.#request(route,method,data,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]),{address:targetAddress,token:null})
    this.#wantConnection = true
    try {
      const ping = await request('ping')
      if (
        ping.protocolVersion !== 1 ||
        typeof ping.serverId !== 'string' || !/^srv_[a-f0-9-]{36}$/.test(ping.serverId) ||
        !['public', 'private'].includes(ping.mode)
      )
        throw new Error('服务器协议不兼容')
      if(epoch!==this.#epoch)throw new Error('连接已取消')
      const previousOrigin=this.store.serverOrigin(ping.serverId)
      if(previousOrigin && serverAddressKey(previousOrigin)!==serverAddressKey(targetAddress)) {
        const accepted=await this.confirmServerMove?.(ping.serverId,previousOrigin,targetAddress)
        if(epoch!==this.#epoch)throw new Error('连接已取消')
        if(!accepted){this.#wantConnection=false;throw new Error('此服务器 ID 已绑定另一个地址，尚未确认地址变更')}
      }
      if(epoch!==this.#epoch)throw new Error('连接已取消')
      this.#supportsReceipts = Array.isArray(ping.features) && ping.features.includes('message-receipts-v1')
      const challenge = await request('challenge', 'POST', {
        publicKey: this.identity.publicKey,
        displayName: this.#snapshot.displayName,
      })
      if(epoch!==this.#epoch)throw new Error('连接已取消')
      const session = await request('session', 'POST', {
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
      await this.#persistSettings({address:targetAddress,displayName:this.#snapshot.displayName},epoch)
      if(epoch!==this.#epoch)throw new Error('连接已取消')
      this.store.rememberServerOrigin(session.serverId,targetAddress)
      this.#configured = true
      this.#projectDirectory(session.directory)
      this.#emit()
      void this.#loop(epoch, this.#controller.signal)
      void this.#drain()
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
    const epoch=++this.#epoch
    this.#snapshot.status='disconnected'
    this.#snapshot.directory=null
    this.#emit()
    await this.#stopConnection()
    if(epoch!==this.#epoch)return
    if(manual && this.#configured)
      await this.#persistSettings({address:this.#snapshot.address,displayName:this.#snapshot.displayName,autoConnect:false},epoch)
  }
  async #stopConnection():Promise<void> {
    if (this.#workerTimer) clearTimeout(this.#workerTimer)
    this.#workerTimer = undefined
    this.#wantConnection = false
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    this.#controller?.abort()
    this.#controller = null
    const token=this.#token,address=this.#snapshot.address
    this.#token=null
    if (token)
      await this.#request(
        'logout',
        'POST',
        {},
        AbortSignal.timeout(2000),
        {address,token},
      ).catch(() => undefined)
  }
  async #persistSettings(settings:{address:string;displayName:string;autoConnect?:boolean},epoch:number):Promise<void> {
    const task=this.#settingsWrites.catch(()=>undefined).then(async()=>{
      if(epoch!==this.#epoch)throw new Error('连接已取消')
      const temporary=path.join(this.directory,'central-settings.json.next.'+randomUUID())
      try {
        await writeFile(temporary,JSON.stringify(settings),{mode:0o600})
        if(epoch!==this.#epoch)throw new Error('连接已取消')
        await rename(temporary,path.join(this.directory,'central-settings.json'))
      }finally{await unlink(temporary).catch(()=>undefined)}
    })
    this.#settingsWrites=task
    await task
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
          else if (event.kind === 'directory' && event.receipt) {
            const state = this.store.load()
            if (state) {
              const id = this.#applyReceipt(state,event.receipt)
              if (id) { this.store.save(state,undefined,{authoritative:true,outboxRemove:id});this.#publishChat() }
            }
          }
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
        void this.#drain()
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
    if (directory.revision !== undefined && (this.#snapshot.directory?.revision ?? -1) > directory.revision) return
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
    for (const conversation of state.conversations.filter(c=>c.serverId===this.#snapshot.serverId)) conversation.unavailable = true
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
        unavailable: false,
      }
      if (existing) Object.assign(existing, conversation)
      else {
        state.conversations.push(conversation)
        state.messages[id] = []
      }
    }
    const confirmed = (directory.receipts ?? []).map(receipt=>this.#applyReceipt(state,receipt)).filter((id):id is string=>Boolean(id))
    this.store.save(state, { serverId: this.#snapshot.serverId, directory },{authoritative:true,outboxRemove:confirmed})
    this.#publishChat()
  }
  #publishChat(): void {
    const state = this.store.load()
    for (const callback of this.#chatListeners) callback(state)
  }
  refreshChat(): void { this.#publishChat() }
  async #receive(message: RelayMessage): Promise<void> {
    const serverId=this.#snapshot.serverId,conversationId=this.#localId(message.conversationId)
    if(!serverId)throw new Error('本地消息存储未就绪')
    const duplicate=(state:NonNullable<ReturnType<ChatStore['load']>>) => (state.messages[conversationId]??[]).some(m=>m.id===message.id||(m.senderId===message.senderId&&m.clientMessageId===message.clientMessageId))
    const before=this.store.load()
    if(!before)throw new Error('本地消息存储未就绪')
    if(duplicate(before))return
    const attachment=message.attachment?await this.attachments.receive(message.attachment):undefined
    if(serverId!==this.#snapshot.serverId)throw new Error('收件期间服务器已切换，暂不确认旧服务器消息')
    // Rebase after attachment I/O: sender receipts, read markers and preferences may have committed meanwhile.
    const state=this.store.load()!
    if(duplicate(state))return
    let conversation=state.conversations.find(c=>c.id===conversationId)
    if(!conversation){
      conversation={id:conversationId,title:message.targetKind==='group'?(message.targetName??'已离开的群聊'):message.senderName,subtitle:'历史会话 · 当前关系已不可用',
        avatar:message.senderName.slice(0,2),accent:'#655be7',kind:message.targetKind,unread:0,pinned:false,updatedAt:message.createdAt,transportId:'builtin.central',
        serverId,targetId:message.targetKind==='group'?message.targetId:message.senderId,remoteId:message.conversationId,unavailable:true}
      state.conversations.push(conversation);state.messages[conversationId]=[]
    }
    const reading=this.#readingId===conversationId&&message.senderId!==this.identity.userId
    const list=state.messages[conversationId]??[]
    list.push({id:message.id,clientMessageId:message.clientMessageId,conversationId,senderId:message.senderId,senderName:message.senderName,
      senderAvatar:message.senderName.slice(0,2),role:message.senderId===this.identity.userId?'self':'peer',type:'text',text:message.text,
      createdAt:message.createdAt,status:'sent',serverId,...(attachment?{attachment}:{}),...(reading?{readAt:Date.now()}:{})})
    state.messages[conversationId]=list
    conversation.updatedAt=Math.max(Number(conversation.updatedAt),message.createdAt)
    if(message.senderId!==this.identity.userId)conversation.unread=reading?0:Number(conversation.unread)+1
    if(!conversation.muted)conversation.archived=false
    this.store.save(state,undefined,{authoritative:true,...(reading&&this.#supportsReceipts?{readMessages:[{serverId,messageId:message.id}]}:{})})
    this.#publishChat()
  }
  #applyReceipt(state: NonNullable<ReturnType<ChatStore['load']>>, raw: unknown): string | undefined {
    const receipt = parseMessageReceipt(raw)
    for (const list of Object.values(state.messages)) {
      const message = list.find(m=>m.serverId===this.#snapshot.serverId && m.senderId===this.identity.userId && m.clientMessageId===receipt.clientMessageId)
      if (!message) continue
      const previous = message.receipt as { deliveredCount:number;readCount:number } | undefined
      message.id = receipt.messageId
      message.createdAt = receipt.acceptedAt
      message.status = 'sent'
      delete message.errorMessage
      message.receipt = { recipientCount:receipt.recipientCount,deliveredCount:Math.max(previous?.deliveredCount??0,receipt.deliveredCount),readCount:Math.max(previous?.readCount??0,receipt.readCount) }
      return receipt.clientMessageId
    }
  }

  setReadingConversation(id: string | null): void {
    this.#readingId = id
    if (!id) return
    const state = this.store.load(), conversation = state?.conversations.find(c=>c.id===id)
    if (!state || !conversation || typeof conversation.serverId!=='string') return
    const reads: {serverId:string;messageId:string}[] = []
    for (const message of state.messages[id] ?? []) {
      if (message.role!=='peer' || message.status!=='sent' || message.readAt || !message.serverId) continue
      message.readAt = Date.now()
      if (/^[a-f0-9-]{36}$/.test(String(message.id))) reads.push({serverId:String(message.serverId),messageId:String(message.id)})
    }
    if (!reads.length && conversation.unread===0) return
    conversation.unread = 0
    this.store.save(state,undefined,{authoritative:true,readMessages:reads})
    this.#publishChat()
    void this.#drain()
  }

  async send(input: {conversationId:string;clientMessageId:string;text:string;attachmentId?:string}): Promise<{eventId:string;acceptedAt:number;queued?:boolean}> {
    const state = this.store.load(), conversation = state?.conversations.find(c=>c.id===input.conversationId)
    if (!state || !conversation || typeof conversation.serverId!=='string' || conversation.transportId!=='builtin.central')
      throw new Error('找不到中心服务器会话')
    if(!this.store.serverOrigin(conversation.serverId))throw new Error('请先连接此服务器一次以确认地址，再排队发送消息')
    if (!input.clientMessageId || input.clientMessageId.length>80 || input.text.length>100000 || (!input.text.trim() && !input.attachmentId))
      throw new Error('消息不能为空或超出长度限制')
    if (conversation.unavailable && conversation.serverId===this.#snapshot.serverId && this.#snapshot.status==='connected')
      throw new Error('你已不在此群内，或已不是本服好友')
    const wire = input.attachmentId ? await this.attachments.read(input.attachmentId) : undefined
    const latest = this.store.load()!
    const list = latest.messages[input.conversationId] ?? []
    const existing = list.find(m=>m.senderId===this.identity.userId && m.clientMessageId===input.clientMessageId)
    if (existing && (existing.text!==input.text || (existing.attachment as {id:string}|undefined)?.id!==input.attachmentId)) throw new Error('同一消息 ID 不能替换内容')
    if (existing?.status==='sent') return {eventId:String(existing.id),acceptedAt:Number(existing.createdAt)}
    const now = Number(existing?.createdAt ?? Date.now())
    const attachment = wire ? {id:wire.id,name:wire.name,mime:wire.mime,size:wire.size,...(wire.durationMs===undefined?{}:{durationMs:wire.durationMs})} : undefined
    const message = {id:existing?.id ?? input.clientMessageId,clientMessageId:input.clientMessageId,conversationId:input.conversationId,
      senderId:this.identity.userId,senderName:this.#snapshot.displayName,senderAvatar:this.#snapshot.displayName.slice(0,2),
      role:'self',type:'text',text:input.text,createdAt:now,status:'queued',serverId:conversation.serverId,...(attachment?{attachment}:{})}
    if (existing) Object.assign(existing,message,{errorMessage:undefined})
    else list.push(message)
    latest.messages[input.conversationId]=list
    const current=latest.conversations.find(c=>c.id===input.conversationId)!
    current.updatedAt=now
    current.archived=false
    this.store.save(latest,undefined,{authoritative:true,outboxPut:{serverId:conversation.serverId,conversationId:input.conversationId,clientMessageId:input.clientMessageId,createdAt:now}})
    this.#publishChat()
    void this.#drain()
    return {eventId:String(message.id),acceptedAt:now,queued:true}
  }

  async retryMessage(messageId: string): Promise<void> {
    const state = this.store.load()
    const message = Object.values(state?.messages ?? {}).flat().find(m=>m.id===messageId && m.senderId===this.identity.userId)
    if (!message || !['failed','queued'].includes(String(message.status))) throw new Error('此消息不能重试')
    await this.send({conversationId:String(message.conversationId),clientMessageId:String(message.clientMessageId),text:String(message.text),
      ...((message.attachment as {id:string}|undefined)?.id ? {attachmentId:(message.attachment as {id:string}).id} : {})})
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#snapshot.status!=='connected' || !this.#token || !this.#snapshot.serverId) return
    if (this.#workerTimer) clearTimeout(this.#workerTimer)
    this.#workerTimer=undefined
    this.#draining=true
    const epoch=this.#epoch,serverId=this.#snapshot.serverId
    try {
      for (const entry of this.store.outbox(serverId)) {
        if (epoch!==this.#epoch || this.#snapshot.status!=='connected') return
        const state=this.store.load()!,conversation=state.conversations.find(c=>c.id===entry.conversationId)
        const message=state.messages[entry.conversationId]?.find(m=>m.clientMessageId===entry.clientMessageId && m.senderId===this.identity.userId)
        if (!message || !conversation) continue
        let requesting=false
        try {
          const ref=message.attachment as {id:string;name:string;mime:string;size:number;durationMs?:number}|undefined
          const attachment=ref ? {id:ref.id,name:ref.name,mime:ref.mime,size:ref.size,data:(await this.attachments.read(ref.id)).data,...(ref.durationMs===undefined?{}:{durationMs:ref.durationMs})} : undefined
          if(epoch!==this.#epoch)return
          requesting=true
          const result=await this.#request('messages','POST',{clientMessageId:entry.clientMessageId,targetKind:conversation.kind,targetId:conversation.targetId,text:message.text,...(attachment?{attachment}:{})},
            AbortSignal.any([this.#controller!.signal,AbortSignal.timeout(10000)]))
          if(epoch!==this.#epoch)return
          if(typeof result.messageId!=='string'||!/^[a-f0-9-]{36}$/.test(result.messageId)||!Number.isSafeInteger(result.acceptedAt))throw new Error('发送回执无效')
          const latest=this.store.load()!,item=latest.messages[entry.conversationId]?.find(m=>m.clientMessageId===entry.clientMessageId && m.senderId===this.identity.userId)
          if(!item)throw new Error('本地发送记录丢失')
          item.id=result.messageId;item.createdAt=result.acceptedAt;item.status='sent';delete item.errorMessage
          if(result.receipt){const receipt=parseMessageReceipt(result.receipt);if(receipt.messageId!==result.messageId||receipt.clientMessageId!==entry.clientMessageId)throw new Error('回执与发送消息不匹配');this.#applyReceipt(latest,receipt)}
          this.store.save(latest,undefined,{authoritative:true,outboxRemove:entry.clientMessageId})
          this.#publishChat()
        } catch(error) {
          if(epoch!==this.#epoch)return
          const permanent=!requesting || error instanceof ServerError && error.status>=400 && error.status<500 && ![401,408,429].includes(error.status)
          const latest=this.store.load()!,item=latest.messages[entry.conversationId]?.find(m=>m.clientMessageId===entry.clientMessageId && m.senderId===this.identity.userId)
          if(item?.status==='sent')continue
          if(item){item.status=permanent?'failed':'queued';item.errorMessage=error instanceof ServerError?error.message:!requesting?'本机附件丢失或损坏，请重新选择附件。':'等待恢复连接后自动重试';
            this.store.save(latest,undefined,{authoritative:true,...(permanent?{outboxRemove:entry.clientMessageId}:{})});this.#publishChat()}
          if(!permanent)break
        }
      }
      if (epoch===this.#epoch && this.#supportsReceipts) {
        const ids=this.store.pendingReads(serverId)
        if(ids.length){await this.#request('read','POST',{ids},AbortSignal.any([this.#controller!.signal,AbortSignal.timeout(10000)]));if(epoch===this.#epoch)this.store.confirmReads(serverId,ids)}
      }
    } catch { /* The persisted queue is retried by the worker or reconnect. */ }
    finally {
      this.#draining=false
      if(this.#wantConnection && this.#snapshot.serverId && (this.store.outbox(this.#snapshot.serverId).length || this.#supportsReceipts && this.store.pendingReads(this.#snapshot.serverId).length))
        this.#workerTimer=setTimeout(()=>{void this.#drain()},2000)
    }
  }
}
