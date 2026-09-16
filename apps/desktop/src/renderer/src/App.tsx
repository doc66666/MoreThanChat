import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Info,
  MessageCircleMore,
  MoreHorizontal,
  Paperclip,
  PencilLine,
  Phone,
  PlugZap,
  Search,
  SendHorizontal,
  Settings,
  Smile,
  Sparkles,
  Users,
  Video,
  X,
} from 'lucide-react'
import {
  TransportRegistry,
  createSeedState,
  formatRelativeTime,
  normalizeState,
  type ChatMessage,
  type ChatState,
  type Conversation,
} from '@more-than-chat/chat-core'
import { localTransportPlugin } from './local-transport'

const registry = new TransportRegistry()
registry.register(localTransportPlugin)

function uid(): string {
  return crypto.randomUUID()
}

function initials(value: string): string {
  return [...value.trim()].slice(0, 2).join('').toUpperCase() || '?'
}

export function App() {
  const [state, setState] = useState<ChatState | null>(null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [showDetails, setShowDetails] = useState(true)
  const [showPlugins, setShowPlugins] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.moreThanChat.loadState().then(value => setState(value ? normalizeState(value) : createSeedState()))
  }, [])

  useEffect(() => {
    if (!state) return
    const timer = window.setTimeout(() => {
      void window.moreThanChat.saveState(state).catch(error => {
        console.error(error)
        setToast('本地保存失败，请稍后重试')
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [state])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state?.activeConversationId, state?.messages])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const active = state?.conversations.find(item => item.id === state.activeConversationId)
  const messages = active && state ? (state.messages[active.id] ?? []) : []
  const filtered = useMemo(() => {
    if (!state) return []
    const needle = query.trim().toLocaleLowerCase()
    return [...state.conversations]
      .filter(item => !needle || item.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  }, [query, state])

  if (!state || !active) return <LoadingScreen />
  const readyState = state

  function selectConversation(id: string) {
    setState(current => current ? {
      ...current,
      activeConversationId: id,
      conversations: current.conversations.map(item => item.id === id ? { ...item, unread: 0 } : item),
    } : current)
    setDraft('')
  }

  async function sendMessage() {
    const text = draft.trim()
    if (!text || !active) return
    const now = Date.now()
    const clientMessageId = uid()
    const outgoing: ChatMessage = {
      id: clientMessageId,
      clientMessageId,
      conversationId: active.id,
      senderId: readyState.profile.id,
      senderName: readyState.profile.displayName,
      senderAvatar: readyState.profile.avatar,
      role: 'self',
      type: 'text',
      text,
      createdAt: now,
      status: 'sending',
    }
    setDraft('')
    setState(current => current ? appendMessage(current, outgoing) : current)

    const plugin = registry.get(active.transportId)
    if (!plugin) {
      setState(current => current ? updateMessageStatus(current, active.id, clientMessageId, 'failed') : current)
      setToast('当前会话的传输插件不可用')
      return
    }

    const transport = plugin.create()
    try {
      await transport.connect()
      const receipt = await transport.send({ clientMessageId, conversationId: active.id, text, createdAt: now })
      setState(current => current ? updateMessageStatus(current, active.id, clientMessageId, 'sent') : current)
      if (receipt.reply) {
        const reply: ChatMessage = {
          id: receipt.eventId,
          clientMessageId: receipt.eventId,
          conversationId: active.id,
          senderId: receipt.reply.senderId,
          senderName: receipt.reply.senderName,
          senderAvatar: receipt.reply.senderAvatar,
          role: 'peer',
          type: 'text',
          text: receipt.reply.text,
          createdAt: receipt.acceptedAt,
          status: 'sent',
        }
        window.setTimeout(() => setState(current => current ? appendMessage(current, reply) : current), 260)
      }
    }
    catch (error) {
      console.error(error)
      setState(current => current ? updateMessageStatus(current, active.id, clientMessageId, 'failed') : current)
      setToast('消息发送失败')
    }
    finally {
      await transport.disconnect()
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  function createConversation(title: string, kind: Conversation['kind']) {
    const clean = title.trim()
    if (!clean) return
    const id = uid()
    const next: Conversation = {
      id,
      title: clean,
      subtitle: kind === 'group' ? '新群聊' : '本地联系人',
      avatar: initials(clean),
      accent: ['#6671e5', '#1e9c76', '#dc7d4c', '#a361c2'][readyState.conversations.length % 4]!,
      kind,
      unread: 0,
      pinned: false,
      updatedAt: Date.now(),
      transportId: 'builtin.local-demo',
    }
    setState(current => current ? {
      ...current,
      conversations: [next, ...current.conversations],
      messages: { ...current.messages, [id]: [] },
      activeConversationId: id,
    } : current)
    setShowNewChat(false)
  }

  return (
    <div className="app-shell">
      <div className="window-drag-region">
        <span className="window-title"><Sparkles size={14} /> MoreThanChat</span>
      </div>

      <nav className="app-rail" aria-label="主导航">
        <button className="brand-mark" aria-label="MoreThanChat"><span>M</span></button>
        <div className="rail-actions">
          <RailButton active icon={<MessageCircleMore />} label="聊天" />
          <RailButton icon={<Users />} label="联系人" onClick={() => setToast('联系人将在下一阶段开放')} />
          <RailButton icon={<PlugZap />} label="插件" onClick={() => setShowPlugins(true)} />
          <RailButton icon={<Archive />} label="归档" onClick={() => setToast('暂无已归档会话')} />
        </div>
        <div className="rail-bottom">
          <RailButton icon={<CircleHelp />} label="帮助" onClick={() => setToast('MoreThanChat 0.1 · 本地演示')} />
          <RailButton icon={<Settings />} label="设置" onClick={() => setToast('设置页将在接入服务端时开放')} />
          <div className="profile-avatar">M<span className="online-dot" /></div>
        </div>
      </nav>

      <aside className="conversation-sidebar">
        <div className="sidebar-heading">
          <div>
            <p className="eyebrow">工作区</p>
            <button className="workspace-name">我的空间 <ChevronDown size={15} /></button>
          </div>
          <button className="icon-button prominent" title="新建会话" onClick={() => setShowNewChat(true)}><PencilLine size={18} /></button>
        </div>
        <label className="search-box">
          <Search size={17} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话" />
          <kbd>⌘K</kbd>
        </label>
        <div className="conversation-section-label">
          <span>最近消息</span><span>{filtered.length}</span>
        </div>
        <div className="conversation-list">
          {filtered.map(item => {
            const last = state.messages[item.id]?.at(-1)
            return (
              <button key={item.id} className={`conversation-item ${item.id === active.id ? 'active' : ''}`} onClick={() => selectConversation(item.id)}>
                <Avatar conversation={item} />
                <span className="conversation-copy">
                  <span className="conversation-title-row">
                    <strong>{item.title}</strong>
                    <time>{formatRelativeTime(item.updatedAt)}</time>
                  </span>
                  <span className="conversation-preview-row">
                    <span>{last?.text ?? '还没有消息'}</span>
                    {item.unread > 0 && <b>{item.unread}</b>}
                  </span>
                </span>
              </button>
            )
          })}
          {filtered.length === 0 && <div className="empty-search">没有找到相关会话</div>}
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div className="chat-identity"><Avatar conversation={active} small /><div><h1>{active.title}</h1><p><span className="status-dot" /> {active.subtitle}</p></div></div>
          <div className="header-actions">
            <button className="icon-button" title="语音通话" onClick={() => setToast('通话将由 WebRTC 插件提供')}><Phone size={18} /></button>
            <button className="icon-button" title="视频通话" onClick={() => setToast('视频将由 WebRTC 插件提供')}><Video size={19} /></button>
            <span className="header-divider" />
            <button className={`icon-button ${showDetails ? 'selected' : ''}`} title="会话详情" onClick={() => setShowDetails(value => !value)}><Info size={19} /></button>
          </div>
        </header>

        <section className="message-scroll" aria-live="polite">
          <div className="message-day"><span>今天</span></div>
          {messages.length === 0
            ? <div className="empty-conversation"><div className="empty-icon"><MessageCircleMore /></div><h2>开始一段新对话</h2><p>消息暂存在本机，接入服务器 transport 后可自动同步。</p></div>
            : messages.map((message, index) => <MessageBubble key={message.id} message={message} compact={messages[index - 1]?.senderId === message.senderId} />)}
          <div ref={endRef} />
        </section>

        <footer className="composer-wrap">
          <div className="composer">
            <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={`发消息给 ${active.title}`} rows={1} />
            <div className="composer-toolbar">
              <div>
                <button title="添加附件" onClick={() => setToast('附件上传将在对象存储接入后开放')}><Paperclip size={19} /></button>
                <button title="表情" onClick={() => setDraft(value => `${value} 🙂`)}><Smile size={19} /></button>
              </div>
              <div className="send-area"><span>Enter 发送 · Shift+Enter 换行</span><button className="send-button" disabled={!draft.trim()} onClick={() => void sendMessage()}><SendHorizontal size={18} /></button></div>
            </div>
          </div>
        </footer>
      </main>

      {showDetails && <DetailsPanel conversation={active} onClose={() => setShowDetails(false)} />}
      {showPlugins && <PluginPanel onClose={() => setShowPlugins(false)} />}
      {showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} onCreate={createConversation} />}
      {toast && <div className="toast"><Check size={17} />{toast}</div>}
    </div>
  )
}

function appendMessage(state: ChatState, message: ChatMessage): ChatState {
  return {
    ...state,
    conversations: state.conversations.map(item => item.id === message.conversationId ? { ...item, updatedAt: message.createdAt } : item),
    messages: { ...state.messages, [message.conversationId]: [...(state.messages[message.conversationId] ?? []), message] },
  }
}

function updateMessageStatus(state: ChatState, conversationId: string, messageId: string, status: ChatMessage['status']): ChatState {
  return {
    ...state,
    messages: {
      ...state.messages,
      [conversationId]: (state.messages[conversationId] ?? []).map(item => item.id === messageId ? { ...item, status } : item),
    },
  }
}

function RailButton({ icon, label, active = false, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return <button className={`rail-button ${active ? 'active' : ''}`} title={label} onClick={onClick}>{icon}<span>{label}</span></button>
}

function Avatar({ conversation, small = false }: { conversation: Conversation; small?: boolean }) {
  return <span className={`avatar ${small ? 'small' : ''}`} style={{ background: conversation.accent }}>{conversation.avatar}</span>
}

function MessageBubble({ message, compact }: { message: ChatMessage; compact: boolean }) {
  if (message.type === 'system') return <div className="system-message">{message.text}</div>
  const own = message.role === 'self'
  return (
    <article className={`message-row ${own ? 'own' : ''} ${compact ? 'compact' : ''}`}>
      {!own && <span className="message-avatar">{message.senderAvatar}</span>}
      <div className="message-content">
        {!compact && !own && <span className="sender-name">{message.senderName}</span>}
        <div className="bubble"><p>{message.text}</p><span className="bubble-meta">{formatRelativeTime(message.createdAt)} {own && (message.status === 'sending' ? '· 发送中' : message.status === 'failed' ? '· 失败' : '✓')}</span></div>
      </div>
    </article>
  )
}

function DetailsPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  return (
    <aside className="details-panel">
      <div className="details-header"><strong>会话详情</strong><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
      <div className="details-profile"><Avatar conversation={conversation} /><h2>{conversation.title}</h2><p>{conversation.subtitle}</p></div>
      <div className="details-actions"><button><Search size={18} /><span>搜索</span></button><button><Bot size={18} /><span>AI 总结</span></button><button><MoreHorizontal size={18} /><span>更多</span></button></div>
      <div className="details-card"><div><span>传输插件</span><strong>本地演示</strong></div><div><span>消息存储</span><strong>此设备</strong></div><div><span>端到端加密</span><strong className="muted">尚未启用</strong></div></div>
      <div className="details-note"><PlugZap size={17} /><p>这块区域也是 UI Slot。未来插件可以添加成员面板、任务或知识库。</p></div>
    </aside>
  )
}

function PluginPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="plugin-drawer" onMouseDown={event => event.stopPropagation()}>
        <div className="drawer-header"><div><p className="eyebrow">运行时</p><h2>插件</h2></div><button className="icon-button" onClick={onClose}><X /></button></div>
        <div className="plugin-card"><span className="plugin-icon"><MessageCircleMore /></span><div><strong>本地演示传输</strong><p>提供消息发送与本地 AI 演示回复</p><small>builtin.local-demo · 0.1.0</small></div><span className="enabled-pill">已启用</span></div>
        <div className="plugin-empty"><PlugZap /><h3>插件接口已就绪</h3><p>中心服务器、AI 模型和消息卡片都将通过同一套能力注册机制接入。</p></div>
      </aside>
    </div>
  )
}

function NewChatDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, kind: Conversation['kind']) => void }) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<Conversation['kind']>('direct')
  function submit(event: FormEvent) {
    event.preventDefault()
    onCreate(title, kind)
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="new-chat-dialog" onSubmit={submit} onMouseDown={event => event.stopPropagation()}>
        <div className="dialog-icon"><PencilLine /></div><h2>新建会话</h2><p>先创建一个本地会话，接入中心服务器后将由 transport 自动同步。</p>
        <label><span>会话名称</span><input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：周末计划" /></label>
        <div className="kind-picker"><button type="button" className={kind === 'direct' ? 'active' : ''} onClick={() => setKind('direct')}><MessageCircleMore />单聊</button><button type="button" className={kind === 'group' ? 'active' : ''} onClick={() => setKind('group')}><Users />群聊</button></div>
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()}>创建会话</button></div>
      </form>
    </div>
  )
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="loading-mark">M</div><p>正在恢复会话…</p></div>
}
