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
  Server,
  Settings,
  Smile,
  Sparkles,
  Users,
  Video,
  X,
} from 'lucide-react'
import {
  applyModelChatUpdate,
  createSeedState,
  formatRelativeTime,
  interruptStreamingMessages,
  normalizeState,
  toModelTranscript,
  type ChatMessage,
  type ChatState,
  type Conversation,
  type ModelChatUpdate,
} from '@more-than-chat/chat-core'
import type {
  ComposerAction,
  PluginSnapshot,
  RegisteredContribution,
} from '@more-than-chat/plugin-runtime'
import type { HostPluginSnapshot, HostStatusSnapshot, ModelProviderMode, ModelSettingsSnapshot, PluginDraftInspection } from '@more-than-chat/protocol'
import type { ModelClientEvent, ModelSettingsInput } from './global'
import {
  composerActionRegistry,
  pluginRuntime,
  startBundledPlugins,
  transportRegistry,
} from './plugin-host'

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
  const [plugins, setPlugins] = useState<PluginSnapshot[]>(() => pluginRuntime.list())
  const [composerActions, setComposerActions] = useState<RegisteredContribution<ComposerAction>[]>(() => composerActionRegistry.list())
  const [hostStatus, setHostStatus] = useState<HostStatusSnapshot>({ state: 'starting', generation: 0 })
  const [hostPlugins, setHostPlugins] = useState<HostPluginSnapshot[]>([])
  const [hostPluginBusy, setHostPluginBusy] = useState(false)
  const [pluginDrafts, setPluginDrafts] = useState<PluginDraftInspection | null>(null)
  const [pluginDraftReport, setPluginDraftReport] = useState<string | null>(null)
  const [modelSettings, setModelSettings] = useState<ModelSettingsSnapshot | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const streamIdsRef = useRef(new Map<string, string>())
  const pendingModelEventsRef = useRef<ModelClientEvent[]>([])
  const hostStatusRef = useRef(hostStatus)
  hostStatusRef.current = hostStatus
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const syncPlugins = () => setPlugins(pluginRuntime.list())
    const syncActions = () => setComposerActions(composerActionRegistry.list())
    const unsubscribePlugins = pluginRuntime.subscribe(syncPlugins)
    const unsubscribeActions = composerActionRegistry.subscribe(syncActions)
    syncPlugins()
    syncActions()
    void startBundledPlugins().catch(error => {
      console.error(error)
      setToast('插件启动失败，请打开插件面板查看诊断')
    })
    return () => {
      void unsubscribePlugins()
      void unsubscribeActions()
    }
  }, [])

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = window.moreThanChat.onHostStatusChanged(status => {
      receivedEvent = true
      if (active) setHostStatus(status)
    })
    void window.moreThanChat.getHostStatus().then(status => {
      if (active && !receivedEvent) setHostStatus(status)
    }).catch(error => {
      console.error(error)
      if (active) setHostStatus({
        state: 'failed',
        generation: 0,
        error: { code: 'HOST_UNAVAILABLE', message: '无法读取 PC Host 状态。', retryable: true },
      })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (hostStatus.state !== 'ready') { setHostPlugins([]); return }
    let active = true
    void window.moreThanChat.getHostPlugins().then(catalog => {
      if (active && catalog.generation === hostStatus.generation) setHostPlugins(catalog.plugins)
    }).catch(error => {
      if (active) { console.error(error); setToast('无法读取后台插件，请稍后重试') }
    })
    return () => { active = false }
  }, [hostStatus.state, hostStatus.generation])

  useEffect(() => {
    if (!showPlugins || hostStatus.state !== 'ready') return
    let active = true
    void window.moreThanChat.inspectPluginDrafts().then(inspection => {
      if (active) setPluginDrafts(inspection)
    }).catch(error => {
      if (active) { console.error(error instanceof Error ? error.message : 'plugin drafts'); setToast('无法读取插件草稿') }
    })
    return () => { active = false }
  }, [showPlugins, hostStatus.state, hostStatus.generation])

  useEffect(() => {
    if (hostStatus.state === 'ready') return
    setState(current => current ? interruptStreamingMessages(current) : current)
  }, [hostStatus.state, hostStatus.generation])

  useEffect(() => {
    if (hostStatus.state !== 'ready') return
    let alive = true
    void window.moreThanChat.getModelSettings().then(snapshot => {
      if (alive) setModelSettings(snapshot)
    }).catch(error => {
      console.error(error instanceof Error ? error.message : 'model settings')
      if (alive) setToast('无法读取模型设置')
    })
    return () => { alive = false }
  }, [hostStatus.state, hostStatus.generation])

  useEffect(() => {
    return window.moreThanChat.onModelChatEvent(event => {
      if (event.generation !== hostStatusRef.current.generation) return
      setState(current => current ? applyIncomingModelEvent(current, event, pendingModelEventsRef.current) : current)
      if (event.type === 'failed') setToast(event.errorMessage ?? '回复失败')
      if (event.type !== 'delta') streamIdsRef.current.delete(event.assistantMessageId)
    })
  }, [])

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
    if (messages.some(message => message.status === 'streaming')) {
      setToast('请等待当前回复结束，或先停止生成')
      return
    }
    if (active.kind === 'assistant') {
      await sendAssistantMessage(text)
      return
    }
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

    const plugin = transportRegistry.get(active.transportId)
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
      try {
        await transport.disconnect()
      }
      catch (error) {
        console.error('[transport] disconnect failed', error)
      }
    }
  }

  async function sendAssistantMessage(text: string) {
    if (!active) return
    if (hostStatusRef.current.state !== 'ready') {
      setToast('PC Host 还没有就绪，暂时不能生成回复')
      return
    }
    const now = Date.now()
    const userId = uid()
    const assistantId = uid()
    const streamId = uid()
    const conversationId = active.id
    const userMessage: ChatMessage = {
      id: userId,
      clientMessageId: userId,
      conversationId,
      senderId: readyState.profile.id,
      senderName: readyState.profile.displayName,
      senderAvatar: readyState.profile.avatar,
      role: 'self',
      type: 'text',
      text,
      createdAt: now,
      status: 'sending',
    }
    const assistantMessage: ChatMessage = {
      id: assistantId,
      clientMessageId: assistantId,
      conversationId,
      senderId: 'more-ai',
      senderName: 'More AI',
      senderAvatar: 'AI',
      role: 'peer',
      type: 'text',
      text: '',
      createdAt: now + 1,
      status: 'streaming',
    }
    const transcript = toModelTranscript(messages, text)
    setDraft('')
    streamIdsRef.current.set(assistantId, streamId)
    setState(current => {
      if (!current) return current
      return drainModelEvents(
        appendMessage(appendMessage(current, userMessage), assistantMessage),
        pendingModelEventsRef.current,
      )
    })
    try {
      const ref = await window.moreThanChat.startModelChat({
        streamId,
        conversationId,
        assistantMessageId: assistantId,
        messages: transcript,
      })
      if (ref.generation !== hostStatusRef.current.generation) {
        setState(current => current ? interruptStreamingMessages(current) : current)
        void window.moreThanChat.cancelModelChat(streamId).catch(() => undefined)
        return
      }
      setState(current => current ? updateMessageStatus(current, conversationId, userId, 'sent') : current)
    }
    catch (error) {
      streamIdsRef.current.delete(assistantId)
      setState(current => {
        if (!current) return current
        const failedUser = updateMessageStatus(current, conversationId, userId, 'failed')
        return applyModelChatUpdate(failedUser, {
          type: 'failed',
          conversationId,
          assistantMessageId: assistantId,
          partialText: '',
        })
      })
      setToast(errorText(error))
    }
  }

  async function cancelGeneration() {
    if (!active) return
    const streaming = (state?.messages[active.id] ?? []).find(message => message.status === 'streaming')
    if (!streaming) return
    const streamId = streamIdsRef.current.get(streaming.id)
    streamIdsRef.current.delete(streaming.id)
    setState(current => current ? interruptStreamingMessages(current) : current)
    if (!streamId || hostStatusRef.current.state !== 'ready') return
    try {
      await window.moreThanChat.cancelModelChat(streamId)
    }
    catch (error) {
      console.error(error instanceof Error ? error.message : 'cancel failed')
    }
  }

  async function saveModelSettings(input: ModelSettingsInput) {
    const snapshot = await window.moreThanChat.setModelSettings(input)
    setModelSettings(snapshot)
    setToast(snapshot.hasApiKey ? '模型设置已保存，密钥只留在本机 Host' : '模型设置已保存')
  }

  async function clearModelKey() {
    const snapshot = await window.moreThanChat.setModelSettings({ clearApiKey: true })
    setModelSettings(snapshot)
    setToast('API Key 已从本机凭据中删除')
  }

  async function runComposerAction(action: ComposerAction) {
    if (!active) return
    try {
      const result = await action.run({
        draft,
        conversationId: active.id,
        conversationTitle: active.title,
        now: Date.now(),
      })
      setDraft(result.draft)
      if (result.notice) setToast(result.notice)
    }
    catch (error) {
      console.error(error)
      setToast(`插件动作“${action.label}”执行失败`)
    }
  }

  async function togglePlugin(plugin: PluginSnapshot) {
    const enable = plugin.status !== 'active'
    try {
      if (enable) await pluginRuntime.activate(plugin.manifest.id)
      else await pluginRuntime.deactivate(plugin.manifest.id)
      setToast(`${plugin.manifest.displayName}已${enable ? '启用' : '停用'}`)
    }
    catch (error) {
      console.error(error)
      setToast(`${plugin.manifest.displayName}${enable ? '启用' : '停用'}失败`)
    }
  }

  async function pingHost() {
    if (hostStatus.state !== 'ready') {
      setToast(`PC Host 当前${hostStatusLabel(hostStatus)}，请稍候`)
      return
    }
    try {
      const result = await window.moreThanChat.pingHost()
      setToast(`PC Host G${result.generation} 响应正常 · ${result.roundTripMs} ms`)
    }
    catch (error) {
      console.error(error)
      setToast('PC Host ping 失败，Supervisor 将尝试恢复')
    }
  }

  async function toggleHostPlugin(plugin: HostPluginSnapshot) {
    if (hostPluginBusy || hostStatus.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const catalog = await window.moreThanChat.setHostPluginEnabled(plugin.id, plugin.status !== 'active')
      if (hostStatusRef.current.state === 'ready' && hostStatusRef.current.generation === catalog.generation) setHostPlugins(catalog.plugins)
    }
    catch (error) { console.error(error); setToast('后台插件操作失败，请稍后重试') }
    finally { setHostPluginBusy(false) }
  }

  async function refreshPluginDrafts() {
    const inspection = await window.moreThanChat.inspectPluginDrafts()
    setPluginDrafts(inspection)
  }

  async function createPluginDraft(manifestJson: string, source: string) {
    if (hostPluginBusy || hostStatusRef.current.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const result = await window.moreThanChat.createPluginDraft({ manifestJson, source })
      setPluginDraftReport(result.summary)
      await refreshPluginDrafts()
      setToast(result.persisted ? '草稿已保存，尚未安装' : '草稿未保存')
    }
    catch (error) { console.error(error instanceof Error ? error.message : 'draft'); setToast(errorText(error)) }
    finally { setHostPluginBusy(false) }
  }

  async function diagnosePluginDraft(draftId: string) {
    if (hostPluginBusy || hostStatusRef.current.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const report = await window.moreThanChat.diagnosePluginDraft(draftId)
      setPluginDraftReport(report.summary)
      await refreshPluginDrafts()
    }
    catch (error) { console.error(error instanceof Error ? error.message : 'diagnose'); setToast(errorText(error)) }
    finally { setHostPluginBusy(false) }
  }

  async function installPluginDraft(draftId: string) {
    if (hostPluginBusy || hostStatusRef.current.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const alreadyInstalled = hostPlugins.some(plugin => plugin.id === draftId)
      const result = await window.moreThanChat.installPluginDraft({ draftId, confirmed: true })
      setPluginDraftReport(result.summary)
      if (hostStatusRef.current.state === 'ready' && hostStatusRef.current.generation === result.catalog.generation) {
        setHostPlugins(result.catalog.plugins)
      }
      await refreshPluginDrafts()
      const installedPlugin = result.catalog.plugins.find(plugin => plugin.id === draftId)
      const composerInstalled = (installedPlugin?.composerActions.length ?? 0) > 0
      setToast(result.installed
        ? (alreadyInstalled
          ? (composerInstalled ? '输入框动作已更新' : '文本工具已更新')
          : (composerInstalled ? '输入框动作已安装，可以在输入框使用' : '文本工具已安装，可以在输入框使用'))
        : (alreadyInstalled ? result.summary : '草稿没有安装'))
    }
    catch (error) { console.error(error instanceof Error ? error.message : 'install'); setToast(errorText(error)) }
    finally { setHostPluginBusy(false) }
  }

  async function runHostTool(pluginId: string, toolId: string, label: string) {
    if (hostPluginBusy || hostStatus.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const result = await window.moreThanChat.invokeHostTool(pluginId, toolId)
      if (hostStatusRef.current.state !== 'ready' || hostStatusRef.current.generation !== result.generation) return
      setDraft(draft => draft.trim() ? `${draft}\n${result.text}` : result.text)
      setToast(`${label}已写入输入框`)
    }
    catch (error) { console.error(error); setToast('工具暂时不可用，请稍后重试') }
    finally { setHostPluginBusy(false) }
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
      subtitle: kind === 'group' ? '新群聊' : kind === 'assistant' ? 'AI 助手' : '本地联系人',
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
        <button
          className={`host-status host-${hostStatus.state}`}
          data-host-state={hostStatus.state}
          data-host-generation={hostStatus.generation}
          title={hostStatus.error?.message ?? '点击检测 PC Host'}
          onClick={() => void pingHost()}
        >
          <Server size={13} />
          <span>{hostStatusLabel(hostStatus)}</span>
          {hostStatus.generation > 0 && <small>G{hostStatus.generation}</small>}
        </button>
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
          <RailButton icon={<CircleHelp />} label="帮助" onClick={() => setToast('MoreThanChat 0.1 · AI 回复由 PC Host 生成')} />
          <RailButton icon={<Settings />} label="设置" active={showSettings} onClick={() => setShowSettings(true)} />
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
          <div className="chat-identity" data-model-mode={active.kind === 'assistant' ? (modelSettings?.providerMode ?? 'unknown') : 'chat'}>
            <Avatar conversation={active} small />
            <div><h1>{active.title}</h1><p><span className="status-dot" /> {active.kind === 'assistant' ? modelSubtitle(modelSettings) : active.subtitle}</p></div>
          </div>
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

        <footer className="composer-wrap" data-generating={messages.some(message => message.status === 'streaming') ? 'true' : 'false'}>
          <div className="composer">
            <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={`发消息给 ${active.title}`} rows={1} />
            <div className="composer-toolbar">
              <div>
                <button title="添加附件" onClick={() => setToast('附件上传将在对象存储接入后开放')}><Paperclip size={19} /></button>
                <button title="表情" onClick={() => setDraft(value => `${value} 🙂`)}><Smile size={19} /></button>
                {composerActions.map(({ ownerId, contribution }) => (
                  <button
                    key={`${ownerId}:${contribution.id}`}
                    className="plugin-composer-action"
                    title={contribution.description}
                    onClick={() => void runComposerAction(contribution)}
                  >
                    <Sparkles size={16} /><span>{contribution.label}</span>
                  </button>
                ))}
                {hostPlugins.filter(plugin => plugin.status === 'active').flatMap(plugin => plugin.composerActions.map(action => (
                  <button key={`${plugin.id}:${action.id}`} className="plugin-composer-action declarative-composer-action"
                    data-plugin-id={plugin.id} data-action-id={action.id} disabled={hostPluginBusy}
                    title={plugin.description} onClick={() => void runHostTool(plugin.id, action.id, action.label)}>
                    <Sparkles size={16} /><span>{action.label}</span>
                  </button>
                )))}
                {hostPlugins.filter(plugin => plugin.status === 'active').flatMap(plugin => plugin.tools.map(tool => (
                  <button key={`${plugin.id}:${tool.id}`} className="plugin-composer-action host-tool-action"
                    data-plugin-id={plugin.id} data-tool-id={tool.id} disabled={hostPluginBusy}
                    title={plugin.description} onClick={() => void runHostTool(plugin.id, tool.id, tool.label)}>
                    <Server size={16} /><span>{tool.label}</span>
                  </button>
                )))}
              </div>
              <div className="send-area">
                <span>{messages.some(message => message.status === 'streaming') ? '正在生成' : 'Enter 发送 · Shift+Enter 换行'}</span>
                {messages.some(message => message.status === 'streaming')
                  ? <button className="send-button stop" onClick={() => void cancelGeneration()}>停止</button>
                  : <button className="send-button" disabled={!draft.trim()} onClick={() => void sendMessage()}><SendHorizontal size={18} /></button>}
              </div>
            </div>
          </div>
        </footer>
      </main>

      {showDetails && <DetailsPanel conversation={active} transportName={active.kind === 'assistant' ? 'PC Host 模型' : (transportRegistry.get(active.transportId)?.displayName ?? '插件不可用')} {...(active.kind === 'assistant' ? { modelLabel: modelSubtitle(modelSettings) } : {})} onClose={() => setShowDetails(false)} />}
      {showPlugins && <PluginPanel plugins={plugins} hostPlugins={hostPlugins} hostBusy={hostPluginBusy}
        drafts={pluginDrafts} draftReport={pluginDraftReport}
        onCreateDraft={(manifestJson, source) => void createPluginDraft(manifestJson, source)}
        onDiagnoseDraft={draftId => void diagnosePluginDraft(draftId)}
        onInstallDraft={draftId => void installPluginDraft(draftId)}
        onHostToggle={plugin => void toggleHostPlugin(plugin)} onToggle={plugin => void togglePlugin(plugin)} onClose={() => setShowPlugins(false)} />}
      {showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} onCreate={createConversation} />}
      {showSettings && <ModelSettingsPanel snapshot={modelSettings} onClose={() => setShowSettings(false)} onSave={saveModelSettings} onClearKey={clearModelKey} />}
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
    <article className={`message-row ${own ? 'own' : ''} ${compact ? 'compact' : ''} status-${message.status}`}>
      {!own && <span className="message-avatar">{message.senderAvatar}</span>}
      <div className="message-content">
        {!compact && !own && <span className="sender-name">{message.senderName}</span>}
        <div className="bubble"><p>{displayText(message)}</p><span className="bubble-meta">{messageMeta(message)}</span></div>
      </div>
    </article>
  )
}

