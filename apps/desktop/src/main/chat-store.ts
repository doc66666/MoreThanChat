import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redactSecretFields } from './secret-redaction'
import { parseModelTokenUsage } from '@more-than-chat/protocol'
import { parseMessageReference, parseMessageRetraction, type MessageRetraction } from '@more-than-chat/central-protocol'

type RecordValue = Record<string, unknown>
interface Snapshot {
  version: 1
  profile: RecordValue
  activeConversationId: string
  conversations: RecordValue[]
  messages: Record<string, RecordValue[]>
}
// This is a per-record safety limit, not a limit on a user's entire history.
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const PAGE_BYTES = 512 * 1024
export interface MessagePage {
  messages: RecordValue[]
  before: number | null
  after: number | null
  hasOlder: boolean
  hasNewer: boolean
}
export interface OutboxEntry { serverId: string; clientMessageId: string; conversationId: string; createdAt: number }
interface MainCommit {
  authoritative?: boolean
  outboxPut?: OutboxEntry
  outboxRemove?: string | string[]
  readMessages?: { serverId: string; messageId: string }[]
  retraction?: {serverId:string;notice:MessageRetraction}
}

/** Main owns SQLite. Bounded projections are upserts, never implicit history deletions. */
export class ChatStore {
  readonly #db: DatabaseSync
  #closed = false

