import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSeedState, type ChatMessage, type ChatState, type Conversation } from '@more-than-chat/chat-core'
import type { MessageRetraction } from '@more-than-chat/central-protocol'
import { AttachmentStore } from '../src/main/attachments'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { readHistoryArchive, writeHistoryArchive } from '../src/main/history-archive'
import { exportHistory, restoreHistory } from '../src/main/history-transfer'

type Context = Parameters<typeof exportHistory>[0]
type Row = Record<string, unknown>
const password = 'history-transfer-integration-password'
const timestamp = 1_700_000_000_000
let root: string
let identity: ClientIdentity
const stores: ChatStore[] = []

async function context(name: string, owner = identity): Promise<Context> {
  const directory = path.join(root, name)
  const store = await ChatStore.open(directory)
  stores.push(store)
  const initial = createSeedState(timestamp)
  initial.profile.displayName = name
  initial.messages[initial.activeConversationId] = []
  store.save(initial)
  const attachments = new AttachmentStore(path.join(directory, 'attachments'))
  await mkdir(attachments.directory)
  return { directory, store, attachments, identity: owner }
}

function localMessage(index: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'history-local-' + index, clientMessageId: 'history-local-' + index,
    conversationId: 'conversation-assistant', senderId: 'history-assistant', senderName: '助手', senderAvatar: 'AI',
    role: 'peer', type: 'text', text: '历史消息 ' + index, createdAt: timestamp + index, status: 'sent', ...extra,
  }
}

function saveMessages(target: Context, messages: ChatMessage[]): void {
  const state = target.store.load()!
  state.messages['conversation-assistant'] = messages.map(message => ({ ...message }))
  target.store.save(state, undefined, { authoritative: true })
}

