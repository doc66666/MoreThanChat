export const CENTRAL_PROTOCOL_VERSION = 1
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const UI_SLOTS = [
  'app.sidebar',
  'app.rail',
  'chat.header',
  'chat.message.before',
  'chat.message.after',
  'chat.details',
  'chat.composer.before',
  'chat.composer.after',
  'app.overlay',
] as const
export type UiSlot = (typeof UI_SLOTS)[number]
export interface Member {
  id: string
  displayName: string
  online: boolean
}
export interface AttachmentRef {
  id: string
  name: string
  mime: string
  size: number
  durationMs?: number
}
export interface WireAttachment extends AttachmentRef {
  data: string
}
export interface MessageReference {
  messageId: string
  senderId: string
  senderName: string
  text: string
  attachmentName?: string
  retracted?: boolean
}
export interface MessageRetraction {
  messageId: string
  clientMessageId: string
  conversationId: string
  senderId: string
  senderName: string
  createdAt: number
  retractedAt: number
  targetKind: 'direct' | 'group'
  targetId: string
  targetName: string
}
export const RETRACTION_WINDOW_MS = 120000
export function createMessageReference(message: {id:string;senderId:string;senderName:string;text:string;attachment?:{name:string}}): MessageReference {
  return parseMessageReference({messageId:message.id,senderId:message.senderId,senderName:message.senderName,text:message.text.slice(0,280),...(message.attachment?{attachmentName:message.attachment.name}:{})})
}
export function messageContentDescriptor(message:{text:string;attachment?:AttachmentRef}):unknown {
  const a=message.attachment
  return {text:message.text,...(a?{attachment:{id:a.id,name:a.name,mime:a.mime,size:a.size,...(a.durationMs===undefined?{}:{durationMs:a.durationMs})}}:{})}
}
export interface RelayMessage {
  id: string
  clientMessageId: string
  conversationId: string
  targetKind: 'direct' | 'group'
  targetId: string
  senderId: string
  senderName: string
  text: string
  createdAt: number
  attachment?: WireAttachment
  targetName?: string
  quote?: MessageReference
  forwarded?: MessageReference
  actionsSupported?: boolean
  retractedAt?: number
}
export interface Group {
  id: string
  name: string
  ownerId: string
  members: Member[]
}
export interface GroupPluginPack {
  id: string
  version: number
  displayName: string
  kind: 'chain' | 'tic-tac-toe' | 'channel'
  slot: UiSlot
}
export interface GroupPlugin {
  groupId: string
  pack: GroupPluginPack
  digest: string
  submittedBy: string
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  revision: number
  state: Record<string, unknown>
}
export interface Directory {
  revision?: number
  receipts?: MessageReceipt[]
  self: Member
  friends: Member[]
  requests: Member[]
  outgoingRequests?: Member[]
  groups: Group[]
  plugins: GroupPlugin[]
  groupRequests?: { groupId: string; groupName: string; user: Member }[]
}
export interface MessageReceipt {
  messageId: string
  clientMessageId: string
  acceptedAt: number
  recipientCount: number
  deliveredCount: number
  readCount: number
  actionsSupported?: boolean
  senderName?:string
}
export interface ServerSnapshot {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  address: string
  serverId: string | null
  mode: 'public' | 'private' | null
  userId: string
  displayName: string
  error: string | null
  directory: Directory | null
}
export type RelayEvent =
  | { id: string; kind: 'message'; message: RelayMessage }
  | { id: string; kind: 'directory'; receipt?: MessageReceipt; retraction?: MessageRetraction; read?: { messageId: string; readAt: number } }
  | {
      id: string
      kind: 'plugin'
      groupId: string
      pluginId: string
      channel: string
      payload: unknown
    }