function DetailsPanel({ conversation, transportName, modelLabel, onClose }: { conversation: Conversation; transportName: string; modelLabel?: string; onClose: () => void }) {
  return (
    <aside className="details-panel">
      <div className="details-header"><strong>会话详情</strong><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
      <div className="details-profile"><Avatar conversation={conversation} /><h2>{conversation.title}</h2><p>{conversation.subtitle}</p></div>
      <div className="details-actions"><button><Search size={18} /><span>搜索</span></button><button><Bot size={18} /><span>AI 总结</span></button><button><MoreHorizontal size={18} /><span>更多</span></button></div>
      <div className="details-card"><div><span>传输插件</span><strong>{transportName}</strong></div>{modelLabel && <div><span>模型</span><strong>{modelLabel}</strong></div>}<div><span>消息存储</span><strong>此设备</strong></div><div><span>端到端加密</span><strong className="muted">尚未启用</strong></div></div>
      <div className="details-note"><PlugZap size={17} /><p>这块区域也是 UI Slot。未来插件可以添加成员面板、任务或知识库。</p></div>
    </aside>
  )
}

function PluginPanel({ plugins, hostPlugins, hostBusy, drafts, draftReport, onCreateDraft, onDiagnoseDraft, onInstallDraft, onHostToggle, onToggle, onClose }: {
  plugins: readonly PluginSnapshot[]; hostPlugins: readonly HostPluginSnapshot[]; hostBusy: boolean;
  drafts: PluginDraftInspection | null; draftReport: string | null;
  onCreateDraft: (manifestJson: string, source: string) => void; onDiagnoseDraft: (draftId: string) => void;
  onInstallDraft: (draftId: string) => void;
  onHostToggle: (plugin: HostPluginSnapshot) => void; onToggle: (plugin: PluginSnapshot) => void; onClose: () => void;
}) {
  const [manifestJson, setManifestJson] = useState('')
  const [source, setSource] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="plugin-drawer" onMouseDown={event => event.stopPropagation()}>
        <div className="drawer-header"><div><p className="eyebrow">运行时</p><h2>插件</h2></div><button className="icon-button" onClick={onClose}><X /></button></div>
        <div className="plugin-list">
          {plugins.map(plugin => {
            const busy = plugin.status === 'activating' || plugin.status === 'deactivating'
            const active = plugin.status === 'active'
            return (
              <div className={`plugin-card ${plugin.status === 'failed' ? 'failed' : ''}`} key={plugin.manifest.id}>
                <span className="plugin-icon">{plugin.manifest.id === 'builtin.local-demo' ? <MessageCircleMore /> : <Sparkles />}</span>
                <div className="plugin-copy">
                  <strong>{plugin.manifest.displayName}</strong>
                  <p>{plugin.manifest.description}</p>
                  <small>{plugin.manifest.id} · {plugin.manifest.version} · {plugin.manifest.targets.join(', ')}</small>
                  {plugin.error && <span className="plugin-error">{plugin.error}</span>}
                </div>
                <button className={`plugin-toggle ${active ? 'active' : ''}`} disabled={busy} onClick={() => onToggle(plugin)}>
                  {busy ? '处理中' : active ? '停用' : '启用'}
                </button>
              </div>
            )
          })}
          {hostPlugins.map(plugin => (
            <div className={`plugin-card host-plugin-card ${plugin.status === 'failed' ? 'failed' : ''}`} key={plugin.id} data-plugin-id={plugin.id}>
              <span className="plugin-icon"><Server /></span>
              <div className="plugin-copy">
                <strong>{plugin.displayName}</strong><p>{plugin.description}</p>
                <small>{plugin.id} · {plugin.version} · 独立后台进程</small>
                {plugin.error && <span className="plugin-error">{plugin.error}</span>}
              </div>
              <button className={`plugin-toggle ${plugin.status === 'active' ? 'active' : ''}`}
                disabled={hostBusy || plugin.status === 'activating' || plugin.status === 'deactivating'} onClick={() => onHostToggle(plugin)}>
                {hostBusy ? '处理中' : plugin.status === 'active' ? '停用' : '启用'}
              </button>
            </div>
          ))}
        </div>
        <section className="draft-section">
          <div><p className="eyebrow">未安装</p><h3>插件草稿</h3></div>
          <p className="settings-note">确认后可以安装固定 JSON 形状的文本工具或输入框动作。源码不会执行。安装后可立即使用和停用。文本工具会在 Host 重启后保留；输入框动作只在本次 Host 运行期间保留。再次确认文本工具会写入新版本，更新失败时仍使用上一版本。</p>
          {(drafts?.drafts ?? []).map(item => {
            const installed = hostPlugins.some(plugin => plugin.id === item.id)
            return (
            <div className="draft-card" key={item.id} data-draft-id={item.id} data-draft-installed={installed ? 'true' : 'false'} data-draft-ok={item.ok ? 'true' : 'false'}>
              <strong>{item.displayName}</strong>
              <small>{item.id} · r{item.revision} · {installed ? '已安装' : '未安装'} · {item.ok ? '校验通过' : '校验未通过'}</small>
              <div className="draft-actions">
                <button type="button" className="secondary-button" data-draft-diagnose disabled={hostBusy} onClick={() => onDiagnoseDraft(item.id)}>诊断</button>
                {confirmId === item.id ? (
                  <div className="draft-confirm" data-draft-confirm={item.id}>
                    <p>{installed
                      ? '确认用这份草稿更新？失败会保留当前版本。源码不会被执行。'
                      : '确认安装这个声明式文本工具或输入框动作？源码不会被执行。'}</p>
                    <div className="draft-actions">
                      <button type="button" className="secondary-button" data-draft-confirm-cancel disabled={hostBusy} onClick={() => setConfirmId(null)}>取消</button>
                      <button type="button" className="secondary-button" data-draft-confirm-ok disabled={hostBusy} onClick={() => { setConfirmId(null); onInstallDraft(item.id) }}>{installed ? '确认更新' : '确认安装'}</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="secondary-button" {...(installed ? { 'data-draft-update': 'true' } : { 'data-draft-install': 'true' })} disabled={hostBusy} onClick={() => setConfirmId(item.id)}>{installed ? '更新' : '安装'}</button>
                )}
              </div>
            </div>
            )
          })}
          {drafts && drafts.drafts.length === 0 && <p className="settings-note">还没有草稿。</p>}
          <label className="settings-field"><span>Manifest JSON</span>
            <textarea data-draft-field="manifest" value={manifestJson} onChange={event => setManifestJson(event.target.value)} spellCheck={false} />
          </label>
          <label className="settings-field"><span>源码</span>
            <textarea data-draft-field="source" value={source} onChange={event => setSource(event.target.value)} spellCheck={false} />
          </label>
          <button type="button" className="primary-button" disabled={hostBusy || !manifestJson.trim()} onClick={() => onCreateDraft(manifestJson, source)}>创建草稿</button>
          {draftReport && <p className="draft-report">{draftReport}</p>}
        </section>
        <div className="plugin-empty"><PlugZap /><h3>可信插件模式</h3><p>示例插件经过版本化 manifest 和生命周期运行时接入。任意磁盘代码将在独立进程与权限代理完成后开放。</p></div>
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
        <div className="kind-picker">
          <button type="button" className={kind === 'direct' ? 'active' : ''} onClick={() => setKind('direct')}><MessageCircleMore />单聊</button>
          <button type="button" className={kind === 'group' ? 'active' : ''} onClick={() => setKind('group')}><Users />群聊</button>
          <button type="button" className={kind === 'assistant' ? 'active' : ''} onClick={() => setKind('assistant')}><Bot />AI</button>
        </div>
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()}>创建会话</button></div>
      </form>
    </div>
  )
}