async function fileState(target: Context): Promise<unknown> {
  const db = new DatabaseSync(path.join(target.directory, 'chat.sqlite'), { readOnly: true })
  try {
    const result: Record<string, unknown> = {}
    for (const table of ['chat_meta', 'conversations', 'messages', 'message_retractions', 'central_outbox', 'read_outbox']) {
      result[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    }
    result.attachments = await Promise.all((await readdir(target.attachments.directory)).sort().map(async name => ({ name, data: (await readFile(path.join(target.attachments.directory, name))).toString('base64') })))
    return result
  } finally { db.close() }
}

async function expectNoWorkspace(target: Context): Promise<void> {
  expect((await readdir(target.directory)).filter(name => name.startsWith('.history-work-'))).toEqual([])
}

async function archiveRecords(file: string): Promise<Row[]> {
  const opened = await readHistoryArchive(file, password, path.join(root, 'inspect'))
  try {
    const result: Row[] = []
    for await (const record of opened.records()) result.push(record as Row)
    return result
  } finally { await opened.dispose() }
}

async function signedArchive(file: string, records: Row[], signer = identity): Promise<void> {
  const body = records.filter(record => record.type !== 'end')
  const hash = createHash('sha256')
  for (const record of body) hash.update(JSON.stringify(record) + '\n')
  const digest = hash.digest('hex')
  await writeHistoryArchive(file, password, [...body, { type: 'end', digest, signature: signer.sign('MoreThanChat history v1\n' + digest) }])
}

async function withAttachment(target: Context, count = 2): Promise<{ id: string; bytes: Buffer }> {
  const bytes = Buffer.from('共享附件正文：同一内容，不同文件名。')
  const ref = await target.attachments.put(bytes, 'original.txt', 'text/plain')
  const messages = Array.from({ length: count }, (_, index) => localMessage(index))
  messages[0]!.attachment = ref
  if (messages[1]) messages[1].attachment = { ...ref, name: 'renamed.txt' }
  saveMessages(target, messages)
  return { id: ref.id, bytes }
}

describe('complete encrypted history transfer', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mtc-history-integration-'))
    identity = new ClientIdentity(generateKeyPairSync('ed25519').privateKey)
  })
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close()
    await rm(root, { recursive: true, force: true })
  })

  it('exports every page, retains per-message attachment filenames and restores searchable history across restart', async () => {
    const source = await context('source'), target = await context('target')
    const { id, bytes } = await withAttachment(source, 75)
    const current = source.store.load()!
    // This old record is outside the bounded load() projection: write it explicitly.
    source.store.save({ ...current, messages: { 'conversation-assistant': [localMessage(0, { text: 'oldest-unpaged-marker', attachment: { id, name: 'original.txt', mime: 'text/plain', size: bytes.length } })] } }, undefined, { authoritative: true })
    const file = path.join(root, 'history.mtchistory')
    expect(await exportHistory(source, file, password)).toEqual({ conversations: 1, messages: 75, attachments: 1 })
    const confirm = vi.fn(async () => true)
    expect(await restoreHistory(target, file, password, confirm)).toMatchObject({ messagesAdded: 75, conversationsAdded: 0, attachments: 1 })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ ownerId: identity.userId, messages: 75, attachments: 1 }))
    expect(target.store.messagePage('conversation-assistant').messages).toHaveLength(50)
    expect(target.store.messagePage('conversation-assistant').hasOlder).toBe(true)
    expect(target.store.searchMessages('oldest-unpaged-marker').map(message => message.messageId)).toEqual(['history-local-0'])
    expect(target.store.message('history-local-0')?.attachment).toMatchObject({ name: 'original.txt', id })
    expect(target.store.message('history-local-1')?.attachment).toMatchObject({ name: 'renamed.txt', id })
    expect(Buffer.from((await target.attachments.read(id)).data, 'base64')).toEqual(bytes)
    expect(target.store.load()?.profile.displayName).toBe('target')
    expect(target.store.message('history-local-0')?.readAt).toBeGreaterThan(timestamp)
    target.store.close()
    target.store = await ChatStore.open(target.directory); stores.push(target.store)
    expect(target.store.searchMessages('oldest-unpaged-marker')).toHaveLength(1)
    expect(target.store.message('history-local-1')?.attachment).toMatchObject({ name: 'renamed.txt' })
    expect(await restoreHistory(target, file, password, async () => true)).toMatchObject({ messagesAdded: 0, messagesSkipped: 75, attachments: 0 })
    await expectNoWorkspace(source); await expectNoWorkspace(target)
  }, 15_000)

  it('keeps newer local records, profile and settings and preserves messages arriving immediately before commit', async () => {
    const source = await context('source'), target = await context('target')
    saveMessages(source, [localMessage(0), localMessage(1)])
    const file = path.join(root, 'history.mtchistory'); await exportHistory(source, file, password)
    saveMessages(target, [localMessage(0, { text: 'current newer content', status: 'sent', readAt: timestamp + 500 })])
    const local = target.store.load()!
    local.conversations[0]!.title = '本机备注'; local.conversations[0]!.muted = true
    target.store.save(local, undefined, { authoritative: true })
    const beforeCommit = vi.fn(async () => {
      const state = target.store.load()!
      state.messages['conversation-assistant']!.push({ ...localMessage(99), text: 'incoming-during-restore', createdAt: timestamp + 999 })
      target.store.save(state, undefined, { authoritative: true })
    })
    expect(await restoreHistory({ ...target, beforeCommit }, file, password, async () => true)).toMatchObject({ messagesAdded: 1, messagesSkipped: 1 })
    expect(beforeCommit).toHaveBeenCalledOnce()
    expect(target.store.message('history-local-0')).toMatchObject({ text: 'current newer content', readAt: timestamp + 500 })
    expect(target.store.message('history-local-99')?.text).toBe('incoming-during-restore')
    expect(target.store.load()?.profile.displayName).toBe('target')
    expect(target.store.conversation('conversation-assistant')).toMatchObject({ title: '本机备注', muted: true })
    expect(target.store.messagePage('conversation-assistant').messages.map(message => message.id)).toEqual(['history-local-0', 'history-local-1', 'history-local-99'])
  })

  it('changes nothing on cancellation, wrong password, wrong identity or a correctly encrypted archive signed by another identity', async () => {
    const source = await context('source'), target = await context('target')
    await withAttachment(source)
    const file = path.join(root, 'history.mtchistory'); await exportHistory(source, file, password)
    const before = await fileState(target)
    expect(await restoreHistory(target, file, password, async () => false)).toBeNull()
    expect(await fileState(target)).toEqual(before)
    const confirm = vi.fn(async () => true)
    await expect(restoreHistory(target, file, 'wrong-but-long-enough-password', confirm)).rejects.toThrow(/密码|损坏/)
    expect(await fileState(target)).toEqual(before)
    const wrongIdentity = new ClientIdentity(generateKeyPairSync('ed25519').privateKey)
    await expect(restoreHistory({ ...target, identity: wrongIdentity }, file, password, confirm)).rejects.toThrow(/身份/)
    expect(await fileState(target)).toEqual(before)
    const forged = path.join(root, 'forged.mtchistory')
    await signedArchive(forged, await archiveRecords(file), wrongIdentity)
    await expect(restoreHistory(target, forged, password, confirm)).rejects.toThrow(/签名/)
    expect(await fileState(target)).toEqual(before)
    expect(confirm).not.toHaveBeenCalled()
    await expectNoWorkspace(target)
  }, 15_000)

  it('refuses missing or corrupt source attachments without leaving a finished backup or workspace', async () => {
    const source = await context('source'), { id, bytes } = await withAttachment(source)
    const file = path.join(root, 'must-not-exist.mtchistory')
    await writeFile(path.join(source.attachments.directory, id), Buffer.alloc(bytes.length, 1))
    await expect(exportHistory(source, file, password)).rejects.toThrow(/附件/)
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expectNoWorkspace(source)
    await unlink(path.join(source.attachments.directory, id))
    await expect(exportHistory(source, file, password)).rejects.toThrow()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await expectNoWorkspace(source)
  })

  it('refuses missing and corrupt archive attachments even when the outer archive and identity signature are valid', async () => {
    const source = await context('source'), target = await context('target')
    await withAttachment(source)
    const file = path.join(root, 'history.mtchistory'); await exportHistory(source, file, password)
    const before = await fileState(target), records = await archiveRecords(file)
    const missing = path.join(root, 'missing.mtchistory')
    await signedArchive(missing, records.filter(record => record.type !== 'attachment'))
    await expect(restoreHistory(target, missing, password, async () => true)).rejects.toThrow(/附件|不完整/)
    expect(await fileState(target)).toEqual(before)
    const damaged = structuredClone(records)
    const blob = damaged.find(record => record.type === 'attachment')!.value as Row
    const bytes = Buffer.from(String(blob.data), 'base64'); bytes[0] ^= 1; blob.data = bytes.toString('base64')
    const corrupt = path.join(root, 'corrupt.mtchistory'); await signedArchive(corrupt, damaged)
    await expect(restoreHistory(target, corrupt, password, async () => true)).rejects.toThrow(/附件/)
    expect(await fileState(target)).toEqual(before)
    await expectNoWorkspace(target)
  }, 15_000)

  it('refuses an existing damaged same-hash attachment without overwriting it or importing messages', async () => {
    const source = await context('source'), target = await context('target'), { id, bytes } = await withAttachment(source)
    const file = path.join(root, 'history.mtchistory'); await exportHistory(source, file, password)
    const damaged = Buffer.alloc(bytes.length, 7)
    await writeFile(path.join(target.attachments.directory, id), damaged)
    const before = await fileState(target)
    await expect(restoreHistory(target, file, password, async () => true)).rejects.toThrow(/附件/)
    expect(await fileState(target)).toEqual(before)
    expect(await readFile(path.join(target.attachments.directory, id))).toEqual(damaged)
    await expectNoWorkspace(target)
  })

  it('preflights all destination blobs before publishing any earlier attachment', async () => {
    const source = await context('source'), target = await context('target')
    const first = await source.attachments.put(Buffer.from('first blob'), 'first.txt', 'text/plain')
    const second = await source.attachments.put(Buffer.from('second blob'), 'second.txt', 'text/plain')
    saveMessages(source, [localMessage(0, { attachment: first }), localMessage(1, { attachment: second })])
    const file = path.join(root, 'history.mtchistory'); await exportHistory(source, file, password)
    await writeFile(path.join(target.attachments.directory, second.id), Buffer.alloc(second.size, 9))
    const before = await fileState(target)
    await expect(restoreHistory(target, file, password, async () => true)).rejects.toThrow(/附件/)
    expect(await fileState(target)).toEqual(before)
  })

  it('rejects existing malformed attachment metadata instead of reporting a restore with unreadable attachments', async () => {
    const source = await context('source'), target = await context('target'), { id, bytes } = await withAttachment(source)
    const file = path.join(root, 'history.mtchistory'); await exportHistory(source, file, password)
    await writeFile(path.join(target.attachments.directory, id), bytes)
    await writeFile(path.join(target.attachments.directory, id + '.json'), JSON.stringify({ id, size: bytes.length }))
    const before = await fileState(target)
    await expect(restoreHistory(target, file, password, async () => true)).rejects.toThrow(/附件|attachment/i)
    expect(await fileState(target)).toEqual(before)
    await expectNoWorkspace(target)
  })

  it('preserves finite fractional voice durations accepted by the existing attachment protocol', async () => {
    const source = await context('source'), target = await context('target')
    const voice = await source.attachments.put(Buffer.from('voice-fixture-bytes'), 'voice.webm', 'audio/webm', 1250.5)
    saveMessages(source, [localMessage(0, { attachment: voice })])
    const file = path.join(root, 'voice.mtchistory')
    await exportHistory(source, file, password)
    await restoreHistory(target, file, password, async () => true)
    expect(target.store.message('history-local-0')?.attachment).toMatchObject({ durationMs: 1250.5, mime: 'audio/webm' })
    expect(await target.attachments.read(voice.id)).toMatchObject({ durationMs: 1250.5 })
  })

  it('reports successful committed data with a cleanup warning when closing staging reports an error', async () => {
    const source = await context('source'), target = await context('target'), { id } = await withAttachment(source)
    const file = path.join(root, 'history.mtchistory'); await exportHistory(source, file, password)
    const close = ChatStore.prototype.close
    let injected = false
    const spy = vi.spyOn(ChatStore.prototype, 'close').mockImplementation(function (this: ChatStore) {
      close.call(this)
      // Actually close the temporary SQLite handle first so subsequent cleanup can still run.
      if (this !== source.store && this !== target.store && !injected) {
        injected = true
        throw new Error('injected staging cleanup failure')
      }
    })
    try {
      expect(await restoreHistory(target, file, password, async () => true)).toMatchObject({ messagesAdded: 2, attachments: 1, cleanupWarning: true })
      expect(injected).toBe(true)
      expect(target.store.message('history-local-0')?.attachment).toMatchObject({ id })
      expect(target.store.message('history-local-1')?.attachment).toMatchObject({ name: 'renamed.txt' })
      expect(await target.attachments.read(id)).toMatchObject({ id })
      await expectNoWorkspace(target)
    } finally { spy.mockRestore() }
    target.store.close(); target.store = await ChatStore.open(target.directory); stores.push(target.store)
    expect(target.store.message('history-local-0')).toBeDefined()
    expect(target.store.message('history-local-1')).toBeDefined()
  })

  it('preserves withdrawal tombstones and redacted quotes when importing old and new signed archives in either order', async () => {
    const source = await context('source'), target = await context('target'), reverse = await context('reverse')
    const serverId = 'srv_11111111-1111-1111-1111-111111111111', peer = 'usr_' + 'b'.repeat(64), remoteId = 'dm_' + 'c'.repeat(64), conversationId = serverId + ':' + remoteId
    const conversation: Conversation = { id: conversationId, title: '好友', subtitle: '中心', avatar: '友', accent: '#21855e', kind: 'direct', unread: 1, pinned: false, updatedAt: timestamp, transportId: 'builtin.central', serverId, targetId: peer, remoteId }
    const original: ChatMessage = { ...localMessage(0), id: randomUUID(), clientMessageId: randomUUID(), conversationId, serverId, senderId: peer, text: 'withdrawn-sensitive-needle' }
    const reply: ChatMessage = { ...original, id: randomUUID(), clientMessageId: randomUUID(), createdAt: timestamp + 1, text: 'answer', quote: { messageId: original.id, senderId: peer, senderName: '好友', text: original.text, attachmentName: 'private.txt' } }
    const state = source.store.load()! as unknown as ChatState
    state.conversations.push(conversation); state.messages[conversationId] = [original, reply]
    source.store.save(state, undefined, { authoritative: true })
    const older = path.join(root, 'older.mtchistory'); await exportHistory(source, older, password)
    const notice: MessageRetraction = { messageId: original.id, clientMessageId: original.clientMessageId, senderId: peer, senderName: original.senderName, createdAt: timestamp, retractedAt: timestamp + 20, conversationId: remoteId, targetKind: 'direct', targetId: identity.userId, targetName: '我' }
    source.store.save(state, undefined, { authoritative: true, retraction: { serverId, notice } })
    const newer = path.join(root, 'newer.mtchistory'); await exportHistory(source, newer, password)
    for (const [destination, sequence] of [[target, [older, newer, older]], [reverse, [newer, older]]] as const) {
      for (const file of sequence) await restoreHistory(destination, file, password, async () => true)
      expect(destination.store.message(original.id)).toMatchObject({ text: '', retractedAt: timestamp + 20 })
      expect(destination.store.message(reply.id)?.quote).toMatchObject({ text: '引用的消息已撤回', retracted: true })
      expect(destination.store.message(reply.id)?.quote).not.toHaveProperty('attachmentName')
      expect(destination.store.searchMessages('withdrawn-sensitive-needle')).toEqual([])
      expect(destination.store.retraction(serverId, original.id)).toEqual(notice)
      expect(destination.store.conversation(conversationId)).toMatchObject({ unavailable: true, unread: 0 })
      expect(destination.store.pendingReads(serverId)).toEqual([])
      expect(destination.store.outbox(serverId)).toEqual([])
    }
  }, 20_000)
})
