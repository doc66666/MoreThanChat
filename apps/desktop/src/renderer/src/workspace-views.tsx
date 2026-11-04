import { UI_SLOTS, type UiSlot as UiSlotName } from '@more-than-chat/central-protocol'
import { formatMessageDay, formatRelativeTime } from '@more-than-chat/chat-core'
import {
  ArrowDown,
  ArrowUpRight,
  BellOff,
  Bot,
  ChevronDown,
  CircleHelp,
  FileText,
  Info,
  MessageCircleMore,
  Moon,
  PencilLine,
  Pin,
  PlugZap,
  Reply,
  Search,
  Server,
  Settings,
  Sparkles,
  Sun,
  Users,
  X,
} from 'lucide-react'
import { ChatComposer } from './ChatComposer'
import { ContactsPanel } from './ContactsPanel'
import { GroupManager } from './GroupManager'
import { HistoryNotice } from './HistoryNotice'
import { MessageActionDialog } from './MessageActionDialog'
import { MessageSearch } from './MessageSearch'
import { NetworkPanel } from './NetworkPanel'
import { SharedPluginChoices } from './SharedClientPlugins'
import { UiSlot } from './UiSlot'
import { UserProfile } from './UserProfile'
import { appApi } from './app-api'
import { avatarTone, conversationPreview } from './conversation-presentation'
import { slotLabels } from './group-plugin-presentation'
import { transportRegistry } from './plugin-host'
import { setThemePreference } from './theme'
import {
  Avatar,
  DetailsPanel,
  MessageBubble,
  ModelSettingsPanel,
  NewChatDialog,
  PluginPanel,
  RailButton,
  hostStatusLabel,
  modelSubtitle,
} from './workspace-components'
import type { WorkspaceViewContext } from './workspace-controller'
type ViewProps = {
  context: WorkspaceViewContext
  renderSurface: (name: string, context?: unknown, fallback?: unknown) => React.ReactNode
}
export function WorkspaceChromeView({ context, renderSurface }: ViewProps) {
  const { hostStatus, pingHost, serverState, setShowServer, state } = context
  return (
    <>
      <div className="window-drag-region">
        <span className="window-title">
          MoreThanChat <span className="window-title-caption">让对话，不止于聊天</span>
        </span>
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
        <button
          className="server-status"
          data-central-state={serverState?.status ?? 'disconnected'}
          title={serverState?.error ?? serverState?.address}
          onClick={() => setShowServer(true)}
        >
          {serverState?.status === 'connected'
            ? '中心已连接'
            : serverState?.status === 'connecting'
              ? '中心连接中'
              : serverState?.status === 'error'
                ? '中心连接异常'
                : '中心未连接'}
        </button>
      </div>
    </>
  )
}

export function WorkspaceNavigationView({ context, renderSurface }: ViewProps) {
  const {
    active,
    appearance,
    createConversation,
    openProfile,
    profileTarget,
    readyState,
    renderSlot,
    selectConversation,
    serverState,
    setConversationFilter,
    setProfileTarget,
    setQuery,
    setShowContacts,
    setShowPlugins,
    setShowServer,
    setShowSettings,
    setToast,
    showContacts,
    showPlugins,
    showServer,
    showSettings,
  } = context
  return (
    <>
      <nav className="app-rail" aria-label="主导航">
        <button
          className="brand-mark"
          aria-label="MoreThanChat · 身份与昵称"
          title="身份、昵称与服务器设置"
          onClick={() => setShowServer(true)}
        >
          <img src="mtc-icon.svg" alt="MTC" width="44" height="44" />
        </button>
        <div className="rail-actions">
          <RailButton
            active={!showServer && !showContacts && !profileTarget && !showPlugins && !showSettings}
            icon={<MessageCircleMore />}
            label="聊天"
            onClick={() => {
              setShowServer(false)
              setShowContacts(false)
              setProfileTarget(null)
              setShowPlugins(false)
              setShowSettings(false)
              setConversationFilter('all')
              setQuery('')
            }}
          />
          <RailButton
            icon={<Bot />}
            label="AI 助手"
            onClick={() => {
              const assistant = readyState.conversations.find((item) => item.kind === 'assistant')
              setQuery('')
              setConversationFilter('all')
              if (assistant) selectConversation(assistant.id)
              else createConversation('新的 AI 对话', 'assistant')
            }}
          />
          <RailButton
            icon={<Users />}
            label="联系人"
            active={showContacts}
            onClick={() => setShowContacts(true)}
          />
          <RailButton
            icon={<PlugZap />}
            label="插件"
            active={showPlugins}
            onClick={() => setShowPlugins(true)}
          />
        </div>
        <div className="rail-bottom">
          <RailButton
            icon={appearance.resolved === 'dark' ? <Sun /> : <Moon />}
            label={appearance.resolved === 'dark' ? '白天模式' : '夜间模式'}
            onClick={() => setThemePreference(appearance.resolved === 'dark' ? 'light' : 'dark')}
          />
          <RailButton
            icon={<CircleHelp />}
            label="帮助"
            onClick={() =>
              setToast(
                '添加好友：打开联系人并连接同一服务器；使用 AI：在设置中配置模型；Ctrl / ⌘ + K 搜索会话。',
              )
            }
          />
          <RailButton
            icon={<Settings />}
            label="设置"
            active={showSettings}
            onClick={() => setShowSettings(true)}
          />
          <button
            className="profile-avatar"
            data-avatar-tone={readyState.profile.avatarColor ?? avatarTone(readyState.profile.id)}
            title="我的主页"
            aria-label="我的主页"
            disabled={!serverState}
            onClick={() => {
              if (serverState)
                openProfile(
                  serverState.directory?.self ?? {
                    id: serverState.userId,
                    displayName: serverState.displayName,
                    online: false,
                    avatarColor: readyState.profile.avatarColor ?? null,
                  },
                )
            }}
          >
            {readyState.profile.avatar}
            <span className="online-dot" data-online={serverState?.status === 'connected'} />
          </button>
        </div>
        {renderSlot('app.rail')}
      </nav>
    </>
  )
}

