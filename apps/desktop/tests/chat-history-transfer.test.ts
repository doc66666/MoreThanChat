import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createSeedState, type ChatMessage, type Conversation } from '@more-than-chat/chat-core'
import type { MessageRetraction } from '@more-than-chat/central-protocol'
import { ChatStore, type HistoryRecord } from '../src/main/chat-store'

const folders: string[] = [], stores: ChatStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function folder() { const dir = await mkdtemp(path.join(tmpdir(), 'mtc-history-transfer-')); folders.push(dir); return dir }
async function open(staging = false, directory?: string) { const store = await ChatStore.open(directory ?? await folder(), { historyStaging: staging }); stores.push(store); return store }
const serverId = 'srv_' + '1'.repeat(8) + '-1111-1111-1111-' + '1'.repeat(12), self = 'usr_' + 'a'.repeat(64), peer = 'usr_' + 'b'.repeat(64), remoteId = 'dm_' + 'c'.repeat(64), conversationId = serverId + ':' + remoteId
function networkConversation(): Conversation { return { id: conversationId, title: '好友', subtitle: '中心服务器 · 好友', avatar: '友', accent: '#21855e', kind: 'direct', unread: 1, pinned: true, muted: true, updatedAt: 100, transportId: 'builtin.central', serverId, targetId: peer, remoteId, unavailable: false } }
function message(extra: Partial<ChatMessage> = {}): ChatMessage { return { id: randomUUID(), clientMessageId: randomUUID(), conversationId, senderId: peer, senderName: '好友', senderAvatar: '友', role: 'peer', type: 'text', text: '历史内容', createdAt: 100, status: 'sent', serverId, ...extra } }
function state(messages: ChatMessage[], conversation = networkConversation()) { const value = createSeedState(10); value.conversations.push(conversation); value.messages[conversation.id] = messages; value.profile.id = self; return value }
function notice(original: ChatMessage): MessageRetraction { return { messageId: original.id, clientMessageId: original.clientMessageId, senderId: original.senderId, senderName: original.senderName, createdAt: original.createdAt, retractedAt: 150, conversationId: remoteId, targetKind: 'direct', targetId: self, targetName: '我' } }
async function stage(records: Iterable<HistoryRecord>) { const store = await open(true); for (const record of records) store.stageHistoryRecord(record); return store }
async function snapshot(store: ChatStore) { return store.createHistorySnapshot(path.join(await folder(), 'history.sqlite')) }
async function cloneStage(store: ChatStore) { const view = await snapshot(store); try { return await stage(view.records()) } finally { view.close() } }