  private constructor(file: string) {
    this.#db = new DatabaseSync(file)
    try {
      this.#db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
      )
      const version = Number(
        this.#db.prepare('PRAGMA user_version').get()?.user_version,
      )
      if (version > 5)
        throw new Error('Chat database belongs to a newer application version.')
      this.#db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS chat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, position INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id, position);
        CREATE INDEX IF NOT EXISTS message_client ON messages(conversation_id,json_extract(payload,'$.senderId'),json_extract(payload,'$.clientMessageId'));
        CREATE INDEX IF NOT EXISTS message_sender_client ON messages(json_extract(payload,'$.serverId'),json_extract(payload,'$.senderId'),json_extract(payload,'$.clientMessageId'));
        CREATE INDEX IF NOT EXISTS message_quote ON messages(json_extract(payload,'$.serverId'),json_extract(payload,'$.quote.messageId'));
        CREATE TABLE IF NOT EXISTS message_retractions(server_id TEXT NOT NULL,message_id TEXT NOT NULL,sender_id TEXT NOT NULL,client_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(server_id,message_id));
        CREATE INDEX IF NOT EXISTS retraction_client ON message_retractions(server_id,sender_id,client_id);
        CREATE INDEX IF NOT EXISTS message_unread ON messages(conversation_id,position) WHERE json_extract(payload,'$.role')='peer' AND json_extract(payload,'$.status')='sent' AND json_extract(payload,'$.readAt') IS NULL;
        CREATE INDEX IF NOT EXISTS message_interrupted ON messages(json_extract(payload,'$.status')) WHERE json_extract(payload,'$.serverId') IS NULL AND json_extract(payload,'$.status') IN ('streaming','sending');
        CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text,content='',tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON messages BEGIN INSERT INTO message_search(rowid,text) VALUES(new.rowid,json_extract(new.payload,'$.text')); END;
        CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN INSERT INTO message_search(message_search,rowid,text) VALUES('delete',old.rowid,json_extract(old.payload,'$.text')); END;
        CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE OF payload ON messages WHEN json_extract(old.payload,'$.text') IS NOT json_extract(new.payload,'$.text') BEGIN INSERT INTO message_search(message_search,rowid,text) VALUES('delete',old.rowid,json_extract(old.payload,'$.text')); INSERT INTO message_search(rowid,text) VALUES(new.rowid,json_extract(new.payload,'$.text')); END;
        CREATE TABLE IF NOT EXISTS chat_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS central_state (server_id TEXT PRIMARY KEY, directory TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS server_origins (server_id TEXT PRIMARY KEY,address TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plugin_inbox (server_id TEXT NOT NULL,id TEXT NOT NULL,group_id TEXT NOT NULL,plugin_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(server_id,id));
        CREATE TABLE IF NOT EXISTS central_outbox (client_id TEXT PRIMARY KEY, server_id TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS central_outbox_server_time ON central_outbox(server_id,created_at);
        CREATE TABLE IF NOT EXISTS read_outbox (server_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(server_id,message_id));
        ${version<4?"INSERT INTO message_search(rowid,text) SELECT rowid,json_extract(payload,'$.text') FROM messages;":''}
        UPDATE conversations SET payload=json_remove(payload,'$.archived') WHERE json_type(payload,'$.archived') IS NOT NULL;
        PRAGMA user_version=5;
        COMMIT;
      `)
    } catch (error) {
      this.#db.close()
      throw error
    }
  }

  static async open(directory: string): Promise<ChatStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = new ChatStore(path.join(directory, 'chat.sqlite'))
    try {
      if (!store.#db.prepare("SELECT 1 FROM chat_meta WHERE key='state'").get()) {
        const legacy = path.join(directory, 'chat-state.json')
        let raw: string | undefined
        try {
          raw = await readFile(legacy, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (raw !== undefined) {
          store.save(JSON.parse(raw) as unknown,undefined,{authoritative:true})
          // Keep the original as a recoverable migration backup, only after COMMIT.
          const backup = path.join(directory, 'chat-state.json.migrated')
          try {
            await copyFile(legacy, backup, constants.COPYFILE_EXCL)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            await copyFile(
              legacy,
              `${backup}.${randomUUID()}`,
              constants.COPYFILE_EXCL,
            )
          }
          await unlink(legacy)
        }
      }
      // Recover interrupted local/AI turns even if they fall outside the first page.
      // Network queued messages are never converted to failures on restart.
      store.#db.exec("UPDATE messages SET payload=json_set(payload,'$.status',CASE json_extract(payload,'$.status') WHEN 'streaming' THEN 'cancelled' ELSE 'failed' END) WHERE json_extract(payload,'$.serverId') IS NULL AND json_extract(payload,'$.status') IN ('streaming','sending')")
      return store
    } catch (error) {
      store.close()
      throw error
    }
  }

  load(): Snapshot | null {
    return this.#loadProjection(false)
  }

  loadView(): (Snapshot & { history: Record<string, Omit<MessagePage, 'messages'>> }) | null {
    return this.#loadProjection(true) as ReturnType<ChatStore['loadView']>
  }

  #loadProjection(withHistory: boolean): (Snapshot & { history?: Record<string, Omit<MessagePage, 'messages'>> }) | null {
    this.#assertOpen()
    const row = this.#db
      .prepare("SELECT value FROM chat_meta WHERE key='state'")
      .get()
    if (!row) return null
    const header = JSON.parse(String(row.value)) as Pick<
      Snapshot,
      'version' | 'profile' | 'activeConversationId'
    >
    const conversations = this.#db
      .prepare('SELECT payload FROM conversations ORDER BY position')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as RecordValue)
    const messages: Snapshot['messages'] = Object.create(
      null,
    ) as Snapshot['messages']
    const history: Record<string, Omit<MessagePage, 'messages'>> = Object.create(null)
    for (const conversation of conversations) {
      const page = this.messagePage(String(conversation.id))
      messages[String(conversation.id)] = page.messages
      const { messages: _messages, ...cursor } = page
      history[String(conversation.id)] = cursor
    }
    const state=validateSnapshot({ ...header,conversations,messages })
    return withHistory ? { ...state, history } : state
  }

  message(id: string): RecordValue | undefined {
    const row = this.#db.prepare('SELECT payload FROM messages WHERE id=?').get(id)
    return row ? JSON.parse(String(row.payload)) as RecordValue : undefined
  }

  messageByClient(serverId: string, senderId: string, clientId: string): RecordValue | undefined {
    const row = this.#db.prepare("SELECT payload FROM messages WHERE json_extract(payload,'$.serverId')=? AND json_extract(payload,'$.senderId')=? AND json_extract(payload,'$.clientMessageId')=?").get(serverId,senderId,clientId)
    return row ? JSON.parse(String(row.payload)) as RecordValue : undefined
  }
  retraction(serverId:string,messageId:string,senderId?:string,clientId?:string):MessageRetraction|undefined {
    const row=this.#db.prepare('SELECT payload FROM message_retractions WHERE server_id=? AND message_id=?').get(serverId,messageId) ?? (senderId&&clientId?this.#db.prepare('SELECT payload FROM message_retractions WHERE server_id=? AND sender_id=? AND client_id=?').get(serverId,senderId,clientId):undefined)
    return row?parseMessageRetraction(JSON.parse(String(row.payload))):undefined
  }

  messagePage(conversationId: string, input: { before?: number; after?: number; around?: string; limit?: number } = {}): MessagePage {
    this.#assertOpen()
    id(conversationId)
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      [input.before,input.after].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<0)) ||
      [input.before,input.after,input.around].filter(v=>v!==undefined).length>1) throw new Error('Invalid history cursor.')
    type Row = { position: number; payload: string }
    let rows: Row[]
    if (input.around !== undefined) {
      const target=this.#db.prepare('SELECT position FROM messages WHERE conversation_id=? AND id=?').get(conversationId,id(input.around))
      if(!target)throw new Error('消息不存在')
      const newer=this.#db.prepare('SELECT position,payload FROM messages WHERE conversation_id=? AND position>=? ORDER BY position LIMIT ?').all(conversationId,Number(target.position),Math.ceil(limit/2)) as unknown as Row[]
      const older=this.#db.prepare('SELECT position,payload FROM messages WHERE conversation_id=? AND position<? ORDER BY position DESC LIMIT ?').all(conversationId,Number(target.position),Math.floor(limit/2)) as unknown as Row[]
      // Prefer the target and its closest neighbours within the page byte budget.
      rows=[];let bytes=0
      neighbourhood: for(let i=0;i<Math.max(newer.length,older.length);i++)for(const candidate of [newer[i],older[i]]) {
        if(!candidate)continue
        const size=Buffer.byteLength(candidate.payload)
        if(rows.length&&bytes+size>PAGE_BYTES)break neighbourhood
        rows.push(candidate);bytes+=size
      }
    } else {
      const forward=input.after!==undefined
      rows=this.#db.prepare(`SELECT position,payload FROM messages WHERE conversation_id=? ${input.before!==undefined?'AND position<?':forward?'AND position>?':''} ORDER BY position ${forward?'ASC':'DESC'} LIMIT ?`).all(...(input.before!==undefined||forward?[conversationId,input.before??input.after!,limit]:[conversationId,limit])) as unknown as Row[]
      let bytes=0,count=0
      for(const row of rows){const size=Buffer.byteLength(row.payload);if(count&&bytes+size>PAGE_BYTES)break;bytes+=size;count++}
      rows=rows.slice(0,count)
    }
    rows.sort((a,b)=>a.position-b.position)
    const before=rows[0]?.position??null,after=rows.at(-1)?.position??null
    return { messages:rows.map(row=>JSON.parse(row.payload) as RecordValue),before,after,
      hasOlder:before!==null&&Boolean(this.#db.prepare('SELECT 1 FROM messages WHERE conversation_id=? AND position<? LIMIT 1').get(conversationId,before)),
      hasNewer:after!==null&&Boolean(this.#db.prepare('SELECT 1 FROM messages WHERE conversation_id=? AND position>? LIMIT 1').get(conversationId,after)) }
  }

  save(
    value: unknown,
    serverDirectory?: { serverId: string; directory: unknown },
    commit: MainCommit = {},
  ): void {
    this.#assertOpen()
    const snapshot = validateSnapshot(redactSecretFields(value,false))
    const header = JSON.stringify({
      version: 1,
      profile: snapshot.profile,
      activeConversationId: snapshot.activeConversationId,
    })
    const previousConversations = new Map(
      this.#db
        .prepare('SELECT id, payload, position FROM conversations')
        .all()
        .map((row) => [String(row.id), row]),
    )
    const event = this.#db.prepare(
      'INSERT INTO chat_events(kind, entity_id, payload, created_at) VALUES (?, ?, ?, ?)',
    )
    const record = (kind: string, id: string, payload: unknown) =>
      event.run(kind, id, JSON.stringify(redactSecretFields(payload)), Date.now())
    const putConversation = this.#db.prepare(
      'INSERT INTO conversations(id, position, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position=excluded.position, payload=excluded.payload',
    )
    const putMessage = this.#db.prepare('INSERT INTO messages(id, conversation_id, position, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
    const byId = this.#db.prepare('SELECT id,conversation_id,position,payload FROM messages WHERE id=?')
    const byClient = this.#db.prepare("SELECT id,conversation_id,position,payload FROM messages WHERE conversation_id=? AND json_extract(payload,'$.senderId')=? AND json_extract(payload,'$.clientMessageId')=?")
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      // Missing rows in a paged renderer view are not deletions. Membership removal
      // is represented explicitly by Main's unavailable flag, preserving history.
      let nextConversationPosition=Number(this.#db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM conversations').get()!.n)
      snapshot.conversations.forEach((conversation) => {
        const id = String(conversation.id),
          previous = previousConversations.get(id)
        if(previous&&!commit.authoritative){
          const saved=JSON.parse(String(previous.payload)) as RecordValue
          if(saved.serverId)Object.assign(conversation,saved)
          else for(const field of ['pinned','muted'])conversation[field]=saved[field]
        }
        delete conversation.archived
        const payload=JSON.stringify(conversation),position=previous?Number(previous.position):nextConversationPosition++
        if (previous?.payload === payload && previous.position === position)
          return
        putConversation.run(id, position, payload)
        record('conversation.saved', id, conversation)
      })
      for (const [conversationId, list] of Object.entries(snapshot.messages)) {
        let nextPosition=Number(this.#db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM messages WHERE conversation_id=?').get(conversationId)!.n)
        for (const message of list) {
          const tombstone=typeof message.serverId==='string'?this.retraction(message.serverId,String(message.id),String(message.senderId),String(message.clientMessageId)):undefined
          if(tombstone)redactRetractedMessage(message,tombstone)
          if(message.quote&&typeof message.serverId==='string'){
            const quote=message.quote as RecordValue
            if(this.retraction(message.serverId,String(quote.messageId))){message.quote={...quote,text:'引用的消息已撤回',retracted:true};delete (message.quote as RecordValue).attachmentName}
          }
          const id = String(message.id)
          const previous=byId.get(id)??byClient.get(conversationId,String(message.senderId),String(message.clientMessageId))
          if(previous&&previous.conversation_id!==conversationId)throw new Error('Message belongs to another conversation.')
          const old = previous ? JSON.parse(String(previous.payload)) as RecordValue : undefined
          // Main owns all network message contents and delivery/read state.
          if(old?.serverId&&!commit.authoritative)continue
          if(message.serverId&&!commit.authoritative)continue
          const payload=JSON.stringify(message)
          if(Buffer.byteLength(payload)>MAX_RECORD_BYTES)throw new Error('Message exceeds the per-record storage limit.')
          if(previous?.payload===payload)continue
          const position=previous?Number(previous.position):nextPosition++
          if(previous&&previous.id!==id)this.#db.prepare('DELETE FROM messages WHERE id=?').run(String(previous.id))
          putMessage.run(id, conversationId, position, payload)
          // Streaming saves append only new text to the journal, avoiding quadratic copies.
          if (
            old &&
            message.status === 'streaming' &&
            typeof old.text === 'string' &&
            String(message.text).startsWith(old.text)
          ) {
            record('message.delta', id, {
              textDelta: String(message.text).slice(old.text.length),
              status: message.status,
            })
          } else record('message.saved', id, message)
        }
      }
      if (
        this.#db.prepare("SELECT value FROM chat_meta WHERE key='state'").get()
          ?.value !== header
      )
        record('state.saved', 'state', JSON.parse(header))
      this.#db
        .prepare(
          "INSERT INTO chat_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(header)
      // The journal is diagnostic; projections retain every current message.
      this.#db.exec(
        'DELETE FROM chat_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-10000 FROM chat_events)',
      )
      if (serverDirectory)
        this.#db
          .prepare('INSERT OR REPLACE INTO central_state VALUES (?,?)')
          .run(
            serverDirectory.serverId,
            JSON.stringify(serverDirectory.directory),
          )
      if (commit.outboxPut) {
        const row = commit.outboxPut
        if(!this.#db.prepare("SELECT 1 FROM messages WHERE json_extract(payload,'$.serverId')=? AND json_extract(payload,'$.clientMessageId')=? AND json_extract(payload,'$.role')='self' AND json_extract(payload,'$.retractedAt') IS NOT NULL").get(row.serverId,row.clientMessageId))this.#db.prepare('INSERT OR IGNORE INTO central_outbox VALUES (?,?,?,?)').run(row.clientMessageId,row.serverId,row.conversationId,row.createdAt)
      }
      for (const id of typeof commit.outboxRemove==='string' ? [commit.outboxRemove] : commit.outboxRemove ?? []) this.#db.prepare('DELETE FROM central_outbox WHERE client_id=?').run(id)
      for (const row of commit.readMessages ?? [])if(!this.retraction(row.serverId,row.messageId))this.#db.prepare('INSERT OR IGNORE INTO read_outbox VALUES (?,?)').run(row.serverId,row.messageId)
      if(commit.retraction){
        const {serverId,notice:raw}=commit.retraction,notice=parseMessageRetraction(raw)
        this.#db.prepare('INSERT OR IGNORE INTO message_retractions VALUES (?,?,?,?,?)').run(serverId,notice.messageId,notice.senderId,notice.clientMessageId,JSON.stringify(notice))
        const original=this.message(notice.messageId)??this.messageByClient(serverId,notice.senderId,notice.clientMessageId)
        if(original&&original.serverId===serverId){
          if(original.senderId!==notice.senderId)throw new Error('Retraction sender does not match message.')
          const oldId=String(original.id);redactRetractedMessage(original,notice)
          this.#db.prepare('UPDATE messages SET id=?,payload=? WHERE id=?').run(notice.messageId,JSON.stringify(original),oldId)
          if(original.role==='self')this.#db.prepare('DELETE FROM central_outbox WHERE server_id=? AND client_id=?').run(serverId,notice.clientMessageId)
        }
        this.#db.prepare('DELETE FROM read_outbox WHERE server_id=? AND message_id=?').run(serverId,notice.messageId)
        // Quotes lose their excerpt too. Already forwarded independent copies are not recalled.
        this.#db.prepare("DELETE FROM chat_events WHERE ((entity_id=? OR entity_id=?) AND json_extract(payload,'$.serverId')=?) OR entity_id IN (SELECT id FROM messages WHERE json_extract(payload,'$.serverId')=? AND json_extract(payload,'$.quote.messageId')=?) OR entity_id IN (SELECT json_extract(payload,'$.clientMessageId') FROM messages WHERE json_extract(payload,'$.serverId')=? AND json_extract(payload,'$.quote.messageId')=?)").run(notice.messageId,notice.clientMessageId,serverId,serverId,notice.messageId,serverId,notice.messageId)
        this.#db.prepare("UPDATE messages SET payload=json_remove(json_set(payload,'$.quote.text','引用的消息已撤回','$.quote.retracted',json('true')),'$.quote.attachmentName') WHERE json_extract(payload,'$.serverId')=? AND json_extract(payload,'$.quote.messageId')=?").run(serverId,notice.messageId)
        record('message.retracted',notice.messageId,{serverId,...notice})
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    // Checkpoint maintenance must not turn an already committed edit into a failed save.
    if(commit.retraction){try{this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')}catch{}}
  }

  savePluginEvent(
    serverId: string,
    event: { id: string; groupId: string; pluginId: string },
  ): boolean {
    this.#assertOpen()
    const result=this.#db
      .prepare('INSERT OR IGNORE INTO plugin_inbox VALUES (?,?,?,?,?,?)')
      .run(
        serverId,
        event.id,
        event.groupId,
        event.pluginId,
        JSON.stringify(event),
        Date.now(),
      )
    return Number(result.changes)>0
  }
  outbox(serverId: string): OutboxEntry[] {
    this.#assertOpen()
    return this.#db.prepare('SELECT client_id AS clientMessageId,server_id AS serverId,conversation_id AS conversationId,created_at AS createdAt FROM central_outbox WHERE server_id=? ORDER BY created_at,rowid LIMIT 100').all(serverId) as unknown as OutboxEntry[]
  }
  serverOrigin(serverId:string):string|undefined { const row=this.#db.prepare('SELECT address FROM server_origins WHERE server_id=?').get(serverId);return row?String(row.address):undefined }
  rememberServerOrigin(serverId:string,address:string):void { this.#db.prepare('INSERT INTO server_origins VALUES (?,?) ON CONFLICT(server_id) DO UPDATE SET address=excluded.address').run(serverId,address) }
  pendingReads(serverId: string): string[] {
    return this.#db.prepare('SELECT message_id FROM read_outbox WHERE server_id=? LIMIT 100').all(serverId).map(row => String(row.message_id))
  }
  confirmReads(serverId: string, ids: string[]): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) this.#db.prepare('DELETE FROM read_outbox WHERE server_id=? AND message_id=?').run(serverId,id)
      this.#db.exec('COMMIT')
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  markConversationRead(conversationId: string): boolean {
    const conversation=this.#db.prepare('SELECT payload FROM conversations WHERE id=?').get(conversationId)
    if(!conversation)return false
    const saved=JSON.parse(String(conversation.payload)) as RecordValue
    if(typeof saved.serverId!=='string')return false
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare("INSERT OR IGNORE INTO read_outbox(server_id,message_id) SELECT json_extract(payload,'$.serverId'),id FROM messages WHERE conversation_id=? AND json_extract(payload,'$.role')='peer' AND json_extract(payload,'$.status')='sent' AND json_extract(payload,'$.readAt') IS NULL AND json_extract(payload,'$.retractedAt') IS NULL AND length(id)=36 AND id NOT GLOB '*[^a-f0-9-]*' AND json_extract(payload,'$.serverId') IS NOT NULL").run(conversationId)
      const result=this.#db.prepare("UPDATE messages SET payload=json_set(payload,'$.readAt',?) WHERE conversation_id=? AND json_extract(payload,'$.role')='peer' AND json_extract(payload,'$.status')='sent' AND json_extract(payload,'$.readAt') IS NULL").run(Date.now(),conversationId)
      if(saved.unread!==0)this.#db.prepare("UPDATE conversations SET payload=json_set(payload,'$.unread',0) WHERE id=?").run(conversationId)
      this.#db.exec('COMMIT')
      return Number(result.changes)>0||saved.unread!==0
    }catch(error){this.#db.exec('ROLLBACK');throw error}
  }
  applyDeviceRead(serverId: string, messageId: string, readAt: number): boolean {
    const message=this.message(messageId)
    if(!message||message.serverId!==serverId||message.role!=='peer'||message.readAt!==undefined)return false
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare("UPDATE messages SET payload=json_set(payload,'$.readAt',?) WHERE id=?").run(readAt,messageId)
      this.#db.prepare("UPDATE conversations SET payload=json_set(payload,'$.unread',max(0,COALESCE(json_extract(payload,'$.unread'),0)-1)) WHERE id=?").run(String(message.conversationId))
      this.#db.prepare('DELETE FROM read_outbox WHERE server_id=? AND message_id=?').run(serverId,messageId)
      this.#db.exec('COMMIT');return true
    } catch(error){this.#db.exec('ROLLBACK');throw error}
  }
  searchMessages(query: string, conversationId?: string): { messageId: string; conversationId: string; text: string; senderName: string; createdAt: number }[] {
    if (!query.trim() || query.length > 200) return []
    const needle=query.trim(),indexed=[...needle].length>=3
    const match='"'+needle.replaceAll('"','""')+'"'
    // FTS narrows longer substring searches; exact matching keeps literal punctuation
    // and short Chinese keywords consistent. Only bounded excerpts cross IPC.
    const rows=this.#db.prepare(`SELECT id AS messageId,conversation_id AS conversationId,substr(json_extract(payload,'$.text'),max(1,instr(lower(json_extract(payload,'$.text')),lower(?))-80),360) AS text,json_extract(payload,'$.senderName') AS senderName,json_extract(payload,'$.createdAt') AS createdAt FROM messages WHERE ${indexed?'rowid IN (SELECT rowid FROM message_search WHERE message_search MATCH ?) AND ':''}(? IS NULL OR conversation_id=?) AND instr(lower(json_extract(payload,'$.text')),lower(?))>0 ORDER BY json_extract(payload,'$.createdAt') DESC LIMIT 50`).all(...[needle,...(indexed?[match]:[]),conversationId??null,conversationId??null,needle])
    return rows as unknown as { messageId:string;conversationId:string;text:string;senderName:string;createdAt:number }[]
  }
  pluginInbox(serverId: string, groupId: string, pluginId: string): unknown[] {
    this.#assertOpen()
    return this.#db
      .prepare(
        'SELECT payload FROM plugin_inbox WHERE server_id=? AND group_id=? AND plugin_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1000',
      )
      .all(serverId, groupId, pluginId)
      .reverse()
      .map((row) => JSON.parse(String(row.payload)) as unknown)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      this.#db.close()
    }
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('Chat store is closed.')
  }
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid chat snapshot.')
  return value as RecordValue
}
function redactRetractedMessage(message:RecordValue,notice:MessageRetraction):void {
  message.id=notice.messageId;message.createdAt=notice.createdAt;message.text='';message.status='sent';message.retractedAt=notice.retractedAt
  for(const field of ['attachment','quote','forwarded','errorMessage'])delete message[field]
}
function stringFields(value: RecordValue, fields: string[]): void {
  if (fields.some((key) => typeof value[key] !== 'string'))
    throw new Error('Invalid chat fields.')
}
function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    throw new Error('Invalid chat id.')
  return value
}
function validateSnapshot(value: unknown): Snapshot {
  const state = object(value),
    profile = object(state.profile)
  stringFields(profile, ['id', 'displayName', 'avatar'])
  if (state.version !== 1 || !Array.isArray(state.conversations))
    throw new Error('Unsupported chat snapshot.')
  const conversationIds = new Set<string>(),
    messageIds = new Set<string>()
  const conversations = state.conversations.map((value) => {
    const item = object(value),
      key = id(item.id)
    if (conversationIds.has(key)) throw new Error('Duplicate conversation id.')
    conversationIds.add(key)
    stringFields(item, ['title', 'subtitle', 'avatar', 'accent', 'transportId'])
    if (
      !['direct', 'group', 'assistant'].includes(String(item.kind)) ||
      typeof item.pinned !== 'boolean' ||
      ['muted','unavailable'].some(field => item[field] !== undefined && typeof item[field] !== 'boolean') ||
      !Number.isFinite(item.updatedAt) ||
      !Number.isSafeInteger(item.unread)
    )
      throw new Error('Invalid conversation.')
    return item
  })
  const activeConversationId = id(state.activeConversationId)
  if (!conversationIds.has(activeConversationId))
    throw new Error('Active conversation does not exist.')
  const source = object(state.messages),
    messages: Snapshot['messages'] = Object.create(null) as Snapshot['messages']
  for (const [key, value] of Object.entries(source)) {
    if (!conversationIds.has(key) || !Array.isArray(value))
      throw new Error('Invalid message conversation.')
    messages[key] = value.map((value) => {
      const item = object(value),
        keyId = id(item.id)
      if (messageIds.has(keyId) || item.conversationId !== key)
        throw new Error('Invalid message identity.')
      messageIds.add(keyId)
      stringFields(item, [
        'clientMessageId',
        'senderId',
        'senderName',
        'senderAvatar',
        'text',
      ])
      if (
        !['self', 'peer', 'system'].includes(String(item.role)) ||
        !['text', 'system'].includes(String(item.type)) ||
        !['queued', 'sending', 'sent', 'failed', 'streaming', 'cancelled'].includes(
          String(item.status),
        ) ||
        !Number.isFinite(item.createdAt)
      )
        throw new Error('Invalid message.')
      if (item.receipt !== undefined) {
        const receipt = object(item.receipt)
        if (![receipt.recipientCount,receipt.deliveredCount,receipt.readCount].every(n => Number.isSafeInteger(n) && Number(n)>=0 && Number(n)<=19) || Number(receipt.readCount)>Number(receipt.deliveredCount) || Number(receipt.deliveredCount)>Number(receipt.recipientCount)) throw new Error('Invalid receipt')
      }
      if (item.readAt !== undefined && (!Number.isSafeInteger(item.readAt) || Number(item.readAt)<0)) throw new Error('Invalid read timestamp')
      if(item.retractedAt!==undefined&&(!Number.isSafeInteger(item.retractedAt)||Number(item.retractedAt)<0))throw new Error('Invalid retraction timestamp')
      if(item.actionsSupported!==undefined&&typeof item.actionsSupported!=='boolean')throw new Error('Invalid message feature')
      for(const field of ['quote','forwarded'])if(item[field]!==undefined)item[field]=parseMessageReference(item[field])
      if (item.authorNotes !== undefined && !Array.isArray(item.authorNotes))
        throw new Error('Invalid author notes.')
      if (Array.isArray(item.authorNotes))
        for (const noteValue of item.authorNotes) {
          const note = object(noteValue)
          if (
            !['started', 'finished'].includes(String(note.phase)) ||
            ![
              'inspect_drafts',
              'create_draft',
              'validate_draft',
              'diagnose_draft',
              'install_draft',
              'unknown',
            ].includes(String(note.tool)) ||
            typeof note.summary !== 'string' ||
            typeof note.ok !== 'boolean' ||
            typeof note.pendingInstall !== 'boolean'
          )
            throw new Error('Invalid author note.')
          if (note.draft !== null) {
            const draft = object(note.draft)
            stringFields(draft, ['id', 'displayName'])
            if (
              !Number.isSafeInteger(draft.revision) ||
              Number(draft.revision) < 0 ||
              typeof draft.ok !== 'boolean'
            )
              throw new Error('Invalid author draft.')
          }
        }
      if (item.usage !== undefined)
        item.usage = parseModelTokenUsage(item.usage)
      for (const field of ['replyToId', 'retryOfId', 'supersededById'])
        if (item[field] !== undefined) id(item[field])
      if (
        item.errorMessage !== undefined &&
        typeof item.errorMessage !== 'string'
      )
        throw new Error('Invalid message error.')
      if (item.attachment !== undefined) {
        const a = object(item.attachment)
        if (
          typeof a.id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(a.id) ||
          typeof a.name !== 'string' ||
          typeof a.mime !== 'string' ||
          !Number.isSafeInteger(a.size) ||
          Number(a.size) < 1 ||
          Number(a.size) > 5 * 1024 * 1024
        )
          throw new Error('Invalid attachment reference')
      }
      return item
    })
  }
  for (const key of conversationIds) messages[key] ??= []
  return { version: 1, profile, activeConversationId, conversations, messages }
}
