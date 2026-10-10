import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redactSecretFields } from './secret-redaction'
import { parseModelTokenUsage } from '@more-than-chat/protocol'

type RecordValue = Record<string, unknown>
interface Snapshot {
  version: 1
  profile: RecordValue
  activeConversationId: string
  conversations: RecordValue[]
  messages: Record<string, RecordValue[]>
}
const MAX_STATE_BYTES = 8 * 1024 * 1024

/** Main owns the connection. Each snapshot commits its projection and change log together. */
export class ChatStore {
  readonly #db: DatabaseSync
  #closed = false

  private constructor(file: string) {
    this.#db = new DatabaseSync(file)
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version)
      if (version > 1) throw new Error('Chat database belongs to a newer application version.')
      this.#db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS chat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, position INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id, position);
        CREATE TABLE IF NOT EXISTS chat_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
        PRAGMA user_version=1;
        COMMIT;
      `)
    } catch (error) { this.#db.close(); throw error }
  }

  static async open(directory: string): Promise<ChatStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = new ChatStore(path.join(directory, 'chat.sqlite'))
    try {
      if (store.load() === null) {
        const legacy = path.join(directory, 'chat-state.json')
        let raw: string | undefined
        try { raw = await readFile(legacy, 'utf8') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (raw !== undefined) {
          if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error('Legacy chat state exceeds the storage limit.')
          store.save(JSON.parse(raw) as unknown)
          // Keep the original as a recoverable migration backup, only after COMMIT.
          const backup = path.join(directory, 'chat-state.json.migrated')
          try { await copyFile(legacy, backup, constants.COPYFILE_EXCL) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            await copyFile(legacy, `${backup}.${randomUUID()}`, constants.COPYFILE_EXCL)
          }
          await unlink(legacy)
        }
      }
      return store
    } catch (error) { store.close(); throw error }
  }

  load(): Snapshot | null {
    this.#assertOpen()
    const row = this.#db.prepare("SELECT value FROM chat_meta WHERE key='state'").get()
    if (!row) return null
    const header = JSON.parse(String(row.value)) as Pick<Snapshot, 'version' | 'profile' | 'activeConversationId'>
    const conversations = this.#db.prepare('SELECT payload FROM conversations ORDER BY position').all().map(row => JSON.parse(String(row.payload)) as RecordValue)
    const messages: Snapshot['messages'] = Object.create(null) as Snapshot['messages']
    for (const conversation of conversations) messages[String(conversation.id)] = []
    for (const row of this.#db.prepare('SELECT conversation_id, payload FROM messages ORDER BY position').all()) {
      messages[String(row.conversation_id)]!.push(JSON.parse(String(row.payload)) as RecordValue)
    }
    return validateSnapshot({ ...header, conversations, messages })
  }

  save(value: unknown): void {
    this.#assertOpen()
    const snapshot = validateSnapshot(redactSecretFields(value))
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_STATE_BYTES) throw new Error('Chat state exceeds the storage limit.')
    const header = JSON.stringify({ version: 1, profile: snapshot.profile, activeConversationId: snapshot.activeConversationId })
    const previousConversations = new Map(this.#db.prepare('SELECT id, payload, position FROM conversations').all().map(row => [String(row.id), row]))
    const previousMessages = new Map(this.#db.prepare('SELECT id, payload, position FROM messages').all().map(row => [String(row.id), row]))
    const conversationIds = new Set(snapshot.conversations.map(item => String(item.id)))
    const messageIds = new Set(Object.values(snapshot.messages).flat().map(item => String(item.id)))
    const event = this.#db.prepare('INSERT INTO chat_events(kind, entity_id, payload, created_at) VALUES (?, ?, ?, ?)')
    const record = (kind: string, id: string, payload: unknown) => event.run(kind, id, JSON.stringify(payload), Date.now())
    const putConversation = this.#db.prepare('INSERT INTO conversations(id, position, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position=excluded.position, payload=excluded.payload')
    const putMessage = this.#db.prepare('INSERT INTO messages(id, conversation_id, position, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id, position=excluded.position, payload=excluded.payload')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const [id] of previousMessages) if (!messageIds.has(id)) {
        this.#db.prepare('DELETE FROM messages WHERE id=?').run(id); record('message.deleted', id, {})
      }
      for (const [id] of previousConversations) if (!conversationIds.has(id)) {
        this.#db.prepare('DELETE FROM conversations WHERE id=?').run(id); record('conversation.deleted', id, {})
      }
      snapshot.conversations.forEach((conversation, position) => {
        const id = String(conversation.id), payload = JSON.stringify(conversation), previous = previousConversations.get(id)
        if (previous?.payload === payload && previous.position === position) return
        putConversation.run(id, position, payload); record('conversation.saved', id, conversation)
      })
      for (const [conversationId, list] of Object.entries(snapshot.messages)) list.forEach((message, position) => {
        const id = String(message.id), payload = JSON.stringify(message), previous = previousMessages.get(id)
        if (previous?.payload === payload && previous.position === position) return
        putMessage.run(id, conversationId, position, payload)
        const old = previous ? JSON.parse(String(previous.payload)) as RecordValue : undefined
        // Streaming saves append only new text to the journal, avoiding quadratic copies.
        if (old && message.status === 'streaming' && typeof old.text === 'string' && String(message.text).startsWith(old.text)) {
          record('message.delta', id, { textDelta: String(message.text).slice(old.text.length), status: message.status })
        } else record('message.saved', id, message)
      })
      if (this.#db.prepare("SELECT value FROM chat_meta WHERE key='state'").get()?.value !== header) record('state.saved', 'state', JSON.parse(header))
      this.#db.prepare("INSERT INTO chat_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(header)
      // The journal is diagnostic; projections retain every current message.
      this.#db.exec('DELETE FROM chat_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-10000 FROM chat_events)')
      this.#db.exec('COMMIT')
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try { this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
    finally { this.#db.close() }
  }
  #assertOpen(): void { if (this.#closed) throw new Error('Chat store is closed.') }
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid chat snapshot.')
  return value as RecordValue
}
function stringFields(value: RecordValue, fields: string[]): void {
  if (fields.some(key => typeof value[key] !== 'string')) throw new Error('Invalid chat fields.')
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid chat id.')
  return value
}
function validateSnapshot(value: unknown): Snapshot {
  const state = object(value), profile = object(state.profile)
  stringFields(profile, ['id', 'displayName', 'avatar'])
  if (state.version !== 1 || !Array.isArray(state.conversations)) throw new Error('Unsupported chat snapshot.')
  const conversationIds = new Set<string>(), messageIds = new Set<string>()
  const conversations = state.conversations.map(value => {
    const item = object(value), key = id(item.id)
    if (conversationIds.has(key)) throw new Error('Duplicate conversation id.')
    conversationIds.add(key)
    stringFields(item, ['title', 'subtitle', 'avatar', 'accent', 'transportId'])
    if (!['direct', 'group', 'assistant'].includes(String(item.kind)) || typeof item.pinned !== 'boolean' || !Number.isFinite(item.updatedAt) || !Number.isSafeInteger(item.unread)) throw new Error('Invalid conversation.')
    return item
  })
  const activeConversationId = id(state.activeConversationId)
  if (!conversationIds.has(activeConversationId)) throw new Error('Active conversation does not exist.')
  const source = object(state.messages), messages: Snapshot['messages'] = Object.create(null) as Snapshot['messages']
  for (const [key, value] of Object.entries(source)) {
    if (!conversationIds.has(key) || !Array.isArray(value)) throw new Error('Invalid message conversation.')
    messages[key] = value.map(value => {
      const item = object(value), keyId = id(item.id)
      if (messageIds.has(keyId) || item.conversationId !== key) throw new Error('Invalid message identity.')
      messageIds.add(keyId)
      stringFields(item, ['clientMessageId', 'senderId', 'senderName', 'senderAvatar', 'text'])
      if (!['self', 'peer', 'system'].includes(String(item.role)) || !['text', 'system'].includes(String(item.type)) || !['sending', 'sent', 'failed', 'streaming', 'cancelled'].includes(String(item.status)) || !Number.isFinite(item.createdAt)) throw new Error('Invalid message.')
      if (item.authorNotes !== undefined && !Array.isArray(item.authorNotes)) throw new Error('Invalid author notes.')
      if (Array.isArray(item.authorNotes)) for (const noteValue of item.authorNotes) {
        const note = object(noteValue)
        if (!['started', 'finished'].includes(String(note.phase)) || !['inspect_drafts', 'create_draft', 'validate_draft', 'diagnose_draft', 'install_draft', 'unknown'].includes(String(note.tool)) || typeof note.summary !== 'string' || typeof note.ok !== 'boolean' || typeof note.pendingInstall !== 'boolean') throw new Error('Invalid author note.')
        if (note.draft !== null) {
          const draft = object(note.draft)
          stringFields(draft, ['id', 'displayName'])
          if (!Number.isSafeInteger(draft.revision) || Number(draft.revision) < 0 || typeof draft.ok !== 'boolean') throw new Error('Invalid author draft.')
        }
      }
      if (item.usage !== undefined) item.usage = parseModelTokenUsage(item.usage)
      for (const field of ['replyToId', 'retryOfId', 'supersededById']) if (item[field] !== undefined) id(item[field])
      if (item.errorMessage !== undefined && typeof item.errorMessage !== 'string') throw new Error('Invalid message error.')
      return item
    })
  }
  for (const key of conversationIds) messages[key] ??= []
  return { version: 1, profile, activeConversationId, conversations, messages }
}
