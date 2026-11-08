import type { ServerSnapshot } from '@more-than-chat/central-protocol'
import {
  applyModelChatUpdate,
  authorToolLabel,
  formatRelativeTime,
  type AuthorToolNote,
  type ChatMessage,
  type ChatState,
  type Conversation,
  type ModelChatUpdate,
} from '@more-than-chat/chat-core'
import type { PluginSnapshot } from '@more-than-chat/plugin-runtime'
import type {
  HostPluginSnapshot,
  HostStatusSnapshot,
  ModelProviderMode,
  ModelSettingsSnapshot,
  PluginDraftInspection,
} from '@more-than-chat/protocol'
import {
  Bot,
  Copy,
  Forward,
  MessageCircleMore,
  PencilLine,
  Pin,
  PlugZap,
  Reply,
  Server,
  Sparkles,
  Undo2,
  Users,
  X,
} from 'lucide-react'
import { memo, useEffect, useRef, useState, type FormEvent, type ComponentProps } from 'react'
import { AppearancePicker } from './AppearancePicker'
import { ClientPlugins, InstallClientDraft, ManagePluginButton } from './ClientPlugins'
import { DesktopSettings } from './DesktopSettings'
import { GroupDraftSubmission } from './GroupDraftSubmission'
import { HistorySettings } from './HistorySettings'
import { displayText, MessageBodyFallback, AttachmentMessageFallback, MessageFrame, type MessageSurfaceRenderer } from './message-content'
export {displayText} from './message-content'
import {UiSurface} from './UiSurface'
import {pluginRuntime,uiSurfaceRegistry} from './plugin-host'
import { appApi } from './app-api'
import { avatarTone } from './conversation-presentation'
import type { ModelClientEvent, ModelSettingsInput } from './global'
import { useDialogFocus } from './use-dialog-focus'

export function uid(): string {
  return crypto.randomUUID()
}

export function initials(value: string): string {
  return [...value.trim()].slice(0, 2).join('').toUpperCase() || '?'
}

export function appendMessage(state: ChatState, message: ChatMessage): ChatState {
  return {
    ...state,
    conversations: state.conversations.map((item) =>
      item.id === message.conversationId ? { ...item, updatedAt: message.createdAt } : item,
    ),
    messages: {
      ...state.messages,
      [message.conversationId]: [...(state.messages[message.conversationId] ?? []), message],
    },
  }
}

export function updateMessageStatus(
  state: ChatState,
  conversationId: string,
  messageId: string,
  status: ChatMessage['status'],
): ChatState {
  return {
    ...state,
    messages: {
      ...state.messages,
      [conversationId]: (state.messages[conversationId] ?? []).map((item) =>
        item.id === messageId ? { ...item, status } : item,
      ),
    },
  }
}