export function WorkspaceConversationsView({ context, renderSurface }: ViewProps) {
  const {
    active,
    conversationFilter,
    conversationSearch,
    filtered,
    messages,
    query,
    renderSlot,
    selectConversation,
    serverState,
    setConversationFilter,
    setQuery,
    setShowNewChat,
    setShowServer,
    state,
  } = context
  return (
    <>
      <aside className="conversation-sidebar">
        <div className="sidebar-heading">
          <div>
            <p className="eyebrow">你的交流空间</p>
            <button
              className="workspace-name"
              title="管理身份与中心服务器"
              onClick={() => setShowServer(true)}
            >
              消息 <ChevronDown size={16} />
            </button>
          </div>
          <button
            className="icon-button prominent"
            title="新建会话"
            onClick={() => setShowNewChat(true)}
          >
            <PencilLine size={18} />
          </button>
        </div>
        <label className="search-box">
          <Search size={17} />
          <input
            ref={conversationSearch}
            aria-label="搜索会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
          />
          {query ? (
            <button
              className="search-clear"
              type="button"
              aria-label="清除会话搜索"
              onClick={() => {
                setQuery('')
                conversationSearch.current?.focus()
              }}
            >
              <X size={14} />
            </button>
          ) : (
            <kbd>{navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K'}</kbd>
          )}
        </label>
        <div className="conversation-filters" role="group" aria-label="会话筛选">
          {(
            [
              ['all', '全部'],
              ['unread', '未读'],
              ['direct', '好友'],
              ['group', '群聊'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-conversation-filter={value}
              aria-pressed={conversationFilter === value}
              onClick={() => setConversationFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="conversation-section-label">
          <span>
            {query ? '搜索结果' : conversationFilter === 'unread' ? '未读会话' : '会话列表'}
          </span>
          <span>{filtered.length} 个会话</span>
        </div>
        <div className="conversation-list">
          {filtered.map((item) => {
            const last = state.messages[item.id]?.at(-1)
            return (
              <button
                key={item.id}
                data-conversation-id={item.id}
                className={`conversation-item ${item.id === active.id ? 'active' : ''}`}
                aria-current={item.id === active.id ? 'true' : undefined}
                onClick={() => selectConversation(item.id)}
              >
                <Avatar conversation={item} />
                <span className="conversation-copy">
                  <span className="conversation-title-row">
                    <strong>{item.title}</strong>
                    {item.pinned && (
                      <Pin size={11} className="conversation-pin" aria-label="已置顶" />
                    )}
                    <time>{formatRelativeTime(item.updatedAt)}</time>
                  </span>
                  <span className="conversation-preview-row">
                    <span>
                      {item.muted && <BellOff size={11} />} {conversationPreview(last)}
                    </span>
                    {item.unread > 0 && (
                      <b className={item.muted ? 'muted-unread' : ''}>
                        {item.unread > 99 ? '99+' : item.unread}
                      </b>
                    )}
                  </span>
                </span>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="empty-search">
              <Search size={26} />
              <strong>
                {query
                  ? '没有找到相关会话'
                  : conversationFilter === 'unread'
                    ? '消息都看过了'
                    : '这里还没有会话'}
              </strong>
              <p>{query ? '换个关键词试试' : '新消息会出现在这里'}</p>
            </div>
          )}
        </div>
        {renderSlot('app.sidebar')}
        <button className="sidebar-connect" onClick={() => setShowServer(true)}>
          <span className="sidebar-connect-icon">
            <Server size={17} />
          </span>
          <span>
            <strong>
              {serverState?.status === 'connected' ? '已连接中心服务器' : '连接你的好友'}
            </strong>
            <small>
              {serverState?.status === 'connected' ? '管理联系人与群聊' : '设置服务器，开始聊天'}
            </small>
          </span>
          <ArrowUpRight size={15} />
        </button>
      </aside>
    </>
  )
}

export function WorkspaceChatHeaderView({ context, renderSurface }: ViewProps) {
  const {
    active,
    hostStatus,
    membersById,
    modelSettings,
    openProfile,
    serverState,
    setShowDetails,
    setShowMessageSearch,
    showDetails,
    state,
  } = context
  return (
    <>
      <header className="chat-header">
        <div
          className="chat-identity"
          data-model-mode={
            active.kind === 'assistant' ? (modelSettings?.providerMode ?? 'unknown') : 'chat'
          }
        >
          {active.kind === 'direct' &&
          active.serverId === serverState?.serverId &&
          active.targetId ? (
            <button
              className="profile-avatar-link"
              title="查看个人主页"
              aria-label={`查看 ${active.title} 的主页`}
              data-header-profile
              onClick={() =>
                openProfile(
                  membersById.get(active.targetId!) ?? {
                    id: active.targetId!,
                    displayName: active.title,
                    online: false,
                  },
                )
              }
            >
              <Avatar conversation={active} small />
            </button>
          ) : (
            <Avatar conversation={active} small />
          )}
          <div>
            <h1>{active.title}</h1>
            <p>
              <span
                className="status-dot"
                data-connected={
                  active.kind === 'assistant'
                    ? hostStatus.state === 'ready'
                    : serverState?.status === 'connected'
                }
              />{' '}
              {active.kind === 'assistant' ? modelSubtitle(modelSettings) : active.subtitle}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="搜索聊天记录"
            onClick={() => setShowMessageSearch(true)}
          >
            <Search size={18} />
          </button>
          <button
            className="header-plugin-button"
            title="会话插件"
            aria-controls="conversation-details"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(true)}
          >
            <PlugZap size={17} />
            <span>插件</span>
          </button>
          <span className="header-divider" />
          <button
            className={`icon-button ${showDetails ? 'selected' : ''}`}
            title="会话详情"
            aria-expanded={showDetails}
            aria-controls="conversation-details"
            onClick={() => setShowDetails((value) => !value)}
          >
            <Info size={19} />
          </button>
        </div>
      </header>
    </>
  )
}

export function WorkspaceChatNoticesView({ context, renderSurface }: ViewProps) {
  const {
    active,
    entryUnread,
    historyBusy,
    historyFailure,
    loadHistory,
    locateUnread,
    renderSlot,
    returnToLatest,
    setEntryUnread,
  } = context
  return (
    <>
      <div className="chat-header-plugins">
        {(entryUnread?.id === active.id || active.unread > 0) && (
          <div className="unread-entry" data-unread-entry>
            <button onClick={() => void locateUnread()}>
              {active.unread > 0
                ? `${active.unread} 条新消息`
                : `进入时有 ${entryUnread?.count ?? 0} 条未读`}{' '}
              · 定位最早未读消息
            </button>
            {active.unread === 0 && entryUnread?.id === active.id && (
              <button aria-label="关闭未读起点提示" onClick={() => setEntryUnread(null)}>
                ×
              </button>
            )}
          </div>
        )}
        <HistoryNotice
          busy={historyBusy}
          error={historyFailure?.conversationId === active.id ? historyFailure.error : ''}
          onRetry={() => {
            if (historyFailure)
              void loadHistory(historyFailure.conversationId, historyFailure.input)
          }}
          onLatest={returnToLatest}
        />
        {renderSlot('chat.header')}
      </div>
    </>
  )
}

export function WorkspaceChatTimelineView({ context, renderSurface }: ViewProps) {
  const {
    active,
    canRetryLast,
    chatDraft,
    highlightMessage,
    historic,
    historyBusy,
    lastMessage,
    loadHistory,
    membersById,
    openProfile,
    reading,
    renderSlot,
    resendMessage,
    resending,
    returnToLatest,
    sendAssistantMessage,
    serverState,
    setDraft,
    setForwardDialog,
    setRetractConfirm,
    setToast,
    state,
    visibleMessages,
  } = context
  return (
    <>
      <section
        className="message-scroll"
        aria-live="polite"
        ref={reading.bindScroll}
        onScroll={reading.onScroll}
      >
        <div ref={reading.bindContent} className="message-timeline">
          {(historic?.hasOlder ?? state.history?.[active.id]?.hasOlder) && (
            <button
              className="history-more"
              data-history-older
              disabled={historyBusy}
              onClick={() =>
                void loadHistory(active.id, {
                  before: (historic?.before ?? state.history?.[active.id]?.before)!,
                })
              }
            >
              {historyBusy ? '加载中…' : '查看更早的消息'}
            </button>
          )}
          {historic && (
            <button className="history-more" data-history-latest onClick={returnToLatest}>
              正在浏览历史 · 返回最新消息{active.unread > 0 ? ' · ' + active.unread : ''}
            </button>
          )}
          {visibleMessages.length === 0 ? (
            <div className="empty-conversation">
              <div className="empty-icon">
                {active.kind === 'assistant' ? <Bot size={30} /> : <MessageCircleMore size={30} />}
              </div>
              <span className="empty-kicker">
                {active.kind === 'assistant' ? 'AI 工作空间' : '新的对话'}
              </span>
              <h2>{active.kind === 'assistant' ? '聊一聊，也做点新东西。' : '从一句问候开始'}</h2>
              <p>
                {active.kind === 'assistant'
                  ? '整理聊天记录，讨论一个想法，或者一起写个新插件。'
                  : '文字、图片、文件与语音，把想说的分享给对方。'}
              </p>
              {active.kind === 'assistant' && (
                <div className="assistant-starters">
                  {[
                    {
                      title: '整理聊天',
                      description: '梳理最近的对话，找出重点',
                      prompt: '帮我总结最近的聊天',
                      icon: FileText,
                    },
                    {
                      title: '创造一个插件',
                      description: '把需要的功能，放进你的聊天空间',
                      prompt: '一起设计一个群聊插件',
                      icon: PlugZap,
                    },
                    {
                      title: '了解你的助手',
                      description: '看看这里可以一起做些什么',
                      prompt: '你可以帮我做什么？',
                      icon: MessageCircleMore,
                    },
                  ].map(({ title, description, prompt, icon: Icon }) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setDraft(prompt)
                        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
                      }}
                    >
                      <Icon size={19} />
                      <span className="starter-copy">
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            visibleMessages.map((message, index, visible) => (
              <div key={message.id}>
                {(index === 0 ||
                  new Date(visible[index - 1]!.createdAt).toDateString() !==
                    new Date(message.createdAt).toDateString()) && (
                  <div className="message-day">
                    <span>{formatMessageDay(message.createdAt)}</span>
                  </div>
                )}
                {renderSlot('chat.message.before', message)}
                <MessageBubble
                  message={message}
                  avatarColor={
                    message.serverId === serverState?.serverId
                      ? membersById.get(message.senderId)?.avatarColor
                      : undefined
                  }
                  onProfile={
                    message.serverId && message.serverId === serverState?.serverId
                      ? () =>
                          openProfile(
                            membersById.get(message.senderId) ?? {
                              id: message.senderId,
                              displayName: message.senderName,
                              online: false,
                            },
                          )
                      : undefined
                  }
                  compact={visible[index - 1]?.senderId === message.senderId}
                  highlighted={highlightMessage === message.id}
                  onCopy={() =>
                    void appApi
                      .copyChatMessage(message.id)
                      .then(() => setToast('已复制'))
                      .catch((e) => setToast(e.message))
                  }
                  resending={resending.has(message.id)}
                  onResend={
                    message.serverId &&
                    !active.unavailable &&
                    message.role === 'self' &&
                    ['failed', 'queued'].includes(message.status)
                      ? () => void resendMessage(message)
                      : undefined
                  }
                  onQuote={
                    message.serverId &&
                    message.actionsSupported &&
                    message.status === 'sent' &&
                    !active.unavailable
                      ? () => {
                          chatDraft.setQuoteMessageId(message.id)
                          requestAnimationFrame(() =>
                            document
                              .querySelector<HTMLTextAreaElement>('.composer textarea')
                              ?.focus(),
                          )
                        }
                      : undefined
                  }
                  onForward={
                    message.serverId && message.actionsSupported && message.status === 'sent'
                      ? () => setForwardDialog({ message })
                      : undefined
                  }
                  onRetract={
                    message.serverId &&
                    message.actionsSupported &&
                    message.role === 'self' &&
                    message.status === 'sent' &&
                    Date.now() - message.createdAt <= 120000
                      ? () => setRetractConfirm(message)
                      : undefined
                  }
                  onLocateQuote={
                    message.quote && !message.quote.retracted
                      ? () => void loadHistory(active.id, { around: message.quote!.messageId })
                      : undefined
                  }
                  onRetry={
                    canRetryLast && message.id === lastMessage?.id
                      ? () => void sendAssistantMessage(message.text, message)
                      : undefined
                  }
                />
                {renderSlot('chat.message.after', message)}
              </div>
            ))
          )}
          {historic?.hasNewer && (
            <button
              className="history-more"
              data-history-newer
              disabled={historyBusy}
              onClick={() => void loadHistory(active.id, { after: historic.after! })}
            >
              查看较新的消息
            </button>
          )}
          <div ref={reading.endRef} />
        </div>
      </section>
    </>
  )
}

export function WorkspaceChatLatestView({ context, renderSurface }: ViewProps) {
  const { active, historyPositioning, reading, returnToLatest } = context
  return (
    <>
      {(!reading.atBottom || historyPositioning) && (
        <button className="jump-latest" onClick={returnToLatest}>
          <ArrowDown size={15} />
          回到最新消息{active.unread > 0 ? ' · ' + active.unread : ''}
        </button>
      )}
    </>
  )
}

export function WorkspaceChatComposerView({ context, renderSurface }: ViewProps) {
  const {
    active,
    cancelGeneration,
    chatDraft,
    composerActions,
    draft,
    hostPluginBusy,
    hostPlugins,
    messages,
    pendingAttachment,
    quotedMessage,
    renderSlot,
    runComposerAction,
    runHostTool,
    sendMessage,
    serverState,
    setDraft,
    setPendingAttachment,
    setToast,
    slotContext,
    slotEntries,
  } = context
  return (
    <>
      <footer
        className="composer-wrap"
        data-generating={
          messages.some((message) => message.status === 'streaming') ? 'true' : 'false'
        }
      >
        {renderSlot('chat.composer.before')}
        {chatDraft.error && <p className="settings-error">草稿未能保存到设备，请检查可用空间。</p>}
        {active.serverId &&
          (active.unavailable ||
            active.serverId !== serverState?.serverId ||
            serverState.status !== 'connected') && (
            <p className="connection-note">
              {active.unavailable
                ? '当前联系人或群已不可用。聊天记录仍保留。'
                : '当前未连接此会话的服务器，发送的消息会保存在本机队列，连接恢复后自动发送。'}
            </p>
          )}
        <div
          style={{
            display: slotEntries.some((entry) => entry.contribution.slot === 'chat.composer')
              ? 'none'
              : undefined,
          }}
        >
          {active.serverId && active.unavailable ? (
            <div className="composer" data-history-readonly>
              <p className="settings-note">
                好友或群关系已结束。这是保留在本机的只读历史，不能发送新消息。
              </p>
            </div>
          ) : (
            <ChatComposer
              reference={
                quotedMessage && (
                  <div className="composer-quote" data-composer-quote={quotedMessage.id}>
                    <Reply size={16} />
                    <div>
                      <strong>回复 {quotedMessage.senderName}</strong>
                      <p>
                        {quotedMessage.text.slice(0, 180) ||
                          quotedMessage.attachment?.name ||
                          '消息'}
                      </p>
                    </div>
                    <button
                      className="icon-button"
                      title="取消引用"
                      data-clear-quote
                      onClick={() => chatDraft.setQuoteMessageId(null)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                )
              }
              key={active.id}
              draft={draft}
              setDraft={setDraft}
              onSend={() => sendMessage()}
              onVoice={async (ref) => {
                setPendingAttachment(ref)
                await sendMessage(ref)
              }}
              onError={setToast}
              canAttach={active.transportId === 'builtin.central' && !active.unavailable}
              generating={messages.some((message) => message.status === 'streaming')}
              onCancel={() => void cancelGeneration()}
              title={active.title}
              attachment={pendingAttachment}
              onAttachment={setPendingAttachment}
              clearAttachment={() => setPendingAttachment(null)}
            >
              {composerActions.map(({ ownerId, contribution }) => (
                <button
                  key={`${ownerId}:${contribution.id}`}
                  className="plugin-composer-action"
                  title={contribution.description}
                  onClick={() => void runComposerAction(contribution)}
                >
                  <Sparkles size={16} />
                  <span>{contribution.label}</span>
                </button>
              ))}
              {hostPlugins
                .filter((plugin) => plugin.status === 'active')
                .flatMap((plugin) =>
                  plugin.composerActions.map((action) => (
                    <button
                      key={`${plugin.id}:${action.id}`}
                      className="plugin-composer-action declarative-composer-action"
                      data-plugin-id={plugin.id}
                      data-action-id={action.id}
                      disabled={hostPluginBusy}
                      title={plugin.description}
                      onClick={() => void runHostTool(plugin.id, action.id, action.label)}
                    >
                      <Sparkles size={16} />
                      <span>{action.label}</span>
                    </button>
                  )),
                )}
              {hostPlugins
                .filter((plugin) => plugin.status === 'active')
                .flatMap((plugin) =>
                  plugin.tools.map((tool) => (
                    <button
                      key={`${plugin.id}:${tool.id}`}
                      className="plugin-composer-action host-tool-action"
                      data-plugin-id={plugin.id}
                      data-tool-id={tool.id}
                      disabled={hostPluginBusy}
                      title={plugin.description}
                      onClick={() => void runHostTool(plugin.id, tool.id, tool.label)}
                    >
                      <Server size={16} />
                      <span>{tool.label}</span>
                    </button>
                  )),
                )}
            </ChatComposer>
          )}
        </div>
        <UiSlot
          name="chat.composer"
          entries={slotEntries}
          context={slotContext}
          fallback={
            <div>
              <p className="settings-error">自定义输入区加载失败，可停用插件恢复默认输入区。</p>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button onClick={() => void sendMessage()}>发送</button>
            </div>
          }
        />
        {renderSlot('chat.composer.after')}
      </footer>
    </>
  )
}

export function WorkspaceChatView({ context, renderSurface }: ViewProps) {
  const { active } = context
  return (
    <>
      <main className="chat-panel" data-conversation-kind={active.kind}>
        {renderSurface('workspace.chat.header', context)}
        {renderSurface('workspace.chat.notices', context)}

        {renderSurface('workspace.chat.timeline', context)}
        {renderSurface('workspace.chat.latest', context)}

        {renderSurface('workspace.chat.composer', context)}
      </main>
    </>
  )
}

export function WorkspaceDetailsView({ context, renderSurface }: ViewProps) {
  const {
    active,
    changeConversationOptions,
    groupPluginSlot,
    modelSettings,
    openProfile,
    pluginScope,
    renderSlot,
    serverState,
    setGroupPluginSlot,
    setShowContacts,
    setShowDetails,
    setShowPlugins,
    setShowServer,
    setShowSettings,
    setToast,
    showDetails,
  } = context
  return (
    <>
      {showDetails && (
        <div className="details-with-plugins" id="conversation-details">
          <DetailsPanel
            conversation={active}
            transportName={
              active.kind === 'assistant'
                ? 'PC Host 模型'
                : (transportRegistry.get(active.transportId)?.displayName ?? '插件不可用')
            }
            {...(active.kind === 'assistant' ? { modelLabel: modelSubtitle(modelSettings) } : {})}
            onClose={() => setShowDetails(false)}
            onPlugins={() => setShowPlugins(true)}
            onSettings={() =>
              active.kind === 'assistant' ? setShowSettings(true) : setShowContacts(true)
            }
            onPin={() => void changeConversationOptions({ pinned: !active.pinned })}
            onMute={() => void changeConversationOptions({ muted: !active.muted })}
          />
          {active.kind === 'group' &&
            active.serverId === serverState?.serverId &&
            serverState?.directory &&
            serverState.directory.groups
              .filter((group) => group.id === active.targetId)
              .map((group) => (
                <GroupManager
                  key={group.id}
                  group={group}
                  directory={serverState.directory!}
                  userId={serverState.userId}
                  connected={serverState.status === 'connected'}
                  onProfile={openProfile}
                />
              ))}
          {renderSlot('chat.details')}
          {pluginScope && (
            <SharedPluginChoices snapshot={serverState} scope={pluginScope} onError={setToast} />
          )}
          {pluginScope && active.kind === 'direct' && (
            <button className="secondary-button" onClick={() => setShowPlugins(true)}>
              分享 AI 插件给好友
            </button>
          )}
          {active.kind === 'group' &&
            active.serverId &&
            serverState?.serverId === active.serverId && (
              <div className="group-plugin-controls">
                <h3>本群插件</h3>
                <p>提交申请后由群管理员批准并分发。</p>
                <button onClick={() => setShowPlugins(true)}>提交 AI 创作的群插件</button>
                <p>在 More AI 中描述插件需求，创建并校验草稿后，在插件面板选择本群提交。</p>
                {appApi.demoPluginsEnabled && (
                  <>
                    <p>以下为开发验收模板，并非 AI 创作。</p>
                    <label>
                      插件显示位置{' '}
                      <select
                        data-group-plugin-slot
                        value={groupPluginSlot}
                        onChange={(event) => setGroupPluginSlot(event.target.value as UiSlotName)}
                      >
                        {UI_SLOTS.map((slot) => (
                          <option key={slot} value={slot}>
                            {slotLabels[slot]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(['chain', 'tic-tac-toe', 'channel'] as const).map((kind) => (
                      <button
                        data-submit-plugin={kind}
                        key={kind}
                        onClick={() =>
                          void appApi
                            .serverAction('plugins/submit', {
                              groupId: active.targetId,
                              pack: {
                                id: 'gplugin_' + crypto.randomUUID(),
                                version: 1,
                                displayName:
                                  kind === 'chain'
                                    ? '群接龙'
                                    : kind === 'tic-tac-toe'
                                      ? '联机井字棋'
                                      : '群同步通道',
                                kind,
                                slot: groupPluginSlot,
                              },
                            })
                            .then(() => setToast('申请已提交，等待管理员批准'))
                            .catch((e) => setToast(e.message))
                        }
                      >
                        {kind === 'chain'
                          ? '申请接龙'
                          : kind === 'tic-tac-toe'
                            ? '申请小游戏'
                            : '申请同步通道'}
                      </button>
                    ))}
                  </>
                )}
                <button onClick={() => setShowServer(true)}>打开群管理与审批</button>
              </div>
            )}
        </div>
      )}
    </>
  )
}

export function WorkspacePluginsView({ context, renderSurface }: ViewProps) {
  const {
    createPluginDraft,
    diagnosePluginDraft,
    hostPluginBusy,
    hostPlugins,
    installPluginDraft,
    pluginDraftReport,
    pluginDrafts,
    plugins,
    serverState,
    setShowPlugins,
    showPlugins,
    toggleHostPlugin,
    togglePlugin,
  } = context
  return (
    <>
      {showPlugins && (
        <PluginPanel
          serverSnapshot={serverState}
          plugins={plugins}
          hostPlugins={hostPlugins}
          hostBusy={hostPluginBusy}
          drafts={pluginDrafts}
          draftReport={pluginDraftReport}
          onCreateDraft={(manifestJson, source) => void createPluginDraft(manifestJson, source)}
          onDiagnoseDraft={(draftId) => void diagnosePluginDraft(draftId)}
          onInstallDraft={(draftId) => void installPluginDraft(draftId)}
          onHostToggle={(plugin) => void toggleHostPlugin(plugin)}
          onToggle={(plugin) => void togglePlugin(plugin)}
          onClose={() => setShowPlugins(false)}
        />
      )}
    </>
  )
}

export function WorkspaceNewChatView({ context, renderSurface }: ViewProps) {
  const { createConversation, setShowNewChat, showNewChat } = context
  return (
    <>
      {showNewChat && (
        <NewChatDialog onClose={() => setShowNewChat(false)} onCreate={createConversation} />
      )}
    </>
  )
}

export function WorkspaceSettingsView({ context, renderSurface }: ViewProps) {
  const {
    clearModelKey,
    modelSettings,
    saveModelSettings,
    setShowServer,
    setShowSettings,
    showSettings,
  } = context
  return (
    <>
      {showSettings && (
        <>
          <ModelSettingsPanel
            snapshot={modelSettings}
            onClose={() => setShowSettings(false)}
            onSave={saveModelSettings}
            onClearKey={clearModelKey}
            onServerSettings={() => {
              setShowSettings(false)
              setShowServer(true)
            }}
          />
        </>
      )}
    </>
  )
}

export function WorkspaceForwardView({ context, renderSurface }: ViewProps) {
  const { forwardDialog, setForwardDialog, setToast, state } = context
  return (
    <>
      {forwardDialog && (
        <MessageActionDialog
          key={'forward:' + forwardDialog.message.id}
          kind="forward"
          message={forwardDialog.message}
          conversations={state.conversations}
          onClose={() => setForwardDialog(null)}
          onComplete={(notice) => {
            setForwardDialog(null)
            setToast(notice)
          }}
        />
      )}
    </>
  )
}

export function WorkspaceRetractView({ context, renderSurface }: ViewProps) {
  const { retractConfirm, setRetractConfirm, setToast, state } = context
  return (
    <>
      {retractConfirm && (
        <MessageActionDialog
          key={'retract:' + retractConfirm.id}
          kind="retract"
          message={retractConfirm}
          conversations={state.conversations}
          onClose={() => setRetractConfirm(null)}
          onComplete={(notice) => {
            setRetractConfirm(null)
            setToast(notice)
          }}
        />
      )}
    </>
  )
}

export function WorkspaceSearchView({ context, renderSurface }: ViewProps) {
  const {
    active,
    loadHistory,
    selectConversation,
    setShowMessageSearch,
    showMessageSearch,
    state,
  } = context
  return (
    <>
      {showMessageSearch && (
        <MessageSearch
          conversationId={active.id}
          title={active.title}
          conversationTitles={Object.fromEntries(state.conversations.map((c) => [c.id, c.title]))}
          onClose={() => setShowMessageSearch(false)}
          onSelect={(row) => {
            selectConversation(row.conversationId)
            setShowMessageSearch(false)
            void loadHistory(row.conversationId, { around: row.messageId })
          }}
        />
      )}
    </>
  )
}

export function WorkspaceServerView({ context, renderSurface }: ViewProps) {
  const { selectConversation, serverState, setShowServer, showServer, stateRef } = context
  return (
    <>
      {showServer && (
        <NetworkPanel
          snapshot={serverState}
          onClose={() => setShowServer(false)}
          onOpenChat={(targetId) => {
            const conversation = stateRef.current?.conversations.find(
              (item) => item.serverId === serverState?.serverId && item.targetId === targetId,
            )
            if (conversation) selectConversation(conversation.id)
          }}
        />
      )}
    </>
  )
}

export function WorkspaceContactsView({ context, renderSurface }: ViewProps) {
  const {
    openCurrentContact,
    openProfile,
    serverState,
    setShowContacts,
    setShowServer,
    showContacts,
  } = context
  return (
    <>
      {showContacts && (
        <ContactsPanel
          key={serverState?.serverId ?? 'offline'}
          snapshot={serverState}
          onClose={() => setShowContacts(false)}
          onProfile={openProfile}
          onChat={openCurrentContact}
          onManage={() => {
            setShowContacts(false)
            setShowServer(true)
          }}
        />
      )}
    </>
  )
}

export function WorkspaceProfileView({ context, renderSurface }: ViewProps) {
  const {
    openCurrentContact,
    profileTarget,
    serverState,
    setProfileTarget,
    setShowContacts,
    setShowServer,
  } = context
  return (
    <>
      {profileTarget && (
        <UserProfile
          key={`${profileTarget.serverId}:${profileTarget.user.id}`}
          target={profileTarget}
          snapshot={serverState}
          onClose={() => setProfileTarget(null)}
          onChat={openCurrentContact}
          onSettings={() => {
            setProfileTarget(null)
            setShowContacts(false)
            setShowServer(true)
          }}
        />
      )}
    </>
  )
}

export function WorkspaceToastView({ context, renderSurface }: ViewProps) {
  const { setToast, toast } = context
  return (
    <>
      {toast && (
        <div className="toast" role="status" aria-live="polite" aria-atomic="true">
          <Info size={17} aria-hidden="true" />
          <span>{toast}</span>
          <button className="icon-button" aria-label="关闭通知" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </>
  )
}

export function WorkspaceView({ context, renderSurface }: ViewProps) {
  const { renderSlot, showDetails } = context
  return (
    <>
      <div className={`app-shell ${showDetails ? '' : 'details-collapsed'}`}>
        {renderSurface('workspace.chrome', context)}

        {renderSurface('workspace.navigation', context)}

        {renderSurface('workspace.conversations', context)}

        {renderSurface('workspace.chat', context)}

        {renderSurface('workspace.details', context)}
        {renderSurface('workspace.plugins', context)}
        {renderSurface('workspace.new-chat', context)}
        {renderSurface('workspace.settings', context)}
        {renderSurface('workspace.forward', context)}
        {renderSurface('workspace.retract', context)}
        {renderSurface('workspace.search', context)}
        {renderSurface('workspace.server', context)}
        {renderSurface('workspace.contacts', context)}
        {renderSurface('workspace.profile', context)}
        {renderSlot('app.overlay')}
        {renderSurface('workspace.toast', context)}
      </div>
    </>
  )
}
export const workspaceViews = [
  { surface: 'workspace.chrome', component: WorkspaceChromeView },
  { surface: 'workspace.navigation', component: WorkspaceNavigationView },
  { surface: 'workspace.conversations', component: WorkspaceConversationsView },
  { surface: 'workspace.chat.header', component: WorkspaceChatHeaderView },
  { surface: 'workspace.chat.notices', component: WorkspaceChatNoticesView },
  { surface: 'workspace.chat.timeline', component: WorkspaceChatTimelineView },
  { surface: 'workspace.chat.latest', component: WorkspaceChatLatestView },
  { surface: 'workspace.chat.composer', component: WorkspaceChatComposerView },
  { surface: 'workspace.chat', component: WorkspaceChatView },
  { surface: 'workspace.details', component: WorkspaceDetailsView },
  { surface: 'workspace.plugins', component: WorkspacePluginsView },
  { surface: 'workspace.new-chat', component: WorkspaceNewChatView },
  { surface: 'workspace.settings', component: WorkspaceSettingsView },
  { surface: 'workspace.forward', component: WorkspaceForwardView },
  { surface: 'workspace.retract', component: WorkspaceRetractView },
  { surface: 'workspace.search', component: WorkspaceSearchView },
  { surface: 'workspace.server', component: WorkspaceServerView },
  { surface: 'workspace.contacts', component: WorkspaceContactsView },
  { surface: 'workspace.profile', component: WorkspaceProfileView },
  { surface: 'workspace.toast', component: WorkspaceToastView },
  { surface: 'workspace', component: WorkspaceView },
] as const
