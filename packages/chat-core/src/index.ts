export type ConversationKind = 'direct' | 'group' | 'assistant'
export type MessageStatus = 'sending' | 'sent' | 'failed'
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
  return value as ChatState
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