describe('history snapshot and conservative merge', () => {
  it('exports every page beyond 8 MiB with a repeatable consistent snapshot and refuses overwrite', async () => {
    const source = await open(), initial = createSeedState(10), id = initial.activeConversationId, template = initial.messages[id]![0]!
    initial.messages[id] = Array.from({ length: 1400 }, (_, i) => ({ ...template, id: 'large-' + i, clientMessageId: 'large-' + i, text: 'complete-history-' + i + 'x'.repeat(6500), createdAt: i + 10 }))
    source.save(initial)
    const view = await snapshot(source)
    try {
      const records = [...view.records()]
      expect(Buffer.byteLength(JSON.stringify(records))).toBeGreaterThan(8 * 1024 * 1024)
      expect(records.filter(r => r.type === 'message')).toHaveLength(1400)
      initial.messages[id]!.push({ ...template, id: 'new-after-snapshot', clientMessageId: 'new-after-snapshot', createdAt: 9000 })
      source.save(initial)
      expect([...view.records()]).toEqual(records)
      const destination = await open(), header = createSeedState(5); destination.save(header)
      const staged = await stage(records), result = destination.mergeHistory(staged)
      expect(result.messagesAdded).toBe(1400)
      expect(destination.message('large-0')?.text).toContain('complete-history-0')
      expect(destination.messagePage(id).messages).toHaveLength(50)
      expect(destination.message('new-after-snapshot')).toBeUndefined()
      expect(destination.load()?.profile).toEqual(header.profile)
      expect(destination.mergeHistory(staged)).toMatchObject({ messagesAdded: 0, messagesSkipped: 1400 })
    } finally { view.close() }
    const target = path.join(await folder(), 'existing.sqlite'); await writeFile(target, 'keep-me')
    await expect(source.createHistorySnapshot(target)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('keep-me')
  }, 30000)

  it('preserves local content/options/header and queues; imports older history as read-only, read and interrupted', async () => {
    const old = message({ text: 'old body', createdAt: 50 }), queued = message({ senderId: self, role: 'self', status: 'queued', createdAt: 60 }), source = await open()
    source.save(state([old, queued]), { serverId, directory: { friends: ['must-not-import'] } }, { authoritative: true, outboxPut: { serverId, clientMessageId: queued.clientMessageId, conversationId, createdAt: 60 }, readMessages: [{ serverId, messageId: old.id }] })
    const staging = await cloneStage(source), destination = await open(), initial = createSeedState(5); destination.save(initial)
    expect(destination.mergeHistory(staging)).toMatchObject({ conversationsAdded: 1, messagesAdded: 3 })
    expect(destination.conversation(conversationId)).toMatchObject({ unavailable: true, unread: 0 })
    expect(destination.message(old.id)?.readAt).toBeGreaterThan(0)
    expect(destination.message(queued.id)?.status).toBe('failed')
    expect(destination.outbox(serverId)).toEqual([]); expect(destination.pendingReads(serverId)).toEqual([])
    const existing = state([{ ...old, text: 'local newer edit', status: 'sent' }, { ...queued, status: 'sent', receipt: { recipientCount: 1, deliveredCount: 1, readCount: 1 } }])
    existing.conversations[1]!.title = '我的备注'; existing.conversations[1]!.muted = false
    destination.save(existing, { serverId, directory: { friends: ['local'] } }, { authoritative: true, outboxPut: { serverId, clientMessageId: 'untouched', conversationId, createdAt: 1 }, readMessages: [{ serverId, messageId: 'unrelated' }] })
    const before = destination.load()!
    destination.mergeHistory(staging)
    expect(destination.message(old.id)?.text).toBe('local newer edit')
    expect(destination.message(queued.id)?.receipt).toEqual({ recipientCount: 1, deliveredCount: 1, readCount: 1 })
    expect(destination.conversation(conversationId)).toEqual(before.conversations.find(c => c.id === conversationId))
    expect(destination.load()?.profile).toEqual(before.profile); expect(destination.load()?.activeConversationId).toBe(before.activeConversationId)
    expect(destination.outbox(serverId).map(x => x.clientMessageId)).toEqual(['untouched'])
    expect(destination.pendingReads(serverId)).toEqual(['unrelated'])
  })

  it('keeps canonical messages by sender/client and sorts old imported messages before recent local history', async () => {
    const source = await open(), destination = await open(), older = message({ createdAt: 10 }), canonical = message({ createdAt: 90, text: 'canonical' }), queuedCopy = { ...canonical, id: 'pending-' + randomUUID(), status: 'queued' as const, text: 'stale' }
    source.save(state([older, queuedCopy]), undefined, { authoritative: true })
    destination.save(state([canonical]), undefined, { authoritative: true })
    expect(destination.mergeHistory(await cloneStage(source))).toMatchObject({ messagesAdded: 1, messagesSkipped: 2 })
    expect(destination.message(queuedCopy.id)).toBeUndefined()
    expect(destination.message(canonical.id)?.text).toBe('canonical')
    expect(destination.messagePage(conversationId).messages.map(m => m.id)).toEqual([older.id, canonical.id])
  })

  it('applies tombstones to existing originals, quotes and FTS and prevents old archives resurrecting them', async () => {
    const original = message({ text: 'unique-sensitive-original' }), quoted = message({ createdAt: 110, text: 'answer', quote: { messageId: original.id, senderId: peer, senderName: '好友', text: original.text, attachmentName: 'secret.txt' } })
    const source = await open(), destination = await open(); source.save(state([original, quoted]), undefined, { authoritative: true }); destination.save(state([original, quoted]), undefined, { authoritative: true })
    const stale = await cloneStage(source), retracted = notice(original)
    source.save(state([original, quoted]), undefined, { authoritative: true, retraction: { serverId, notice: retracted } })
    expect(destination.mergeHistory(await cloneStage(source))).toMatchObject({ retractionsApplied: 1 })
    destination.mergeHistory(stale)
    expect(destination.message(original.id)).toMatchObject({ text: '', retractedAt: 150 })
    expect(destination.message(quoted.id)?.quote).toEqual({ messageId: original.id, senderId: peer, senderName: '好友', text: '引用的消息已撤回', retracted: true })
    expect(destination.searchMessages('unique-sensitive-original')).toEqual([])
    const lateQuote = { ...quoted, id: randomUUID(), clientMessageId: randomUUID() }, extra = await stage([{ type: 'conversation', value: networkConversation() as unknown as Record<string, unknown> }, { type: 'message', value: lateQuote as unknown as Record<string, unknown> }])
    destination.mergeHistory(extra)
    expect((destination.message(lateQuote.id)?.quote as { retracted: boolean }).retracted).toBe(true)
    expect(destination.searchMessages('unique-sensitive-original')).toEqual([])
  })

  it('rejects cross-server, cross-conversation and conflicting retraction identities atomically', async () => {
    const destination = await open(), original = message(); destination.save(state([original]), undefined, { authoritative: true })
    const before = destination.load()
    const conflicting = { ...original, senderId: self, role: 'self' as const }, staged = await stage([{ type: 'conversation', value: networkConversation() as unknown as Record<string, unknown> }, { type: 'message', value: conflicting as unknown as Record<string, unknown> }])
    expect(() => destination.mergeHistory(staged)).toThrow('identity conflict'); expect(destination.load()).toEqual(before)
    const wrongNotice = { ...notice(original), senderId: self }, retractions = await stage([{ type: 'conversation', value: networkConversation() as unknown as Record<string, unknown> }, { type: 'retraction', serverId, value: wrongNotice }])
    expect(() => destination.mergeHistory(retractions)).toThrow('identity conflict'); expect(destination.load()).toEqual(before)
    const crossServer = { ...networkConversation(), serverId: 'another', id: 'another:' + remoteId }, cross = await stage([{ type: 'conversation', value: crossServer as unknown as Record<string, unknown> }, { type: 'message', value: { ...original, serverId: 'another', conversationId: crossServer.id } }])
    expect(() => destination.mergeHistory(cross)).toThrow('identity conflict'); expect(destination.conversation(crossServer.id)).toBeUndefined(); expect(destination.load()).toEqual(before)
  })

  it('rejects cross-server reuse of tombstone-only IDs during staging in either record order', async () => {
    const original = message(), otherServer = 'srv-other', otherConversation = { ...networkConversation(), serverId: otherServer, id: otherServer + ':' + remoteId }
    const conversations: HistoryRecord[] = [{ type: 'conversation', value: networkConversation() as unknown as Record<string, unknown> }, { type: 'conversation', value: otherConversation }]
    const tombstone: HistoryRecord = { type: 'retraction', serverId, value: notice(original) }
    const otherMessage: HistoryRecord = { type: 'message', value: { ...original, serverId: otherServer, conversationId: otherConversation.id } }
    const tombstoneFirst = await stage([...conversations, tombstone])
    expect(() => tombstoneFirst.stageHistoryRecord(otherMessage)).toThrow('identity conflict')
    expect(() => tombstoneFirst.stageHistoryRecord({ ...tombstone, serverId: otherServer })).toThrow('identity conflict')
    const messageFirst = await stage([...conversations, otherMessage])
    expect(() => messageFirst.stageHistoryRecord(tombstone)).toThrow('identity conflict')
  })

  it('rolls back message/tombstone imports conflicting with another server tombstone-only identity', async () => {
    const original = message(), destination = await open(), originalTombstone = await stage([{ type: 'conversation', value: networkConversation() as unknown as Record<string, unknown> }, { type: 'retraction', serverId, value: notice(original) }])
    destination.save(createSeedState(5)); destination.mergeHistory(originalTombstone)
    expect(destination.message(original.id)).toBeUndefined()
    const before = destination.load(), otherServer = 'srv-other', otherConversation = { ...networkConversation(), serverId: otherServer, id: otherServer + ':' + remoteId }
    const conversation: HistoryRecord = { type: 'conversation', value: otherConversation }
    const conflictingMessage = await stage([conversation, { type: 'message', value: { ...original, serverId: otherServer, conversationId: otherConversation.id } }])
    expect(() => destination.mergeHistory(conflictingMessage)).toThrow('identity conflict')
    expect(destination.load()).toEqual(before); expect(destination.conversation(otherConversation.id)).toBeUndefined()
    const conflictingTombstone = await stage([conversation, { type: 'retraction', serverId: otherServer, value: notice(original) }])
    expect(() => destination.mergeHistory(conflictingTombstone)).toThrow('identity conflict')
    expect(destination.load()).toEqual(before); expect(destination.retraction(otherServer, original.id)).toBeUndefined()
    expect(destination.retraction(serverId, original.id)).toEqual(notice(original))
    // The inverse direction (incoming tombstone versus an existing other-server body) also rolls back.
    const bodyDestination = await open(); bodyDestination.save(state([original]), undefined, { authoritative: true })
    const bodyBefore = bodyDestination.load()
    expect(() => bodyDestination.mergeHistory(conflictingTombstone)).toThrow('identity conflict')
    expect(bodyDestination.load()).toEqual(bodyBefore)
  })

  it('rolls back partial inserts, position edits, tombstones and FTS on a database failure', async () => {
    const directory = await folder(), destination = await open(false, directory), seed = createSeedState(5); destination.save(seed)
    const incoming = message(), staging = await stage([{ type: 'conversation', value: networkConversation() as unknown as Record<string, unknown> }, { type: 'message', value: incoming as unknown as Record<string, unknown> }])
    const db = new DatabaseSync(path.join(directory, 'chat.sqlite'))
    try {
      db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected history failure'); END")
      expect(() => destination.mergeHistory(staging)).toThrow('injected history failure')
      expect(destination.conversation(conversationId)).toBeUndefined(); expect(destination.load()).toEqual(seed)
      expect(destination.searchMessages('历史内容')).toEqual([])
      db.exec('DROP TRIGGER fail_history')
      expect(destination.mergeHistory(staging).messagesAdded).toBe(1)
    } finally { db.close() }
  })

  it('validates single-row limits, namespaces and unsafe keys, strips unknown fields, and restricts staging', async () => {
    const directory = await folder(), staging = await open(true, directory), normal = await open()
    await expect(ChatStore.open(directory, { historyStaging: true })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(() => normal.stageHistoryRecord({ type: 'conversation', value: networkConversation() })).toThrow('staging')
    expect(() => staging.stageHistoryRecord({ type: 'conversation', value: { ...networkConversation(), id: 'wrong-scope' } })).toThrow('namespace')
    expect(() => staging.stageHistoryRecord(JSON.parse('{"type":"conversation","__proto__":{},"value":{}}'))).toThrow('Unsafe')
    staging.stageHistoryRecord({ type: 'conversation', value: { ...networkConversation(), apiKey: 'must-strip', plugin: { code: 'must-strip' } } })
    const original = message({ text: 'x'.repeat(8 * 1024 * 1024) })
    expect(() => staging.stageHistoryRecord({ type: 'message', value: original })).toThrow('per-record')
    expect(() => staging.stageHistoryRecord({ type: 'message', value: { ...original, text: 'small', serverId: 'other' } })).toThrow('server')
    expect(() => staging.stageHistoryRecord({ type: 'message', value: { ...original, text: 'small', attachment: { id: 'a'.repeat(64), name: 'a', mime: 'text/plain', size: 1, durationMs: Infinity } } })).toThrow('attachment')
    staging.stageHistoryRecord({ type: 'message', value: { ...original, text: 'small', unknown: 'must-strip' } })
    expect(staging.conversation(conversationId)?.apiKey).toBeUndefined(); expect(staging.message(original.id)?.unknown).toBeUndefined()
    expect(() => staging.stageHistoryRecord({ type: 'message', value: { ...original, text: 'duplicate' } })).toThrow('Duplicate')
    expect(() => normal.mergeHistory(normal)).toThrow('staging')
  })

  it('reports unfinished local turns across all pages and cancels imported local in-flight states', async () => {
    const source = await open(), destination = await open(), value = createSeedState(10), id = value.activeConversationId, template = value.messages[id]![0]!
    value.messages[id] = [{ ...template, id: 'streaming-history', clientMessageId: 'streaming-history', status: 'streaming' }, { ...template, id: 'sending-history', clientMessageId: 'sending-history', status: 'sending' }]
    source.save(value); destination.save(createSeedState(5))
    expect(source.hasActiveLocalTurns()).toBe(true)
    destination.mergeHistory(await cloneStage(source))
    expect(destination.message('streaming-history')?.status).toBe('cancelled'); expect(destination.message('sending-history')?.status).toBe('failed')
    expect(destination.hasActiveLocalTurns()).toBe(false)
  })
})
