export type ConversationKind = 'direct' | 'group' | 'assistant'
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'streaming' | 'cancelled'
export type ParticipantRole = 'self' | 'peer' | 'system'

export interface Profile {
  id: string
  displayName: string
  avatar: string
}

export interface Conversation {
  id: string
  title: string
  subtitle: string
  avatar: string
  accent: string
  kind: ConversationKind
  unread: number
  pinned: boolean
  updatedAt: number
  transportId: string
}

export interface AuthorToolNote {
  phase: 'started' | 'finished'
  tool: 'inspect_drafts' | 'create_draft' | 'validate_draft' | 'diagnose_draft' | 'install_draft' | 'unknown'
  ok: boolean
  summary: string
  pendingInstall: boolean
  draft: {
    id: string
    displayName: string
    revision: number
    ok: boolean
  } | null
}

export interface ChatMessage {
  id: string
  clientMessageId: string
  conversationId: string
  senderId: string
  senderName: string
  senderAvatar: string
  role: ParticipantRole
  type: 'text' | 'system'
  text: string
  createdAt: number
  status: MessageStatus
  authorNotes?: readonly AuthorToolNote[]
  errorMessage?: string
  replyToId?: string
  retryOfId?: string
  supersededById?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; reportedRequests: number; requestCount: number }
}

export interface ChatState {
  version: 1
  profile: Profile
  conversations: Conversation[]
  messages: Record<string, ChatMessage[]>
  activeConversationId: string
}

export interface OutgoingMessage {
  clientMessageId: string
  conversationId: string
  text: string
  createdAt: number
}

export interface IncomingMessageDraft {
  senderId: string
  senderName: string
  senderAvatar: string
  text: string
}

export interface SendReceipt {
  eventId: string
  acceptedAt: number
  reply?: IncomingMessageDraft
}

export type ModelTranscriptMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ModelChatUpdate =
  | { type: 'delta'; conversationId: string; assistantMessageId: string; textDelta: string }
  | { type: 'completed'; conversationId: string; assistantMessageId: string; text: string; usage?: NonNullable<ChatMessage['usage']> }
  | { type: 'failed'; conversationId: string; assistantMessageId: string; partialText: string; errorMessage?: string }
  | { type: 'cancelled'; conversationId: string; assistantMessageId: string; partialText: string }
  | { type: 'author-tool'; conversationId: string; assistantMessageId: string; note: AuthorToolNote }

/** Stable capability boundary implemented by local, central-server, or P2P plugins. */
export interface ChatTransport {
  readonly id: string
  readonly displayName: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(message: OutgoingMessage): Promise<SendReceipt>
}

export interface ChatTransportPlugin {
  readonly id: string
  readonly version: string
  readonly displayName: string
  create(): ChatTransport
}

export const chatTransportsServiceId = 'chat.transports'

export class TransportRegistry {
  readonly #plugins = new Map<string, ChatTransportPlugin>()