function ModelSettingsPanel({ snapshot, onClose, onSave, onClearKey }: {
  snapshot: ModelSettingsSnapshot | null
  onClose: () => void
  onSave: (input: ModelSettingsInput) => Promise<void>
  onClearKey: () => Promise<void>
}) {
  const [baseUrl, setBaseUrl] = useState(snapshot?.baseUrl ?? 'https://api.deepseek.com')
  const [model, setModel] = useState(snapshot?.model ?? 'deepseek-chat')
  const [providerMode, setProviderMode] = useState<ModelProviderMode>(snapshot?.providerMode ?? 'mock')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!snapshot) return
    setBaseUrl(snapshot.baseUrl)
    setModel(snapshot.model)
    setProviderMode(snapshot.providerMode)
  }, [snapshot])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!snapshot) return
    setBusy(true)
    setError(null)
    try {
      await onSave({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        providerMode,
        ...(apiKey.trim() ? { apiKey } : {}),
      })
      setApiKey('')
    }
    catch (caught) {
      setError(errorText(caught))
    }
    finally {
      setBusy(false)
    }
  }

  async function clearKey() {
    setBusy(true)
    setError(null)
    try {
      await onClearKey()
      setApiKey('')
    }
    catch (caught) {
      setError(errorText(caught))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <form className="plugin-drawer settings-drawer" onSubmit={event => void submit(event)} onMouseDown={event => event.stopPropagation()} data-provider-mode={providerMode} data-has-api-key={snapshot?.hasApiKey ? 'true' : 'false'}>
        <div className="drawer-header"><h2>模型设置</h2><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></div>
        <p className="settings-note">API Key 只写入 PC Host 的本机凭据文件。界面只知道是否已保存，聊天记录、日志和插件都拿不到原始密钥。</p>
        <label className="settings-field"><span>提供方</span>
          <select value={providerMode} onChange={event => setProviderMode(event.target.value as ModelProviderMode)}>
            <option value="mock">模拟（不访问网络）</option>
            <option value="openai-compatible">OpenAI 兼容 / DeepSeek</option>
          </select>
        </label>
        <label className="settings-field"><span>Base URL</span>
          <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com" autoComplete="off" spellCheck={false} />
        </label>
        <label className="settings-field"><span>模型</span>
          <input value={model} onChange={event => setModel(event.target.value)} placeholder="deepseek-chat" autoComplete="off" spellCheck={false} />
        </label>
        <label className="settings-field"><span>API Key</span>
          <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={snapshot?.hasApiKey ? '已保存，留空则不修改' : '未设置'} autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="settings-error">{error}</p>}
        <div className="dialog-actions">
          {snapshot?.hasApiKey && <button type="button" className="secondary-button" disabled={busy} onClick={() => void clearKey()}>删除密钥</button>}
          <button className="primary-button" disabled={busy || !snapshot || !baseUrl.trim() || !model.trim()}>{busy ? '保存中' : '保存'}</button>
        </div>
      </form>
    </div>
  )
}

