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
  self: Member
  friends: Member[]
  requests: Member[]
  groups: Group[]
  plugins: GroupPlugin[]
  groupRequests?: { groupId: string; groupName: string; user: Member }[]
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
  | { id: string; kind: 'directory' }
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
    friends: list(v.friends, 500).map(member),
    requests: list(v.requests, 500).map(member),
    groups,
    plugins,
    groupRequests,
  }
}
export function parseRelayEvent(value: unknown): RelayEvent {
  const e = record(value),
    id = boundedText(e.id, 80)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid event id')
  if (e.kind === 'directory') return { id, kind: 'directory' }
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
      ...(m.attachment === undefined
        ? {}
        : { attachment: m.attachment as WireAttachment }),
    },
  }
}