/** Capability passed to approved group plugins; no sockets, tokens or arbitrary URLs. */
export interface GroupNetwork {
  send(
    groupId: string,
    pluginId: string,
    channel: string,
    payload: unknown,
  ): Promise<void>
}
export function validUid(id: unknown): id is string {
  return typeof id === 'string' && /^usr_[a-f0-9]{64}$/.test(id)
}
export function validGroupId(id: unknown): id is string {
  return typeof id === 'string' && /^grp_[a-f0-9-]{36}$/.test(id)
}
export function parseGroupPluginPack(value: unknown): GroupPluginPack {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid plugin package')
  const v = value as GroupPluginPack
  if (
    !/^gplugin_[a-f0-9-]{36}$/.test(v.id) ||
    !Number.isSafeInteger(v.version) ||
    v.version < 1 ||
    v.version > 10000 ||
    typeof v.displayName !== 'string' ||
    !v.displayName.trim() ||
    v.displayName.length > 80 ||
    !['chain', 'tic-tac-toe', 'channel'].includes(v.kind) ||
    !UI_SLOTS.includes(v.slot)
  )
    throw new Error('Invalid plugin package')
  if (
    Object.keys(value).some(
      (key) => !['id', 'version', 'displayName', 'kind', 'slot'].includes(key),
    )
  )
    throw new Error('Unsupported executable plugin package')
  return {
    id: v.id,
    version: v.version,
    displayName: v.displayName.trim(),
    kind: v.kind,
    slot: v.slot,
  }
}
export function validateWireAttachment(value: WireAttachment): void {
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    typeof value.name !== 'string' ||
    value.name.length > 200 ||
    typeof value.mime !== 'string' ||
    value.mime.length > 100 ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_ATTACHMENT_BYTES ||
    typeof value.data !== 'string' ||
    value.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) ||
    (value.durationMs !== undefined &&
      (!Number.isFinite(value.durationMs) ||
        value.durationMs < 0 ||
        value.durationMs > 60000))
  )
    throw new Error('Invalid attachment')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid central object')
  return value as Record<string, unknown>
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    throw new Error('Invalid central text')
  return value
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('Invalid central list')
  return value
}
function member(value: unknown): Member {
  const v = record(value)
  if (!validUid(v.id) || typeof v.online !== 'boolean')
    throw new Error('Invalid member')
  return {
    id: v.id,
    displayName: boundedText(v.displayName, 80),
    online: v.online,
  }
}
export function parseDirectory(value: unknown): Directory {
  const v = record(value)
  const groups = list(v.groups, 200).map((value) => {
    const g = record(value)
    if (!validGroupId(g.id) || !validUid(g.ownerId))
      throw new Error('Invalid group')
    const members = list(g.members, 20).map(member)
    if (!members.some((m) => m.id === g.ownerId))
      throw new Error('Invalid group owner')
    return {
      id: g.id,
      ownerId: g.ownerId,
      name: boundedText(g.name, 80),
      members,
    }
  })
  const plugins = list(v.plugins, 2000).map((value) => {
    const p = record(value),
      pack = parseGroupPluginPack(p.pack),
      state = record(p.state)
    if (
      !validGroupId(p.groupId) ||
      !validUid(p.submittedBy) ||
      typeof p.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.digest) ||
      !['pending', 'approved', 'rejected', 'superseded'].includes(
        String(p.status),
      ) ||
      !Number.isSafeInteger(p.revision) ||
      Number(p.revision) < 0 ||
      JSON.stringify(state).length > 32000
    )
      throw new Error('Invalid group plugin')
    if (p.status === 'approved' && pack.kind === 'chain')
      for (const item of list(state.entries, 20)) {
        const entry = record(item)
        if (!validUid(entry.userId)) throw new Error('Invalid chain')
        boundedText(entry.name, 80)
        boundedText(entry.text, 120)
      }
    if (p.status === 'approved' && pack.kind === 'tic-tac-toe') {
      const board = list(state.board, 9),
        players = list(state.players, 2)
      if (
        board.length !== 9 ||
        board.some((mark) => mark !== null && mark !== 'X' && mark !== 'O') ||
        players.length !== 2 ||
        players.some((id) => !validUid(id)) ||
        ![0, 1].includes(Number(state.turn)) ||
        (state.winner !== null &&
          state.winner !== 'draw' &&
          !validUid(state.winner))
      )
        throw new Error('Invalid game state')
    }
    return {
      groupId: p.groupId,
      pack,
      digest: p.digest,
      submittedBy: p.submittedBy,
      status: p.status as GroupPlugin['status'],
      revision: Number(p.revision),
      state,
    }
  })
  const groupRequests =
    v.groupRequests === undefined
      ? []
      : list(v.groupRequests, 200).map((value) => {
          const r = record(value)
          if (!validGroupId(r.groupId)) throw new Error('Invalid group request')
          return {
            groupId: r.groupId,
            groupName: boundedText(r.groupName, 80),
            user: member(r.user),
          }
        })
  return {
    self: member(v.self),
    ...(v.revision === undefined ? {} : { revision: parseRevision(v.revision) }),
    ...(v.receipts === undefined ? {} : { receipts: list(v.receipts, 200).map(parseMessageReceipt) }),
    friends: list(v.friends, 500).map(member),
    requests: list(v.requests, 500).map(member),
    ...(v.outgoingRequests===undefined?{}:{outgoingRequests:list(v.outgoingRequests,500).map(member)}),
    groups,
    plugins,
    groupRequests,
  }
}
export function parseRelayEvent(value: unknown): RelayEvent {
  const e = record(value),
    id = boundedText(e.id, 80)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid event id')
  if (e.kind === 'directory') {
    let read: {messageId:string;readAt:number}|undefined
    if(e.read!==undefined){
      const value=e.read as Record<string,unknown>
      if(!value||typeof value.messageId!=='string'||!/^[a-f0-9-]{36}$/.test(value.messageId)||!Number.isSafeInteger(value.readAt)||Number(value.readAt)<0)throw new Error('Invalid read marker')
      read={messageId:value.messageId,readAt:Number(value.readAt)}
    }
    return { id, kind: 'directory', ...(e.receipt === undefined ? {} : { receipt: parseMessageReceipt(e.receipt) }),...(e.retraction===undefined?{}:{retraction:parseMessageRetraction(e.retraction)}),...(read?{read}:{}) }
  }
  if (e.kind === 'plugin') {
    if (
      !validGroupId(e.groupId) ||
      typeof e.pluginId !== 'string' ||
      !/^gplugin_[a-f0-9-]{36}$/.test(e.pluginId) ||
      JSON.stringify(e.payload ?? null).length > 32000
    )
      throw new Error('Invalid plugin event')
    return {
      id,
      kind: 'plugin',
      groupId: e.groupId,
      pluginId: e.pluginId,
      channel: boundedText(e.channel, 80),
      payload: e.payload ?? null,
    }
  }
  if (e.kind !== 'message') throw new Error('Invalid event kind')
  const m = record(e.message)
  if (
    m.id !== id ||
    !validUid(m.senderId) ||
    !['direct', 'group'].includes(String(m.targetKind)) ||
    !Number.isFinite(m.createdAt) ||
    (m.targetKind === 'direct'
      ? !validUid(m.targetId)
      : !validGroupId(m.targetId))
  )
    throw new Error('Invalid relay message')
  if (m.attachment !== undefined)
    validateWireAttachment(m.attachment as WireAttachment)
  return {
    id,
    kind: 'message',
    message: {
      id,
      clientMessageId: boundedText(m.clientMessageId, 80),
      conversationId: boundedText(m.conversationId, 120),
      targetKind: m.targetKind as 'direct' | 'group',
      targetId: m.targetId as string,
      senderId: m.senderId,
      senderName: boundedText(m.senderName, 80),
      text: boundedText(m.text, 100000),
      createdAt: Number(m.createdAt),
      ...(m.targetName===undefined?{}:{targetName:boundedText(m.targetName,80)}),
      ...(m.attachment === undefined
        ? {}
        : { attachment: m.attachment as WireAttachment }),
      ...(m.quote===undefined?{}:{quote:parseMessageReference(m.quote)}),
      ...(m.forwarded===undefined?{}:{forwarded:parseMessageReference(m.forwarded)}),
      ...(m.actionsSupported===undefined?{}:{actionsSupported:parseBoolean(m.actionsSupported)}),
      ...(m.retractedAt===undefined?{}:{retractedAt:parseRevision(m.retractedAt)}),
    },
  }
}

function parseRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid directory revision')
  return Number(value)
}
export function parseMessageReceipt(value: unknown): MessageReceipt {
  const r = record(value)
  if (typeof r.messageId !== 'string' || !/^[a-f0-9-]{36}$/.test(r.messageId)
    || typeof r.clientMessageId !== 'string' || !r.clientMessageId || r.clientMessageId.length > 80
    || !Number.isSafeInteger(r.acceptedAt) || Number(r.acceptedAt) < 0
    || ![r.recipientCount, r.deliveredCount, r.readCount].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 19)
    || Number(r.readCount) > Number(r.deliveredCount) || Number(r.deliveredCount) > Number(r.recipientCount)) throw new Error('Invalid message receipt')
  return { messageId: r.messageId, clientMessageId: r.clientMessageId, acceptedAt: Number(r.acceptedAt), recipientCount: Number(r.recipientCount), deliveredCount: Number(r.deliveredCount), readCount: Number(r.readCount),...(r.actionsSupported===undefined?{}:{actionsSupported:parseBoolean(r.actionsSupported)}),...(r.senderName===undefined?{}:{senderName:boundedText(r.senderName,80)}) }
}

function parseBoolean(value:unknown):boolean {if(typeof value!=='boolean')throw new Error('Invalid boolean');return value}
export function parseMessageReference(value:unknown):MessageReference {
  const v=record(value)
  if(typeof v.messageId!=='string'||!/^[a-f0-9-]{36}$/.test(v.messageId)||!validUid(v.senderId))throw new Error('Invalid message reference')
  return {messageId:v.messageId,senderId:v.senderId,senderName:boundedText(v.senderName,80),text:boundedText(v.text,280),...(v.attachmentName===undefined?{}:{attachmentName:boundedText(v.attachmentName,200)}),...(v.retracted===undefined?{}:{retracted:parseBoolean(v.retracted)})}
}
export function parseMessageRetraction(value:unknown):MessageRetraction {
  const v=record(value)
  if(typeof v.messageId!=='string'||!/^[a-f0-9-]{36}$/.test(v.messageId)||!validUid(v.senderId)||!['direct','group'].includes(String(v.targetKind))||(v.targetKind==='group'?!validGroupId(v.targetId):!validUid(v.targetId)))throw new Error('Invalid retraction')
  const createdAt=parseRevision(v.createdAt),retractedAt=parseRevision(v.retractedAt)
  if(retractedAt<createdAt)throw new Error('Invalid retraction time')
  return {messageId:v.messageId,clientMessageId:boundedText(v.clientMessageId,80),conversationId:boundedText(v.conversationId,120),senderId:v.senderId,senderName:boundedText(v.senderName,80),createdAt,retractedAt,targetKind:v.targetKind as 'direct'|'group',targetId:String(v.targetId),targetName:boundedText(v.targetName,80)}
}