  register(plugin: ChatTransportPlugin): () => void {
    if (this.#plugins.has(plugin.id)) {
      throw new Error(`Transport plugin '${plugin.id}' is already registered.`)
    }
    this.#plugins.set(plugin.id, plugin)
    return () => {
      if (this.#plugins.get(plugin.id) === plugin) this.#plugins.delete(plugin.id)
    }
  }

  get(id: string): ChatTransportPlugin | undefined {
    return this.#plugins.get(id)
  }

  list(): ChatTransportPlugin[] {
    return [...this.#plugins.values()]
  }
}

const seedConversationIds = {
  product: 'conversation-product',
  assistant: 'conversation-assistant',
  plugins: 'conversation-plugins',
} as const

export function createSeedState(now = Date.now()): ChatState {
  const profile: Profile = { id: 'local-user', displayName: '我', avatar: 'M' }
  const conversations: Conversation[] = [
    {
      id: seedConversationIds.product,
      title: '产品讨论',
      subtitle: '3 位成员',
      avatar: '产',
      accent: '#7067f0',
      kind: 'group',
      unread: 2,
      pinned: true,
      updatedAt: now - 8 * 60_000,
      transportId: 'builtin.local-demo',
    },
    {
      id: seedConversationIds.assistant,
      title: 'More AI',
      subtitle: '本地演示助手',
      avatar: 'AI',
      accent: '#1f9d78',
      kind: 'assistant',
      unread: 0,
      pinned: true,
      updatedAt: now - 32 * 60_000,
      transportId: 'builtin.local-demo',
    },
    {
      id: seedConversationIds.plugins,
      title: '插件开发群',
      subtitle: '5 位成员',
      avatar: '插',
      accent: '#e1834b',
      kind: 'group',
      unread: 0,
      pinned: false,
      updatedAt: now - 3 * 60 * 60_000,
      transportId: 'builtin.local-demo',
    },
  ]

  return {
    version: 1,
    profile,
    conversations,
    activeConversationId: seedConversationIds.product,
    messages: {
      [seedConversationIds.product]: [
        seedMessage(seedConversationIds.product, 'system', '今天 09:30', now - 30 * 60_000),
        seedMessage(seedConversationIds.product, 'peer', '桌面端先把聊天主链路跑通，插件能力从接口进入。', now - 26 * 60_000, '林初', '林'),
        seedMessage(seedConversationIds.product, 'self', '赞同。第一版要能真实发送、保存和恢复消息。', now - 21 * 60_000),
        seedMessage(seedConversationIds.product, 'peer', '服务端 transport 后续接入，UI 不需要跟着重写。', now - 8 * 60_000, '许然', '许'),
      ],
      [seedConversationIds.assistant]: [
        seedMessage(seedConversationIds.assistant, 'peer', '你好，我是 More AI。本地演示模式下，我会确认收到的消息。', now - 32 * 60_000, 'More AI', 'AI'),
      ],
      [seedConversationIds.plugins]: [
        seedMessage(seedConversationIds.plugins, 'peer', 'Transport、消息卡片和侧边栏都应该能由插件提供。', now - 3 * 60 * 60_000, 'Cordis Bot', 'C'),
      ],
    },
  }
}

function seedMessage(
  conversationId: string,
  role: ParticipantRole,
  text: string,
  createdAt: number,
  senderName = role === 'self' ? '我' : '系统',
  senderAvatar = role === 'self' ? 'M' : '·',
): ChatMessage {
  const id = `${conversationId}-${createdAt}-${role}`
  return {
    id,
    clientMessageId: id,
    conversationId,
    senderId: role === 'self' ? 'local-user' : `seed-${senderName}`,
    senderName,
    senderAvatar,
    role,
    type: role === 'system' ? 'system' : 'text',
    text,
    createdAt,
    status: 'sent',
  }
}

export function normalizeState(candidate: unknown): ChatState {
  if (!candidate || typeof candidate !== 'object') return createSeedState()
  const value = candidate as Partial<ChatState>
  if (value.version !== 1 || !Array.isArray(value.conversations) || !value.messages || typeof value.messages !== 'object') {
    return createSeedState()
  }
  if (!value.profile || typeof value.activeConversationId !== 'string') return createSeedState()
  if (!value.conversations.some(item => item.id === value.activeConversationId)) return createSeedState()
  for (const list of Object.values(value.messages)) {
    if (!Array.isArray(list)) return createSeedState()
  }
  const restored = interruptStreamingMessages(value as ChatState)
  let changed = false
  const messages: ChatState['messages'] = {}
  for (const [id, list] of Object.entries(restored.messages)) messages[id] = list.map(message => {
    if (message.status !== 'sending') return message
    changed = true
    return { ...message, status: 'failed' }
  })
  return changed ? { ...restored, messages } : restored
}

/** An interrupted reply is restored as cancelled, never as a normal completion. */
export function interruptStreamingMessages(state: ChatState, onlyConversationId?: string): ChatState {
  let changed = false
  const messages: ChatState['messages'] = {}
  for (const [conversationId, list] of Object.entries(state.messages)) {
    if (!Array.isArray(list)) return state
    if (onlyConversationId !== undefined && conversationId !== onlyConversationId) { messages[conversationId] = list; continue }
    messages[conversationId] = list.map(message => {
      if (!message || message.status !== 'streaming') return message
      changed = true
      return { ...message, status: 'cancelled' }
    })
  }
  return changed ? { ...state, messages } : state
}

export function applyModelChatUpdate(state: ChatState, update: ModelChatUpdate): ChatState {
  const list = state.messages[update.conversationId]
  if (!list) return state
  const index = list.findIndex(message => message.id === update.assistantMessageId)
  if (index < 0) return state
  const current = list[index]
  if (!current) return state
  if (update.type === 'author-tool') {
    const authorNotes = [...(current.authorNotes ?? []), update.note].slice(-32)
    return replaceMessage(state, update.conversationId, index, { ...current, authorNotes })
  }
  if (current.status === 'sent') return state
  if (current.status === 'cancelled' || current.status === 'failed') {
    const partial = update.type === current.status ? update.partialText : undefined
    if (partial === undefined) return state
    const text = partial || current.text
    if (text === current.text) return state
    return replaceMessage(state, update.conversationId, index, { ...current, text })
  }
  if (current.status !== 'streaming') return state
  switch (update.type) {
    case 'delta':
      return replaceMessage(state, update.conversationId, index, {
        ...current,
        text: `${current.text}${update.textDelta}`,
        status: 'streaming',
      })
    case 'completed':
      return replaceMessage(state, update.conversationId, index, { ...current, text: update.text, status: 'sent', ...(update.usage ? { usage: update.usage } : {}) })
    case 'failed':
      return replaceMessage(state, update.conversationId, index, {
        ...current,
        text: update.partialText || current.text,
        status: 'failed',
        ...(update.errorMessage ? { errorMessage: update.errorMessage } : {}),
      })
    case 'cancelled':
      return replaceMessage(state, update.conversationId, index, {
        ...current,
        text: update.partialText || current.text,
        status: 'cancelled',
      })
  }
}

export function toModelTranscript(messages: readonly ChatMessage[], outgoingText?: string): ModelTranscriptMessage[] {
  const transcript: ModelTranscriptMessage[] = []
  for (const message of messages) {
    if (message.type !== 'text') continue
    if (message.status !== 'sent') continue
    if (!message.text.trim()) continue
    const role = message.role === 'self' ? 'user' : message.role === 'system' ? 'system' : 'assistant'
    transcript.push({ role, content: message.text })
  }
  if (outgoingText?.trim()) transcript.push({ role: 'user', content: outgoingText })
  return transcript.slice(-40)
}

/** Retry the latest failed turn without duplicating its user message or partial reply. */
export function planAssistantRetry(messages: readonly ChatMessage[], messageId: string): { user: ChatMessage; transcript: ModelTranscriptMessage[] } | null {
  if (messages.some(message => message.status === 'streaming')) return null
  const index = messages.findIndex(message => message.id === messageId)
  const failed = messages[index]
  if (!failed || failed.role !== 'peer' || !['failed', 'cancelled'].includes(failed.status) || failed.supersededById) return null
  if (messages.slice(index + 1).some(message => message.type === 'text')) return null
  let userIndex = failed.replyToId ? messages.findIndex(message => message.id === failed.replyToId && message.role === 'self') : -1
  if (!failed.replyToId) for (let candidate = index - 1; candidate >= 0; candidate--) {
    if (messages[candidate]?.role === 'self' && messages[candidate]?.type === 'text') { userIndex = candidate; break }
  }
  const user = messages[userIndex]
  if (!user || userIndex >= index || !user.text.trim()) return null
  return { user, transcript: toModelTranscript(messages.slice(0, userIndex), user.text) }
}

function replaceMessage(state: ChatState, conversationId: string, index: number, message: ChatMessage): ChatState {
  const list = state.messages[conversationId] ?? []
  const next = list.slice()
  next[index] = message
  return {
    ...state,
    conversations: state.conversations.map(item => item.id === conversationId ? { ...item, updatedAt: message.createdAt } : item),
    messages: { ...state.messages, [conversationId]: next },
  }
}

/** Visible author-tool line. Pending drafts name the draft; failures keep the summary. */
export function authorToolLabel(note: AuthorToolNote): string {
  const summary = redactPublicText(note.summary).slice(0, 240).trim() || '作者工具没有完成。源码没有执行。'
  const draft = note.draft
  if (note.pendingInstall && draft) {
    const name = redactPublicText(draft.displayName).trim().slice(0, 80)
    const id = redactPublicText(draft.id).trim().slice(0, 128)
    if (name && id) return `待安装草稿：${name}（${id}）。${summary}`
  }
  return summary
}

function redactPublicText(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  if (sameDay) return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (yesterday.toDateString() === date.toDateString()) return '昨天'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
}