function modelSubtitle(settings: ModelSettingsSnapshot | null): string {
  if (!settings) return '正在连接模型'
  if (settings.providerMode === 'mock') return '模拟回复 · 未调用网络'
  return settings.hasApiKey ? settings.model : `${settings.model} · 未保存密钥`
}

function displayText(message: ChatMessage): string {
  if (message.text) return message.text
  if (message.status === 'streaming') return '正在生成…'
  if (message.status === 'cancelled') return '回复已取消。'
  if (message.status === 'failed') return '回复没有完成。'
  return ''
}

function messageMeta(message: ChatMessage): string {
  const time = formatRelativeTime(message.createdAt)
  if (message.status === 'streaming') return `${time} · 生成中`
  if (message.status === 'cancelled') return `${time} · 已取消`
  if (message.status === 'failed') return `${time} · 失败`
  if (message.role === 'self' && message.status === 'sending') return `${time} · 发送中`
  if (message.role === 'self') return `${time} ✓`
  return time
}

function errorText(error: unknown): string {
  const message = error instanceof Error && error.message.trim() ? error.message : '模型请求失败'
  return message.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240)
}

function toModelUpdate(event: ModelClientEvent): ModelChatUpdate {
  const identity = { conversationId: event.conversationId, assistantMessageId: event.assistantMessageId }
  switch (event.type) {
    case 'delta':
      return { type: 'delta', ...identity, textDelta: event.textDelta ?? '' }
    case 'completed':
      return { type: 'completed', ...identity, text: event.text ?? '' }
    case 'failed':
      return { type: 'failed', ...identity, partialText: event.partialText ?? '' }
    case 'cancelled':
      return { type: 'cancelled', ...identity, partialText: event.partialText ?? '' }
  }
}

function applyIncomingModelEvent(state: ChatState, event: ModelClientEvent, pending: ModelClientEvent[]): ChatState {
  const list = state.messages[event.conversationId] ?? []
  if (!list.some(message => message.id === event.assistantMessageId)) {
    pending.push(event)
    return state
  }
  return applyModelChatUpdate(state, toModelUpdate(event))
}

function drainModelEvents(state: ChatState, pending: ModelClientEvent[]): ChatState {
  if (pending.length === 0) return state
  const queued = pending.splice(0, pending.length)
  return queued.reduce((current, event) => applyModelChatUpdate(current, toModelUpdate(event)), state)
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="loading-mark">M</div><p>正在恢复会话…</p></div>
}

function hostStatusLabel(status: HostStatusSnapshot): string {
  switch (status.state) {
    case 'starting': return 'Host 连接中'
    case 'ready': return 'Host 已连接'
    case 'restarting': return 'Host 重连中'
    case 'failed': return 'Host 不可用'
    case 'stopped': return 'Host 已停止'
  }
}