export function RailButton({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      className={`rail-button ${active ? 'active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function Avatar({
  conversation,
  small = false,
}: {
  conversation: Conversation
  small?: boolean
}) {
  return (
    <span
      className={`avatar ${small ? 'small' : ''}`}
      data-avatar-kind={conversation.kind}
      data-avatar-tone={
        conversation.avatarColor ??
        avatarTone(
          conversation.kind === 'direct'
            ? (conversation.targetId ?? conversation.id)
            : conversation.id,
        )
      }
    >
      {conversation.kind === 'assistant' ? <Bot size={small ? 20 : 23} /> : conversation.avatar}
    </span>
  )
}

export function MessageItem(props:ComponentProps<typeof MessageBubble>){
  const context={...props,anchored:true}
  // Withdrawn bodies are removed before any message renderer receives them.
  return <MessageFrame message={props.message} highlighted={props.highlighted}>{props.message.retractedAt||props.message.type==='system'?<MessageBubble {...context}/>:<UiSurface registry={uiSurfaceRegistry} name="message" context={context} composition={pluginRuntime}>
    <article className="message-row"><MessageBodyFallback message={props.message}/></article>
  </UiSurface>}</MessageFrame>
}
export const MessageBubble = memo(function MessageBubble({
  message,
  compact,
  onRetry,
  onCopy,
  onResend,
  resending = false,
  highlighted,
  onQuote,
  onForward,
  onRetract,
  onLocateQuote,
  onProfile,
  avatarColor,
  renderSurface,
  anchored = false,
}: {
  message: ChatMessage
  compact: boolean
  onRetry: (() => void) | undefined
  onCopy: () => void
  onResend?: (() => void) | undefined
  resending?: boolean
  highlighted?: boolean
  onQuote?: (() => void) | undefined
  onForward?: (() => void) | undefined
  onRetract?: (() => void) | undefined
  onLocateQuote?: (() => void) | undefined
  onProfile?: (() => void) | undefined
  avatarColor?: number | null | undefined
  renderSurface?: MessageSurfaceRenderer | undefined
  anchored?: boolean | undefined
}) {
  if (message.retractedAt)
    return (
      <article className="message-retracted" data-message-id={anchored?undefined:message.id} data-retracted-message>
        <Undo2 size={13} />
        <span>{message.role === 'self' ? '你' : message.senderName}撤回了一条消息</span>
      </article>
    )
  if (message.type === 'system') return <div className="system-message">{message.text}</div>
  const own = message.role === 'self'
  return (
    <article
      data-message-id={anchored?undefined:message.id}
      className={`message-row ${own ? 'own' : ''} ${compact ? 'compact' : ''} status-${message.status} ${highlighted&&!anchored ? 'message-highlight' : ''}`}
    >
      {!own &&
        (onProfile ? (
          <button
            className="message-avatar profile-avatar-link"
            data-message-profile={message.senderId}
            data-avatar-tone={avatarColor ?? avatarTone(message.senderId)}
            aria-label={`查看 ${message.senderName} 的主页`}
            title="查看个人主页"
            onClick={onProfile}
          >
            {message.senderAvatar}
          </button>
        ) : (
          <span
            className="message-avatar"
            data-avatar-tone={avatarColor ?? avatarTone(message.senderId)}
            data-avatar-kind={message.senderAvatar === 'AI' ? 'assistant' : undefined}
          >
            {message.senderAvatar === 'AI' ? <Bot size={17} /> : message.senderAvatar}
          </span>
        ))}
      <div className="message-content">
        {!compact && !own && <span className="sender-name">{message.senderName}</span>}
        <div className="bubble">
          {message.forwarded && (
            <span className="message-forwarded">
              <Forward size={12} />
              转发自 {message.forwarded.senderName}
            </span>
          )}
          {message.quote && (
            <button
              className="message-quote"
              data-quote-source={message.quote.messageId}
              disabled={!onLocateQuote}
              onClick={onLocateQuote}
            >
              <strong>{message.quote.senderName}</strong>
              <span>
                {message.quote.text || message.quote.attachmentName || '消息'}
                {message.quote.attachmentName ? ' · ' + message.quote.attachmentName : ''}
              </span>
            </button>
          )}
          {(message.content || !message.attachment || (message.text && message.text !== message.attachment.name)) &&
            (renderSurface?renderSurface('message.body',{message,own},<MessageBodyFallback message={message}/>):<MessageBodyFallback message={message}/>)}
          {message.attachment && (renderSurface?renderSurface('message.attachment',{message,own},<AttachmentMessageFallback message={message}/>):<AttachmentMessageFallback message={message}/>)}
          {message.errorMessage && <p className="message-error">{message.errorMessage}</p>}
          {message.authorNotes && message.authorNotes.length > 0 && (
            <ul className="author-tool-notes">
              {message.authorNotes.map((note, index) => (
                <li key={`${note.phase}-${note.tool}-${index}`} className={authorToolClass(note)}>
                  {authorToolLabel(note)}
                </li>
              ))}
            </ul>
          )}
          <span className="bubble-meta">{messageMeta(message)}</span>
          <div className="message-actions">
            <button
              className="message-copy"
              title="复制消息"
              aria-label="复制消息"
              onClick={onCopy}
            >
              <Copy size={13} />
            </button>
            {onQuote && (
              <button
                title="引用回复"
                aria-label="引用回复"
                data-quote-message={message.id}
                onClick={onQuote}
              >
                <Reply size={13} />
              </button>
            )}
            {onForward && (
              <button
                title="转发消息"
                aria-label="转发消息"
                data-forward-message={message.id}
                onClick={onForward}
              >
                <Forward size={13} />
              </button>
            )}
            {onRetract && (
              <button
                title="撤回消息"
                aria-label="撤回消息"
                data-retract-message={message.id}
                onClick={onRetract}
              >
                <Undo2 size={13} />
              </button>
            )}
            {onResend && (
              <button
                className="message-resend"
                disabled={resending}
                aria-busy={resending}
                onClick={onResend}
              >
                {resending
                  ? '正在加入队列…'
                  : message.status === 'queued'
                    ? '立即重试'
                    : '重新发送'}
              </button>
            )}
          </div>
          {message.usage && (
            <span
              className="message-usage"
              data-token-total={message.usage.totalTokens}
              title={`输入 ${message.usage.inputTokens} · 输出 ${message.usage.outputTokens} · ${message.usage.reportedRequests}/${message.usage.requestCount} 次请求返回用量`}
            >
              {message.usage.totalTokens.toLocaleString()} tokens
              {message.usage.reportedRequests < message.usage.requestCount ? '（部分）' : ''}
            </span>
          )}
          {onRetry && (
            <button type="button" className="message-retry" onClick={onRetry}>
              重新生成
            </button>
          )}
        </div>
      </div>
    </article>
  )
})

export function DetailsPanel({
  conversation,
  transportName,
  modelLabel,
  onClose,
  onPlugins,
  onSettings,
  onPin,
  onMute,
}: {
  conversation: Conversation
  transportName: string
  modelLabel?: string
  onClose: () => void
  onPlugins: () => void
  onSettings: () => void
  onPin: () => void
  onMute: () => void
}) {
  return (
    <aside className="details-panel">
      <div className="details-header">
        <strong>会话详情</strong>
        <button className="icon-button" onClick={onClose} aria-label="关闭会话详情">
          <X size={18} />
        </button>
      </div>
      <div className="details-profile">
        <Avatar conversation={conversation} />
        <h2>{conversation.title}</h2>
        <p>{conversation.subtitle}</p>
      </div>
      <div className="details-actions">
        <button onClick={onPlugins}>
          <PlugZap size={18} />
          <span>插件</span>
        </button>
        <button onClick={onSettings}>
          {conversation.kind === 'assistant' ? <Bot size={18} /> : <Users size={18} />}
          <span>{conversation.kind === 'assistant' ? '模型设置' : '联系人'}</span>
        </button>
        <button onClick={onPin} aria-pressed={conversation.pinned}>
          <Pin size={18} />
          <span>{conversation.pinned ? '取消置顶' : '置顶会话'}</span>
        </button>
      </div>
      <div className="details-card">
        <div className="conversation-options">
          <button
            className="secondary-button"
            data-mute-conversation
            aria-pressed={Boolean(conversation.muted)}
            onClick={onMute}
          >
            {conversation.muted ? '关闭免打扰' : '免打扰'}
          </button>
        </div>
        <div>
          <span>连接方式</span>
          <strong>{transportName}</strong>
        </div>
        {modelLabel && (
          <div>
            <span>模型</span>
            <strong>{modelLabel}</strong>
          </div>
        )}
        <div>
          <span>消息存储</span>
          <strong>此设备</strong>
        </div>
        <div>
          <span>端到端加密</span>
          <strong className="muted">尚未启用</strong>
        </div>
      </div>
      <div className="details-note">
        <PlugZap size={17} />
        <p>把常用工具留在手边。会话插件可以为这里添加协作面板和更多功能。</p>
      </div>
    </aside>
  )
}

export function PluginPanel({
  serverSnapshot,
  plugins,
  hostPlugins,
  hostBusy,
  drafts,
  draftReport,
  onCreateDraft,
  onDiagnoseDraft,
  onInstallDraft,
  onHostToggle,
  onToggle,
  onClose,
}: {
  serverSnapshot: ServerSnapshot | null
  plugins: readonly PluginSnapshot[]
  hostPlugins: readonly HostPluginSnapshot[]
  hostBusy: boolean
  drafts: PluginDraftInspection | null
  draftReport: string | null
  onCreateDraft: (manifestJson: string, source: string) => void
  onDiagnoseDraft: (draftId: string) => void
  onInstallDraft: (draftId: string) => void
  onHostToggle: (plugin: HostPluginSnapshot, enabled?: boolean) => void
  onToggle: (plugin: PluginSnapshot) => void
  onClose: () => void
}) {
  const [manifestJson, setManifestJson] = useState('')
  const [source, setSource] = useState('')
  const [showModules, setShowModules] = useState(false)
  const [removableHostIds, setRemovableHostIds] = useState<ReadonlySet<string>>(new Set())
  const pluginDialog = useDialogFocus()
  useEffect(() => {
    let active = true
    void appApi
      .managePlugins({ action: 'list', target: 'all' })
      .then((result) => {
        if (active)
          setRemovableHostIds(
            new Set(
              result.plugins.filter((p) => p.target === 'host' && p.removable).map((p) => p.id),
            ),
          )
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [hostPlugins])
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="plugin-drawer"
        ref={pluginDialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="插件"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <div>
            <p className="eyebrow">为你的聊天添点可能</p>
            <h2>插件</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭插件面板">
            <X />
          </button>
        </div>
        <p className="drawer-description">管理已安装的工具，或者把新想法交给 AI，一起做成插件。</p>
        <ClientPlugins snapshot={serverSnapshot} />
        <button
          className="secondary-button"
          data-composition-modules
          aria-expanded={showModules}
          onClick={() => setShowModules((value) => !value)}
        >
          {showModules ? '收起默认应用模块' : '查看默认应用模块'}
        </button>
        <div className="plugin-list">
          {plugins
            .filter(
              (plugin) =>
                plugin.trust === 'builtin' &&
                (showModules ||
                  !/^(builtin\.ui\.|builtin\.(application|workspace-controller|desktop-api|chat\.api|contacts\.api|history\.api|model\.api|plugins\.api)$)/.test(
                    plugin.manifest.id,
                  )),
            )
            .map((plugin) => {
              const busy = plugin.status === 'activating' || plugin.status === 'deactivating'
              const active = plugin.status === 'active'
              return (
                <div
                  className={`plugin-card ${plugin.status === 'failed' ? 'failed' : ''}`}
                  key={plugin.manifest.id}
                >
                  <span className="plugin-icon">
                    {plugin.manifest.id === 'builtin.local-demo' ? (
                      <MessageCircleMore />
                    ) : (
                      <Sparkles />
                    )}
                  </span>
                  <div className="plugin-copy">
                    <strong>{plugin.manifest.displayName}</strong>
                    <p>{plugin.manifest.description}</p>
                    <small>
                      {plugin.manifest.id} · {plugin.manifest.version} ·{' '}
                      {plugin.manifest.targets.join(', ')}
                    </small>
                    {plugin.error && <span className="plugin-error">{plugin.error}</span>}
                  </div>
                  <button
                    className={`plugin-toggle ${active ? 'active' : ''}`}
                    disabled={busy}
                    onClick={() => onToggle(plugin)}
                  >
                    {busy ? '处理中' : active ? '停用' : '启用'}
                  </button>
                </div>
              )
            })}
          {hostPlugins
            .filter((plugin) => showModules || !/^builtin\.(host|main)\./.test(plugin.id))
            .map((plugin) => (
              <div
                className={`plugin-card host-plugin-card ${plugin.status === 'failed' ? 'failed' : ''}`}
                key={plugin.id}
                data-plugin-id={plugin.id}
              >
                <span className="plugin-icon">
                  <Server />
                </span>
                <div className="plugin-copy">
                  <strong>{plugin.displayName}</strong>
                  <p>{plugin.description}</p>
                  <small>
                    {plugin.id} · {plugin.version} · {plugin.description.endsWith('· 主进程') ? '主进程' : '独立后台进程'} · {plugin.status === 'active' ? '运行中' : plugin.status === 'failed' ? '载入失败' : '未运行'}
                  </small>
                  {removableHostIds.has(plugin.id) && (
                    <ManagePluginButton
                      label="卸载本机插件"
                      request={{
                        action: 'uninstall',
                        target: 'host',
                        id: plugin.id,
                        version: plugin.version,
                      }}
                    />
                  )}
                  {plugin.error && <span className="plugin-error" role="alert">{plugin.status === 'active' ? '更新未生效，仍在运行原版本。' : ''}{plugin.error}</span>}
                </div>
                <button
                  className={`plugin-toggle ${plugin.status === 'active' ? 'active' : ''}`}
                  disabled={
                    hostBusy || plugin.status === 'activating' || plugin.status === 'deactivating'
                  }
                  onClick={() => onHostToggle(plugin)}
                >
                  {hostBusy ? '处理中' : plugin.status === 'active' ? '停用' : plugin.status === 'failed' ? '重新载入' : '启用'}
                </button>
                {plugin.status === 'failed' && <button className="secondary-button" data-stop-failed-plugin disabled={hostBusy} onClick={() => onHostToggle(plugin, false)}>停用</button>}
              </div>
            ))}
        </div>
        <section className="draft-section">
          <div>
            <p className="eyebrow">未安装</p>
            <h3>插件草稿</h3>
          </div>
          <p className="settings-note">
            让 More AI
            为你创建文本动作、完整界面或实时群插件。界面插件安装后直接启用；群插件仍须提交审批、成员自主载入。
          </p>
          {(drafts?.drafts ?? []).map((item) => {
            const installed = hostPlugins.some((plugin) => plugin.id === item.id)
            return (
              <div
                className="draft-card"
                key={item.id}
                data-draft-id={item.id}
                data-draft-installed={installed ? 'true' : 'false'}
                data-draft-ok={item.ok ? 'true' : 'false'}
              >
                <strong>{item.displayName}</strong>
                <small>
                  {item.id} · r{item.revision} ·{' '}
                  {item.distribution === 'local-client'
                    ? '源草稿（运行版本见可执行界面）'
                    : installed
                      ? '已安装'
                      : '未安装'}{' '}
                  · {item.ok ? '校验通过' : '校验未通过'}
                </small>
                <div className="draft-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    data-draft-diagnose
                    disabled={hostBusy}
                    onClick={() => onDiagnoseDraft(item.id)}
                  >
                    诊断
                  </button>
                  <ManagePluginButton
                    label="删除草稿"
                    request={{
                      action: 'delete-draft',
                      target: 'draft',
                      id: item.id,
                      revision: item.revision,
                    }}
                  />
                  {item.distribution === 'local-client' ? (
                    <InstallClientDraft draft={item} snapshot={serverSnapshot} />
                  ) : item.distribution === 'group' ? (
                    <GroupDraftSubmission
                      key={`${serverSnapshot?.serverId}:${item.id}:${item.revision}`}
                      draft={item}
                      snapshot={serverSnapshot}
                    />
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      {...(installed
                        ? { 'data-draft-update': 'true' }
                        : { 'data-draft-install': 'true' })}
                      disabled={hostBusy}
                      onClick={() => onInstallDraft(item.id)}
                    >
                      {installed ? '更新' : '安装'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {drafts && drafts.drafts.length === 0 && <p className="settings-note">还没有草稿。</p>}
          <details className="plugin-advanced-editor">
            <summary>开发者：手动创建插件</summary>
            <label className="settings-field">
              <span>Manifest JSON</span>
              <textarea
                data-draft-field="manifest"
                value={manifestJson}
                onChange={(event) => setManifestJson(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="settings-field">
              <span>插件定义（JSON）</span>
              <textarea
                data-draft-field="source"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={hostBusy || !manifestJson.trim()}
              onClick={() => onCreateDraft(manifestJson, source)}
            >
              创建草稿
            </button>
          </details>
          {draftReport && <p className="draft-report">{draftReport}</p>}
        </section>
        <div className="plugin-empty">
          <PlugZap />
          <h3>你的聊天，你来定义</h3>
          <p>
            从 AI
            对话创建，或导入自己的插件。支持本机启停与更新，也可以向好友或群聊申请分享，由接收成员选择载入。
          </p>
        </div>
      </aside>
    </div>
  )
}

export function NewChatDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (title: string, kind: Conversation['kind']) => void
}) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<Conversation['kind']>('direct')
  function submit(event: FormEvent) {
    event.preventDefault()
    onCreate(title, kind)
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="new-chat-dialog"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-icon">
          <PencilLine />
        </div>
        <h2>新建会话</h2>
        <p>AI 会话可直接创建；单聊和群聊请在当前中心服务器添加好友或创建群。</p>
        <label>
          <span>会话名称</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：周末计划"
          />
        </label>
        <div className="kind-picker">
          <button
            type="button"
            className={kind === 'direct' ? 'active' : ''}
            onClick={() => setKind('direct')}
          >
            <MessageCircleMore />
            单聊
          </button>
          <button
            type="button"
            className={kind === 'group' ? 'active' : ''}
            onClick={() => setKind('group')}
          >
            <Users />
            群聊
          </button>
          <button
            type="button"
            className={kind === 'assistant' ? 'active' : ''}
            onClick={() => setKind('assistant')}
          >
            <Bot />
            AI
          </button>
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={!title.trim()}>
            创建会话
          </button>
        </div>
      </form>
    </div>
  )
}

export function ModelSettingsPanel({
  snapshot,
  onClose,
  onSave,
  onClearKey,
  onServerSettings,
}: {
  snapshot: ModelSettingsSnapshot | null
  onClose: () => void
  onSave: (input: ModelSettingsInput) => Promise<void>
  onClearKey: () => Promise<void>
  onServerSettings: () => void
}) {
  const [baseUrl, setBaseUrl] = useState(snapshot?.baseUrl ?? 'https://api.deepseek.com')
  const [model, setModel] = useState(snapshot?.model ?? 'deepseek-flash')
  const [providerMode, setProviderMode] = useState<ModelProviderMode>(
    snapshot?.providerMode ?? 'mock',
  )
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClearKey, setConfirmClearKey] = useState(false)
  const settingsRunning = useRef(false)
  const settingsDialog = useDialogFocus()
  const settingsBody = useRef<HTMLDivElement>(null)
  const [settingsSection, setSettingsSection] = useState('appearance')

  function goToSettingsSection(id: string) {
    setSettingsSection(id)
    settingsBody.current?.scrollTo({ top: 0, behavior: 'instant' })
  }

  useEffect(() => {
    if (!snapshot) return
    setBaseUrl(snapshot.baseUrl)
    setModel(snapshot.model)
    setProviderMode(snapshot.providerMode)
  }, [snapshot])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!snapshot || settingsRunning.current || !baseUrl.trim() || !model.trim()) return
    settingsRunning.current = true
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
      setConfirmClearKey(false)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      settingsRunning.current = false
      setBusy(false)
    }
  }

  async function clearKey() {
    if (settingsRunning.current) return
    settingsRunning.current = true
    setBusy(true)
    setError(null)
    try {
      await onClearKey()
      setApiKey('')
      setConfirmClearKey(false)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      settingsRunning.current = false
      setBusy(false)
    }
  }

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="plugin-drawer settings-drawer"
        ref={settingsDialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(event) => event.stopPropagation()}
        data-provider-mode={providerMode}
        data-has-api-key={snapshot?.hasApiKey ? 'true' : 'false'}
      >
        <div className="settings-chrome">
          <div className="drawer-header">
            <h2>设置</h2>
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭设置">
              <X size={18} />
            </button>
          </div>
          <nav
            className="settings-navigation"
            role="tablist"
            aria-label="设置分类"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              const tabs = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              ]
              const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
              if (current < 0) return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
              const target = tabs[next]
              if (target?.dataset.settingsTarget) {
                goToSettingsSection(target.dataset.settingsTarget)
                target.focus()
              }
            }}
          >
            {(
              [
                ['appearance', '外观'],
                ['desktop', '桌面'],
                ['history', '记录'],
                ['model', 'AI 模型'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                data-settings-target={id}
                aria-selected={settingsSection === id}
                aria-controls={`settings-${id}`}
                tabIndex={settingsSection === id ? 0 : -1}
                onClick={() => goToSettingsSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="settings-body" ref={settingsBody}>
          <section
            id="settings-appearance"
            role="tabpanel"
            aria-labelledby="settings-tab-appearance"
            hidden={settingsSection !== 'appearance'}
          >
            <AppearancePicker />
          </section>
          <section
            id="settings-desktop"
            role="tabpanel"
            aria-labelledby="settings-tab-desktop"
            hidden={settingsSection !== 'desktop'}
          >
            <DesktopSettings />
            <button type="button" className="secondary-button" onClick={onServerSettings}>
              中心服务器 / 身份 / 联系人
            </button>
          </section>
          <section
            id="settings-history"
            role="tabpanel"
            aria-labelledby="settings-tab-history"
            hidden={settingsSection !== 'history'}
          >
            <HistorySettings />
          </section>
          <form
            id="settings-model"
            role="tabpanel"
            aria-labelledby="settings-tab-model"
            hidden={settingsSection !== 'model'}
            className="model-settings-form"
            aria-label="AI 模型设置"
            onSubmit={(event) => void submit(event)}
          >
            <div className="settings-section-heading">
              <h3>AI 模型</h3>
            </div>
            <p className="settings-note">
              API Key 由主进程使用系统加密保存，仅供模型服务调用。界面只显示是否已保存，不回传密钥。
            </p>
            <label className="settings-field">
              <span>提供方</span>
              <select
                data-model-field="provider"
                disabled={busy}
                value={providerMode}
                onChange={(event) => setProviderMode(event.target.value as ModelProviderMode)}
              >
                <option value="mock">模拟（不访问网络）</option>
                <option value="openai-compatible">OpenAI 兼容 / DeepSeek</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Base URL</span>
              <input
                data-model-field="base-url"
                disabled={busy}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.deepseek.com"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="settings-field">
              <span>模型</span>
              <input
                data-model-field="model"
                disabled={busy}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="deepseek-flash"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="settings-field">
              <span>API Key</span>
              <input
                data-model-field="key"
                disabled={busy}
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={snapshot?.hasApiKey ? '已保存，留空则不修改' : '未设置'}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {error && (
              <p className="settings-error" role="alert">
                {error}
              </p>
            )}
            {confirmClearKey && snapshot?.hasApiKey && (
              <div className="danger-confirm" role="group" aria-label="确认删除 API 密钥">
                <p>删除本机保存的 API 密钥？</p>
                <small>
                  聊天记录不会删除。使用真实模型前需要重新填写密钥；此操作不能找回旧密钥。
                </small>
                <div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => setConfirmClearKey(false)}
                  >
                    保留密钥
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    data-confirm-clear-key
                    disabled={busy}
                    onClick={() => void clearKey()}
                  >
                    确认删除密钥
                  </button>
                </div>
              </div>
            )}
            <div className="dialog-actions">
              {snapshot?.hasApiKey && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirmClearKey(true)}
                >
                  删除密钥
                </button>
              )}
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !snapshot || !baseUrl.trim() || !model.trim()}
              >
                {busy ? '保存中' : '保存'}
              </button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  )
}

export function modelSubtitle(settings: ModelSettingsSnapshot | null): string {
  if (!settings) return '正在连接模型'
  if (settings.providerMode === 'mock') return '模拟回复 · 未调用网络'
  return settings.hasApiKey ? settings.model : `${settings.model} · 未保存密钥`
}


export function messageMeta(message: ChatMessage): string {
  const time = formatRelativeTime(message.createdAt)
  if (message.status === 'streaming') return `${time} · 生成中`
  if (message.status === 'cancelled') return `${time} · 已取消`
  if (message.status === 'failed')
    return `${time} · 失败${message.supersededById ? ' · 已重试' : ''}`
  if (message.role === 'self' && message.status === 'sending') return `${time} · 发送中`
  if (message.status === 'queued') return `${time} · 待发送`
  if (message.role === 'self' && message.receipt?.recipientCount) {
    const receipt = message.receipt
    if (receipt.recipientCount === 1)
      return `${time} · ${receipt.readCount ? '已读' : receipt.deliveredCount ? '已送达' : '已提交中心'}`
    return `${time} · ${receipt.deliveredCount}/${receipt.recipientCount} 已送达 · ${receipt.readCount} 已读`
  }
  if (message.role === 'self') return message.serverId ? `${time} · 已提交中心` : `${time} ✓`
  return message.retryOfId ? `${time} · 重试回复` : time
}

export function errorText(error: unknown): string {
  const message = error instanceof Error && error.message.trim() ? error.message : '模型请求失败'
  return message.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240)
}

export function authorToolClass(note: AuthorToolNote): string {
  if (note.pendingInstall) return 'author-tool-note pending'
  if (!note.ok) return 'author-tool-note failed'
  if (note.phase === 'started') return 'author-tool-note progress'
  return 'author-tool-note'
}

export function toModelUpdate(event: ModelClientEvent): ModelChatUpdate {
  const identity = {
    conversationId: event.conversationId,
    assistantMessageId: event.assistantMessageId,
  }
  switch (event.type) {
    case 'delta':
      return { type: 'delta', ...identity, textDelta: event.textDelta }
    case 'completed':
      return {
        type: 'completed',
        ...identity,
        text: event.text,
        ...(event.usage ? { usage: event.usage } : {}),
      }
    case 'failed':
      return {
        type: 'failed',
        ...identity,
        partialText: event.partialText,
        errorMessage: event.errorMessage,
      }
    case 'cancelled':
      return { type: 'cancelled', ...identity, partialText: event.partialText }
    case 'author-tool':
      return {
        type: 'author-tool',
        ...identity,
        note: {
          phase: event.phase,
          tool: event.tool,
          ok: event.ok,
          summary: event.summary,
          pendingInstall: event.pendingInstall,
          draft: event.draft,
        },
      }
  }
}

export function applyIncomingModelEvent(
  state: ChatState,
  event: ModelClientEvent,
  pending: ModelClientEvent[],
): ChatState {
  const list = state.messages[event.conversationId] ?? []
  if (!list.some((message) => message.id === event.assistantMessageId)) {
    pending.push(event)
    return state
  }
  return applyModelChatUpdate(state, toModelUpdate(event))
}

export function drainModelEvents(state: ChatState, pending: ModelClientEvent[]): ChatState {
  if (pending.length === 0) return state
  const queued = pending.splice(0, pending.length)
  return queued.reduce(
    (current, event) => applyModelChatUpdate(current, toModelUpdate(event)),
    state,
  )
}

export function LoadingScreen({ error = false }: { error?: boolean }) {
  const [notice,setNotice]=useState('')
  return (
    <div className="loading-screen">
      <div className="loading-mark">M</div>
      <p>{notice || (error ? '会话服务暂不可用，原数据已保留。' : '正在恢复会话…')}</p>
      {error&&<button className="secondary-button" onClick={()=>{
        setNotice('正在启用默认功能…')
        void import('./app-composition').then(module=>module.restoreDefaultComposition()).then(()=>window.location.reload()).catch(error=>setNotice(error instanceof Error?error.message:'恢复未完成，请重试'))
      }}>启用默认功能并重试</button>}
    </div>
  )
}

export function hostStatusLabel(status: HostStatusSnapshot): string {
  switch (status.state) {
    case 'starting':
      return 'Host 连接中'
    case 'ready':
      return 'Host 已连接'
    case 'restarting':
      return 'Host 重连中'
    case 'failed':
      return 'Host 不可用'
    case 'stopped':
      return 'Host 已停止'
  }
}
