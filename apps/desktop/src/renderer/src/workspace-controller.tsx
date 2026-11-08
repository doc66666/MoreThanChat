import type { AttachmentRef, Member, ServerSnapshot } from '@more-than-chat/central-protocol'
import {
  directPluginScope,
  pluginScopeMembers,
  type UiSlot as UiSlotName,
} from '@more-than-chat/central-protocol'
import {
  applyModelChatUpdate,
  createSeedState,
  interruptStreamingMessages,
  mergeCentralProjection,
  mergeHistoryProjection,
  normalizeState,
  planAssistantRetry,
  redactMessageForRetraction,
  toModelTranscript,
  type ChatMessage,
  type ChatState,
  type Conversation,
} from '@more-than-chat/chat-core'
import type {
  ComposerAction,
  PluginSnapshot,
  RegisteredContribution,
  UiSlotContribution,
} from '@more-than-chat/plugin-runtime'
import type {
  HostPluginSnapshot,
  HostStatusSnapshot,
  ModelSettingsSnapshot,
  PluginDraftInspection,
} from '@more-than-chat/protocol'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { getClientPluginController } from './ClientPlugins'
import { GroupPluginPlacement } from './GroupPluginPlacement'
import { GroupPluginView } from './NetworkPanel'
import { useSharedClientPlugins } from './SharedClientPlugins'
import { UiSlot } from './UiSlot'
import { type ProfileTarget } from './UserProfile'
import { useDesktopApi } from './app-api'
import { clearRetractedDraftQuotes, useChatDraft } from './chat-drafts'
import { shouldSendOnEnter } from './composer-input'
import { visibleConversations, type ConversationFilter } from './conversation-presentation'
import type { ModelClientEvent, ModelSettingsInput } from './global'
import { MessageActionGate } from './message-actions'
import {
  composerActionRegistry,
  pluginRuntime,
  startBundledPlugins,
  transportRegistry,
  uiSlotRegistry,
} from './plugin-host'
import { useAppearance } from './theme'
import { useChatReading } from './use-chat-reading'
import { directoryMembers } from './user-directory'
import {
  appendMessage,
  applyIncomingModelEvent,
  drainModelEvents,
  errorText,
  hostStatusLabel,
  initials,
  uid,
  updateMessageStatus,
} from './workspace-components'

export function useWorkspaceController() {
  const api = useDesktopApi()
  const appearance = useAppearance()
  const [state, setState] = useState<ChatState | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [serverState, setServerState] = useState<ServerSnapshot | null>(null)
  const [showServer, setShowServer] = useState(false)
  const [showContacts, setShowContacts] = useState(false)
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null)
  const membersById = useMemo(
    () => directoryMembers(serverState?.directory),
    [serverState?.directory],
  )
  const contactServer = useRef<string | null>(null)
  useEffect(() => {
    const id = serverState?.serverId
    if (!id) return
    if (contactServer.current && contactServer.current !== id) {
      setProfileTarget(null)
      setShowContacts(false)
    }
    contactServer.current = id
  }, [serverState?.serverId])
  function openProfile(member: Member) {
    setProfileTarget({ serverId: serverState?.serverId ?? null, user: member })
  }
  function openCurrentContact(id: string) {
    const conversation = stateRef.current?.conversations.find(
      (item) =>
        item.serverId === serverState?.serverId && item.targetId === id && !item.unavailable,
    )
    if (!conversation) {
      setToast('会话尚未同步，请稍后再试')
      return
    }
    selectConversation(conversation.id)
    setShowContacts(false)
    setShowServer(false)
    setProfileTarget(null)
  }
  const chatDraft = useChatDraft(state?.activeConversationId ?? '')
  const pendingAttachment = chatDraft.attachment
  const setPendingAttachment = chatDraft.setAttachment
  const [slotEntries, setSlotEntries] = useState<RegisteredContribution<UiSlotContribution>[]>(() =>
    uiSlotRegistry.list(),
  )
  const [groupPluginSlot, setGroupPluginSlot] = useState<UiSlotName>('chat.details')
  const [query, setQuery] = useState('')
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>('all')
  const conversationSearch = useRef<HTMLInputElement>(null)
  const draft = chatDraft.text
  const setDraft = chatDraft.setText
  const [showMessageSearch, setShowMessageSearch] = useState(false)
  const [highlightMessage, setHighlightMessage] = useState<string | null>(null)
  const [quotedMessage, setQuotedMessage] = useState<ChatMessage | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [forwardDialog, setForwardDialog] = useState<{ message: ChatMessage } | null>(null)
  const [retractConfirm, setRetractConfirm] = useState<ChatMessage | null>(null)
  const resendGate = useRef(new MessageActionGate())
  const [resending, setResending] = useState<Set<string>>(() => new Set())
  type HistoryPage = Awaited<ReturnType<Window['moreThanChat']['getChatHistory']>>
  type HistoryInput = { before?: number; after?: number; around?: string }
  const [historyWindow, setHistoryWindow] = useState<
    (HistoryPage & { conversationId: string }) | null
  >(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyFailure, setHistoryFailure] = useState<{
    conversationId: string
    input: HistoryInput
    error: string
  } | null>(null)
  const historyRequestRef = useRef(0)
  const [entryUnread, setEntryUnread] = useState<{
    id: string
    count: number
    first: string | null
  } | null>(null)
  const enteredConversation = useRef<string | undefined>(undefined)
  const [showDetails, setShowDetails] = useState(() => {
    try {
      return localStorage.getItem('more-than-chat.details-expanded') === 'true'
    } catch {
      return false
    }
  })
  const [showPlugins, setShowPlugins] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<PluginSnapshot[]>(() => pluginRuntime.list())
  const [composerActions, setComposerActions] = useState<RegisteredContribution<ComposerAction>[]>(
    () => composerActionRegistry.list(),
  )
  const [hostStatus, setHostStatus] = useState<HostStatusSnapshot>({
    state: 'starting',
    generation: 0,
  })
  const [hostPlugins, setHostPlugins] = useState<HostPluginSnapshot[]>([])
  const [hostPluginBusy, setHostPluginBusy] = useState(false)
  const [pluginDrafts, setPluginDrafts] = useState<PluginDraftInspection | null>(null)
  const [pluginDraftReport, setPluginDraftReport] = useState<string | null>(null)
  const [modelSettings, setModelSettings] = useState<ModelSettingsSnapshot | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  useEffect(() => {
    try {
      localStorage.setItem('more-than-chat.details-expanded', String(showDetails))
    } catch {
      /* Session preference still works. */
    }
  }, [showDetails])
  useEffect(() => {
    const search = (event: globalThis.KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'k' &&
        !showSettings &&
        !showPlugins &&
        !showServer &&
        !showContacts &&
        !profileTarget &&
        !showNewChat &&
        !showMessageSearch &&
        !forwardDialog &&
        !retractConfirm
      ) {
        event.preventDefault()
        conversationSearch.current?.focus()
        conversationSearch.current?.select()
      }
    }
    window.addEventListener('keydown', search)
    return () => window.removeEventListener('keydown', search)
  }, [
    showSettings,
    showPlugins,
    showServer,
    showContacts,
    profileTarget,
    showNewChat,
    showMessageSearch,
    forwardDialog,
    retractConfirm,
  ])
  const streamIdsRef = useRef(new Map<string, string>())
  const startingConversationsRef = useRef(new Set<string>())
  const humanSendsRef = useRef(new Set<string>())
  const pendingModelEventsRef = useRef<ModelClientEvent[]>([])
  const hostStatusRef = useRef(hostStatus)
  hostStatusRef.current = hostStatus
  const stateRef = useRef(state)
  stateRef.current = state
  const [navigation, setNavigation] = useState<{ id: string; conversationId: string } | null>(null)
  useEffect(() => {
    let changed = false,
      live = true
    const stop = api.onOpenConversation((value) => {
      changed = true
      if (live) setNavigation(value)
    })
    void api
      .getPendingNavigation()
      .then((value) => {
        if (live && !changed) setNavigation(value)
      })
      .catch(() => undefined)
    return () => {
      live = false
      stop()
    }
  }, [api])
  useEffect(() => {
    if (!navigation || !state) return
    const target = state.conversations.find(
      (c) => c.id === navigation.conversationId && !c.unavailable,
    )
    if (target && state.activeConversationId !== target.id) {
      selectConversation(target.id)
      setShowSettings(false)
      setShowServer(false)
      setShowPlugins(false)
      setShowMessageSearch(false)
      setShowNewChat(false)
      setForwardDialog(null)
      setRetractConfirm(null)
      setProfileTarget(null)
      setShowContacts(false)
      return
    }
    if (target) {
      setShowSettings(false)
      setShowServer(false)
      setShowPlugins(false)
      setShowMessageSearch(false)
      setShowNewChat(false)
      setForwardDialog(null)
      setRetractConfirm(null)
      setProfileTarget(null)
      setShowContacts(false)
      returnToLatest()
    }
    void api.navigationApplied(navigation.id).catch(() => undefined)
    setNavigation(null)
  }, [navigation, state, api])
  const saveTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector('.composer-menu')
      )
        return
      if (forwardDialog || retractConfirm) return // The mounted dialog owns Escape and its synchronous action lock.
      if (profileTarget) return // Profile owns Escape, including editing and pending writes.
      if (showContacts) setShowContacts(false)
      else if (showMessageSearch) setShowMessageSearch(false)
      else if (showServer) setShowServer(false)
      else if (showSettings) setShowSettings(false)
      else if (showPlugins) setShowPlugins(false)
      else if (showNewChat) setShowNewChat(false)
      else if (window.innerWidth <= 1080) setShowDetails(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [
    showServer,
    showSettings,
    showPlugins,
    showNewChat,
    showMessageSearch,
    forwardDialog,
    retractConfirm,
    profileTarget,
    showContacts,
  ])

  useEffect(() => {
    const dispose = uiSlotRegistry.subscribe(() => setSlotEntries(uiSlotRegistry.list()))
    setSlotEntries(uiSlotRegistry.list())
    return () => {
      void dispose()
    }
  }, [])

  useEffect(() => {
    let changed = false
    if (typeof api.onServerState !== 'function') {
      setToast('中心服务功能需要完整重启客户端')
      return
    }
    const dispose = api.onServerState((snapshot) => {
      changed = true
      setServerState(snapshot)
    })
    const chatDispose = api.onCentralChat((value) => {
      const imported = (value as { historyImported?: boolean })?.historyImported === true
      setState((current) =>
        current
          ? (imported ? mergeHistoryProjection : mergeCentralProjection)(
              current,
              value as ChatState,
            )
          : current,
      )
      if (imported) {
        historyRequestRef.current++
        setHistoryWindow(null)
        setHistoryBusy(false)
        setHistoryFailure(null)
        setHighlightMessage(null)
        setForwardDialog(null)
        setRetractConfirm(null)
        setShowMessageSearch(false)
        setQuotedMessage(null)
        setHistoryRevision((revision) => revision + 1)
      }
      const change = (
        value as {
          retraction?: import('@more-than-chat/central-protocol').MessageRetraction & {
            serverId: string
          }
        }
      )?.retraction
      if (change) {
        clearRetractedDraftQuotes(change.serverId, change.messageId)
        setHistoryWindow((current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((m) => redactMessageForRetraction(m, change)),
              }
            : current,
        )
        setForwardDialog((current) =>
          current?.message.id === change.messageId && current.message.serverId === change.serverId
            ? null
            : current,
        )
        setRetractConfirm((current) =>
          current?.id === change.messageId && current.serverId === change.serverId ? null : current,
        )
      }
    })
    void api
      .getServerState()
      .then((snapshot) => {
        if (!changed) setServerState(snapshot)
      })
      .catch(() => undefined)
    return () => {
      dispose()
      chatDispose()
    }
  }, [api])

  useEffect(() => {
    const syncPlugins = () => setPlugins(pluginRuntime.list())
    const syncActions = () => setComposerActions(composerActionRegistry.list())
    const unsubscribePlugins = pluginRuntime.subscribe(syncPlugins)
    const unsubscribeActions = composerActionRegistry.subscribe(syncActions)
    syncPlugins()
    syncActions()
    void startBundledPlugins().catch((error) => {
      console.error(error)
      setToast('插件启动失败，请打开插件面板查看诊断')
    })
    return () => {
      void unsubscribePlugins()
      void unsubscribeActions()
    }
  }, [])

  useEffect(
    () =>
      api.onClientPluginRemoval((id, version) =>
        getClientPluginController().uninstall(id, version),
      ),
    [api],
  )
  useEffect(() => {
    const refresh = () => {
      void api
        .inspectPluginDrafts()
        .then(setPluginDrafts)
        .catch(() => undefined)
      void api
        .getHostPlugins()
        .then((catalog) => setHostPlugins(catalog.plugins))
        .catch(() => undefined)
    }
    window.addEventListener('local-plugins-managed', refresh)
    return () => window.removeEventListener('local-plugins-managed', refresh)
  }, [api])

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = api.onHostStatusChanged((status) => {
      receivedEvent = true
      if (active) setHostStatus(status)
    })
    void api
      .getHostStatus()
      .then((status) => {
        if (active && !receivedEvent) setHostStatus(status)
      })
      .catch((error) => {
        console.error(error)
        if (active)
          setHostStatus({
            state: 'failed',
            generation: 0,
            error: {
              code: 'HOST_UNAVAILABLE',
              message: '无法读取 PC Host 状态。',
              retryable: true,
            },
          })
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  useEffect(() => {
    if (hostStatus.state !== 'ready') {
      setHostPlugins([])
      return
    }
    let active = true
    void api
      .getHostPlugins()
      .then((catalog) => {
        if (active && catalog.generation === hostStatus.generation) setHostPlugins(catalog.plugins)
      })
      .catch((error) => {
        if (active) {
          console.error(error)
          setToast('无法读取后台插件，请稍后重试')
        }
      })
    return () => {
      active = false
    }
  }, [hostStatus.state, hostStatus.generation, api])

  useEffect(() => {
    if (!showPlugins || hostStatus.state !== 'ready') return
    let active = true
    void api
      .inspectPluginDrafts()
      .then((inspection) => {
        if (active) setPluginDrafts(inspection)
      })
      .catch((error) => {
        if (active) {
          console.error(error instanceof Error ? error.message : 'plugin drafts')
          setToast('无法读取插件草稿')
        }
      })
    return () => {
      active = false
    }
  }, [showPlugins, hostStatus.state, hostStatus.generation, api])

  useEffect(() => {
    if (!showPlugins || hostPluginBusy) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const catalog = await api.getHostPlugins()
        if (active) setHostPlugins(current => JSON.stringify(current) === JSON.stringify(catalog.plugins) ? current : catalog.plugins)
      } catch { /* The initial load and explicit actions report errors. */ }
      finally {if (active) timer = setTimeout(() => void refresh(), 1000)}
    }
    void refresh()
    return () => {active = false;clearTimeout(timer)}
  }, [showPlugins, hostPluginBusy, hostStatus.generation, api])

  useEffect(() => {
    if (hostStatus.state === 'ready') return
    setState((current) => (current ? interruptStreamingMessages(current) : current))
  }, [hostStatus.state, hostStatus.generation])

  useEffect(() => {
    if (hostStatus.state !== 'ready') return
    let alive = true
    void api
      .getModelSettings()
      .then((snapshot) => {
        if (alive) setModelSettings(snapshot)
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : 'model settings')
        if (alive) setToast('无法读取模型设置')
      })
    return () => {
      alive = false
    }
  }, [hostStatus.state, hostStatus.generation, api])

  useEffect(() => {
    return api.onModelChatEvent((event) => {
      if (event.generation !== hostStatusRef.current.generation) return
      if (
        event.type === 'author-tool' &&
        event.phase === 'finished' &&
        (event.draft || ['delete_draft', 'uninstall_plugin'].includes(event.tool))
      ) {
        void api
          .inspectPluginDrafts()
          .then((inspection) => {
            if (event.generation === hostStatusRef.current.generation) setPluginDrafts(inspection)
          })
          .catch(() => undefined)
        window.dispatchEvent(new Event('local-plugins-managed'))
      }
      setState((current) =>
        current ? applyIncomingModelEvent(current, event, pendingModelEventsRef.current) : current,
      )
      if (event.type === 'failed') setToast(event.errorMessage)
      if (event.type !== 'delta' && event.type !== 'author-tool')
        streamIdsRef.current.delete(event.assistantMessageId)
    })
  }, [api])

  useEffect(() => {
    let alive = true
    void api
      .loadState()
      .then(async (value) => {
        const initial = value ? normalizeState(value) : createSeedState()
        // A newly imported profile can authenticate immediately with existing friends.
        // Persist its seed before exposing Connect, so Main can project those entries.
        if (!value) await api.saveState(initial)
        if (alive) setState(initial)
      })
      .catch(() => {
        if (alive) setLoadError(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!state) return
    if (saveTimerRef.current !== undefined) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined
      void api.saveState(stateRef.current).catch(() => {
        setToast('本地保存失败，请稍后重试')
      })
    }, 180)
  }, [state, api])

  useEffect(
    () => () => {
      if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
      if (stateRef.current) void api.saveState(stateRef.current).catch(() => undefined)
    },
    [api],
  )

  useEffect(
    () =>
      api.onBeforeClose(async () => {
        if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = undefined
        if (stateRef.current) await api.saveState(stateRef.current)
      }),
    [api],
  )

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const active = state?.conversations.find((item) => item.id === state.activeConversationId)
  const messages = active && state ? (state.messages[active.id] ?? []) : []
  const pluginScope =
    active?.serverId === serverState?.serverId && active?.targetId && serverState?.userId
      ? active.kind === 'group'
        ? active.targetId
        : active.kind === 'direct'
          ? directPluginScope(serverState.userId, active.targetId)
          : null
      : null
  useSharedClientPlugins(serverState, pluginScope)
  useEffect(() => {
    let cancelled = false
    setQuotedMessage(null)
    if (!chatDraft.quoteMessageId) return
    void api
      .getChatMessage(chatDraft.quoteMessageId)
      .then((message) => {
        if (cancelled) return
        if (message && message.conversationId === active?.id && !message.retractedAt)
          setQuotedMessage(message)
        else chatDraft.setQuoteMessageId(null)
      })
      .catch(() => {
        if (!cancelled) chatDraft.setQuoteMessageId(null)
      })
    return () => {
      cancelled = true
    }
  }, [active?.id, chatDraft.quoteMessageId, historyRevision, api])
  const historic = historyWindow?.conversationId === active?.id ? historyWindow : null
  const visibleMessages = useMemo(() => {
    const list = historic?.messages ?? messages
    if (!active?.serverId || active.serverId !== serverState?.serverId) return list
    const directory = serverState.directory
    const names = new Map(
      [
        ...(directory?.friends ?? []),
        ...(directory?.groups.flatMap((g) => g.members) ?? []),
        ...(directory?.self ? [directory.self] : []),
      ].map((user) => [user.id, user.displayName]),
    )
    return list.map((message) => {
      const name = names.get(message.senderId)
      return name ? { ...message, senderName: name, senderAvatar: initials(name) } : message
    })
  }, [historic, messages, active?.serverId, serverState])
  useLayoutEffect(() => {
    if (!active || enteredConversation.current === active.id) return
    enteredConversation.current = active.id
    setEntryUnread(
      active.unread > 0
        ? {
            id: active.id,
            count: active.unread,
            first:
              state?.history?.[active.id]?.firstUnreadId ??
              messages.find((m) => m.role === 'peer' && !m.readAt)?.id ??
              null,
          }
        : null,
    )
  }, [active?.id])
  const historyPositioning =
    Boolean(highlightMessage) || Boolean(historic) || historyBusy || Boolean(historyFailure)
  const reading = useChatReading(
    active?.id,
    visibleMessages,
    showMessageSearch ||
      showSettings ||
      showPlugins ||
      showServer ||
      showContacts ||
      Boolean(profileTarget) ||
      showNewChat ||
      historyPositioning ||
      Boolean(forwardDialog) ||
      Boolean(retractConfirm),
    active?.unread,
    historyPositioning,
  )
  useLayoutEffect(() => {
    if (!highlightMessage) return
    reading.pauseReading()
    document
      .querySelector('[data-message-id="' + CSS.escape(highlightMessage) + '"]')
      ?.scrollIntoView({ block: 'center', behavior: 'instant' })
    const clear = window.setTimeout(() => setHighlightMessage(null), 3000)
    return () => {
      clearTimeout(clear)
    }
  }, [highlightMessage, active?.id, historic])
  const filtered = useMemo(() => {
    return visibleConversations(state?.conversations ?? [], query, conversationFilter)
  }, [query, state, conversationFilter])

  if (!state || !active) return { kind: 'loading' as const, error: loadError }
  const readyState = state
  const lastMessage = messages.at(-1)
  const canRetryLast =
    active.kind === 'assistant' &&
    lastMessage &&
    hostStatus.state === 'ready' &&
    planAssistantRetry(messages, lastMessage.id)
  const groupPlugins = (serverState?.directory?.plugins ?? [])
    .filter(
      (plugin) =>
        plugin.status === 'approved' &&
        plugin.pack.kind !== 'executable' &&
        plugin.groupId === pluginScope &&
        active.serverId === serverState?.serverId,
    )
    .filter(
      (plugin, _index, all) =>
        !all.some(
          (other) => other.pack.id === plugin.pack.id && other.pack.version > plugin.pack.version,
        ),
    )
  const slotContext = {
    conversation: active,
    profile: readyState.profile,
    draft,
    setDraft,
    send: () => void sendMessage(),
    server: serverState,
  }
  const renderSlot = (name: string, message?: ChatMessage) => (
    <div className="slot-surface" data-ui-slot-surface={name}>
      <UiSlot
        name={name}
        entries={slotEntries}
        context={message ? { ...slotContext, message } : slotContext}
      />
      <GroupPluginPlacement
        key={`${serverState?.serverId}:${serverState?.userId}:${active.id}:${name}`}
        slot={name}
        count={groupPlugins.filter((plugin) => plugin.pack.slot === name).length}
      >
        {groupPlugins
          .filter((plugin) => plugin.pack.slot === name)
          .map((plugin) => (
            <GroupPluginView
              key={`${serverState?.serverId}:${serverState?.userId}:${plugin.groupId}:${plugin.pack.id}:${plugin.digest}`}
              plugin={plugin}
              userId={serverState?.userId ?? ''}
              members={
                serverState?.directory
                  ? pluginScopeMembers(serverState.directory, plugin.groupId).map((m) => m.id)
                  : []
              }
              onError={setToast}
            />
          ))}
      </GroupPluginPlacement>
    </div>
  )

  function selectConversation(id: string) {
    historyRequestRef.current++
    setHistoryWindow(null)
    setHistoryBusy(false)
    setHistoryFailure(null)
    setHighlightMessage(null)
    const navigation = historyRequestRef.current
    void api.focusChatWindow?.().catch(() => undefined)
    setState((current) =>
      current
        ? {
            ...current,
            activeConversationId: id,
            conversations: current.conversations.map((item) =>
              item.id === id && !item.serverId ? { ...item, unread: 0 } : item,
            ),
          }
        : current,
    )
    requestAnimationFrame(() => {
      if (navigation === historyRequestRef.current) reading.jumpToLatest()
    })
  }
  async function changeConversationOptions(patch: { pinned?: boolean; muted?: boolean }) {
    try {
      const saved = await api.setConversationOptions(active!.id, patch)
      setState((current) =>
        current
          ? {
              ...current,
              conversations: current.conversations.map((c) =>
                c.id === active!.id ? { ...c, ...saved } : c,
              ),
            }
          : current,
      )
    } catch (error) {
      setToast(errorText(error))
    }
  }
  async function locateUnread() {
    const id = active!.id,
      request = historyRequestRef.current
    try {
      const first =
        active!.unread > 0
          ? await api.getFirstUnread(id)
          : entryUnread?.id === id
            ? entryUnread.first
            : await api.getFirstUnread(id)
      if (request !== historyRequestRef.current || stateRef.current?.activeConversationId !== id)
        return
      if (first) await loadHistory(id, { around: first })
      else setToast('没有未读消息')
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function loadHistory(conversationId: string, input: HistoryInput = {}) {
    const request = ++historyRequestRef.current
    setHistoryBusy(true)
    setHistoryFailure(null)
    reading.pauseReading()
    try {
      // Flush local AI edits before reading SQLite; network messages are already durable.
      if (stateRef.current) await api.saveState(stateRef.current)
      const page = await api.getChatHistory(conversationId, input)
      if (request !== historyRequestRef.current) return
      setHistoryWindow({ ...page, conversationId })
      setHighlightMessage(input.around ?? null)
      if (!input.around)
        requestAnimationFrame(() => {
          if (request === historyRequestRef.current && reading.scrollRef.current)
            reading.scrollRef.current.scrollTop = 0
        })
    } catch (error) {
      if (request === historyRequestRef.current)
        setHistoryFailure({ conversationId, input, error: errorText(error) })
    } finally {
      if (request === historyRequestRef.current) setHistoryBusy(false)
    }
  }
  function returnToLatest() {
    historyRequestRef.current++
    setHistoryWindow(null)
    setHistoryBusy(false)
    setHistoryFailure(null)
    setHighlightMessage(null)
    const navigation = historyRequestRef.current,
      conversationId = stateRef.current?.activeConversationId
    requestAnimationFrame(() => {
      if (
        navigation === historyRequestRef.current &&
        stateRef.current?.activeConversationId === conversationId
      )
        reading.jumpToLatest()
    })
  }
  function followLocalSend(conversationId: string) {
    const navigation = historyRequestRef.current
    requestAnimationFrame(() => {
      if (
        navigation === historyRequestRef.current &&
        stateRef.current?.activeConversationId === conversationId
      )
        reading.jumpToLatest()
    })
  }
  async function resendMessage(message: ChatMessage) {
    await resendGate.current.run(message.id, async () => {
      setResending((current) => new Set(current).add(message.id))
      try {
        await api.retryChatMessage(message.id)
        setToast('消息已重新加入发送队列，连接可用时自动发送')
      } catch (error) {
        setToast(errorText(error))
      } finally {
        setResending((current) => {
          const next = new Set(current)
          next.delete(message.id)
          return next
        })
      }
    })
  }

  async function sendMessage(voiceAttachment?: AttachmentRef) {
    const text = draft.trim()
    const attachment = voiceAttachment ?? pendingAttachment
    if ((!text && !attachment) || !active) return
    if (historic) returnToLatest()
    if (attachment && active.transportId !== 'builtin.central') {
      setToast('文件和语音需要中心服务器会话')
      return
    }
    if (messages.some((message) => message.status === 'streaming')) {
      setToast('请等待当前回复结束，或先停止生成')
      return
    }
    if (active.kind === 'assistant') {
      await sendAssistantMessage(text)
      return
    }
    const now = Date.now()
    const clientMessageId = uid()
    if (active.transportId === 'builtin.central') {
      if (humanSendsRef.current.has(active.id)) return
      const plugin = transportRegistry.get(active.transportId)
      if (!plugin) {
        setToast('当前会话的传输插件不可用')
        return
      }
      humanSendsRef.current.add(active.id)
      try {
        await plugin
          .create()
          .send({
            clientMessageId,
            conversationId: active.id,
            text,
            createdAt: now,
            ...(attachment ? { attachmentId: attachment.id, attachmentRef: attachment } : {}),
            ...(chatDraft.quoteMessageId ? { quoteMessageId: chatDraft.quoteMessageId } : {}),
          })
        chatDraft.consume(attachment)
        followLocalSend(active.id)
      } catch (error) {
        setToast(errorText(error))
      } finally {
        humanSendsRef.current.delete(active.id)
      }
      return
    }
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
      ...(active.serverId ? { serverId: active.serverId } : {}),
      ...(attachment ? { attachment } : {}),
    }
    setDraft('')
    setPendingAttachment(null)
    setState((current) => (current ? appendMessage(current, outgoing) : current))
    followLocalSend(active.id)

    const plugin = transportRegistry.get(active.transportId)
    if (!plugin) {
      setState((current) =>
        current ? updateMessageStatus(current, active.id, clientMessageId, 'failed') : current,
      )
      setToast('当前会话的传输插件不可用')
      return
    }

    const transport = plugin.create()
    try {
      await transport.connect()
      const receipt = await transport.send({
        clientMessageId,
        conversationId: active.id,
        text,
        createdAt: now,
        ...(attachment ? { attachmentId: attachment.id, attachmentRef: attachment } : {}),
      })
      setState((current) =>
        current
          ? active.transportId === 'builtin.central'
            ? {
                ...current,
                messages: {
                  ...current.messages,
                  [active.id]: (current.messages[active.id] ?? []).map((item) =>
                    item.id === clientMessageId
                      ? {
                          ...item,
                          id: receipt.eventId,
                          status: 'sent',
                          createdAt: receipt.acceptedAt,
                        }
                      : item,
                  ),
                },
              }
            : updateMessageStatus(current, active.id, clientMessageId, 'sent')
          : current,
      )
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
        window.setTimeout(
          () => setState((current) => (current ? appendMessage(current, reply) : current)),
          260,
        )
      }
    } catch (error) {
      console.error(error)
      setState((current) =>
        current ? updateMessageStatus(current, active.id, clientMessageId, 'failed') : current,
      )
      setToast('消息发送失败')
    } finally {
      try {
        await transport.disconnect()
      } catch (error) {
        console.error('[transport] disconnect failed', error)
      }
    }
  }

  async function sendAssistantMessage(text: string, retry?: ChatMessage) {
    if (!active) return
    if (startingConversationsRef.current.has(active.id)) return
    if (hostStatusRef.current.state !== 'ready') {
      setToast('PC Host 还没有就绪，暂时不能生成回复')
      return
    }
    const now = Date.now()
    const retryPlan = retry ? planAssistantRetry(messages, retry.id) : null
    if (retry && !retryPlan) {
      setToast('只能重试最近一次未完成的回复')
      return
    }
    const userId = retryPlan?.user.id ?? uid()
    const assistantId = uid()
    const streamId = uid()
    const conversationId = active.id
    startingConversationsRef.current.add(conversationId)
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
      replyToId: userId,
      ...(retry ? { retryOfId: retry.id } : {}),
    }
    const transcript = retryPlan?.transcript ?? toModelTranscript(messages, text)
    if (!retry) setDraft('')
    streamIdsRef.current.set(assistantId, streamId)
    setState((current) => {
      if (!current) return current
      const base = retry
        ? {
            ...current,
            messages: {
              ...current.messages,
              [conversationId]: (current.messages[conversationId] ?? []).map((message) =>
                message.id === retry.id ? { ...message, supersededById: assistantId } : message,
              ),
            },
          }
        : appendMessage(current, userMessage)
      return drainModelEvents(appendMessage(base, assistantMessage), pendingModelEventsRef.current)
    })
    followLocalSend(conversationId)
    try {
      const ref = await api.startModelChat({
        streamId,
        conversationId,
        assistantMessageId: assistantId,
        messages: transcript,
      })
      if (ref.generation !== hostStatusRef.current.generation) {
        setState((current) => (current ? interruptStreamingMessages(current) : current))
        void api.cancelModelChat(streamId).catch(() => undefined)
        return
      }
      setState((current) =>
        current ? updateMessageStatus(current, conversationId, userId, 'sent') : current,
      )
    } catch (error) {
      streamIdsRef.current.delete(assistantId)
      setState((current) => {
        if (!current) return current
        const failedUser = updateMessageStatus(current, conversationId, userId, 'failed')
        return applyModelChatUpdate(failedUser, {
          type: 'failed',
          conversationId,
          assistantMessageId: assistantId,
          partialText: '',
          errorMessage: errorText(error),
        })
      })
      setToast(errorText(error))
    } finally {
      startingConversationsRef.current.delete(conversationId)
    }
  }

  async function cancelGeneration() {
    if (!active) return
    const streaming = (state?.messages[active.id] ?? []).find(
      (message) => message.status === 'streaming',
    )
    if (!streaming) return
    const streamId = streamIdsRef.current.get(streaming.id)
    streamIdsRef.current.delete(streaming.id)
    setState((current) => (current ? interruptStreamingMessages(current, active.id) : current))
    if (!streamId || hostStatusRef.current.state !== 'ready') return
    try {
      await api.cancelModelChat(streamId)
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'cancel failed')
    }
  }

  async function saveModelSettings(input: ModelSettingsInput) {
    const snapshot = await api.setModelSettings(input)
    setModelSettings(snapshot)
    setToast(snapshot.hasApiKey ? '模型设置已保存，密钥只留在本机 Host' : '模型设置已保存')
  }

  async function clearModelKey() {
    const snapshot = await api.setModelSettings({
      clearApiKey: true,
    })
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
    } catch (error) {
      console.error(error)
      setToast(`插件动作“${action.label}”执行失败`)
    }
  }

  async function togglePlugin(plugin: PluginSnapshot) {
    const enable = plugin.status !== 'active'
    try {
      if (plugin.trust === 'builtin')
        await (await import('./app-composition')).setBuiltinEnabled(plugin.manifest.id, enable)
      else if (enable) await pluginRuntime.activate(plugin.manifest.id)
      else await pluginRuntime.deactivate(plugin.manifest.id)
      setToast(`${plugin.manifest.displayName}已${enable ? '启用' : '停用'}`)
    } catch (error) {
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
      const result = await api.pingHost()
      setToast(`PC Host G${result.generation} 响应正常 · ${result.roundTripMs} ms`)
    } catch (error) {
      console.error(error)
      setToast('PC Host ping 失败，Supervisor 将尝试恢复')
    }
  }

  async function toggleHostPlugin(plugin: HostPluginSnapshot, enabled = plugin.status !== 'active') {
    if (hostPluginBusy) return
    setHostPluginBusy(true)
    try {
      const catalog = await api.setHostPluginEnabled(plugin.id, enabled)
      setHostPlugins(catalog.plugins)
      void api
        .getModelSettings()
        .then(setModelSettings)
        .catch(() => setModelSettings(null))
    } catch (error) {
      console.error(error)
      setToast(errorText(error))
      await api.getHostPlugins().then(catalog => setHostPlugins(catalog.plugins)).catch(() => undefined)
    } finally {
      setHostPluginBusy(false)
    }
  }

  async function refreshPluginDrafts() {
    const inspection = await api.inspectPluginDrafts()
    setPluginDrafts(inspection)
  }

  async function createPluginDraft(manifestJson: string, source: string) {
    if (hostPluginBusy || hostStatusRef.current.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const result = await api.createPluginDraft({
        manifestJson,
        source,
      })
      setPluginDraftReport(result.summary)
      await refreshPluginDrafts()
      setToast(result.persisted ? '草稿已保存，尚未安装' : '草稿未保存')
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'draft')
      setToast(errorText(error))
    } finally {
      setHostPluginBusy(false)
    }
  }

  async function diagnosePluginDraft(draftId: string) {
    if (hostPluginBusy || hostStatusRef.current.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const report = await api.diagnosePluginDraft(draftId)
      setPluginDraftReport(report.summary)
      await refreshPluginDrafts()
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'diagnose')
      setToast(errorText(error))
    } finally {
      setHostPluginBusy(false)
    }
  }

  async function installPluginDraft(draftId: string) {
    if (hostPluginBusy || hostStatusRef.current.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const alreadyInstalled = hostPlugins.some((plugin) => plugin.id === draftId)
      const result = await api.installPluginDraft({
        draftId,
        confirmed: true,
      })
      setPluginDraftReport(result.summary)
      if (
        hostStatusRef.current.state === 'ready' &&
        hostStatusRef.current.generation === result.catalog.generation
      ) {
        setHostPlugins(result.catalog.plugins)
      }
      await refreshPluginDrafts()
      const installedPlugin = result.catalog.plugins.find((plugin) => plugin.id === draftId)
      const composerInstalled =
        result.summary.includes('输入框动作') || (installedPlugin?.composerActions.length ?? 0) > 0
      setToast(
        result.installed
          ? alreadyInstalled
            ? composerInstalled
              ? '输入框动作已更新'
              : '文本工具已更新'
            : composerInstalled
              ? '输入框动作已安装，可以在输入框使用'
              : '文本工具已安装，可以在输入框使用'
          : alreadyInstalled
            ? result.summary
            : '草稿没有安装',
      )
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'install')
      setToast(errorText(error))
    } finally {
      setHostPluginBusy(false)
    }
  }

  async function runHostTool(pluginId: string, toolId: string, label: string) {
    if (hostPluginBusy || hostStatus.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const result = await api.invokeHostTool(pluginId, toolId, draft)
      if (
        hostStatusRef.current.state !== 'ready' ||
        hostStatusRef.current.generation !== result.generation
      )
        return
      setDraft((draft) =>
        result.replaceDraft ? result.text : draft.trim() ? `${draft}\n${result.text}` : result.text,
      )
      setToast(`${label}已写入输入框`)
    } catch (error) {
      console.error(error)
      setToast('工具暂时不可用，请稍后重试')
    } finally {
      setHostPluginBusy(false)
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      shouldSendOnEnter({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
      })
    ) {
      event.preventDefault()
      void sendMessage()
    }
  }

  function createConversation(title: string, kind: Conversation['kind']) {
    if (kind !== 'assistant') {
      setShowNewChat(false)
      setShowServer(true)
      setToast('请在中心服务器添加好友或创建群聊')
      return
    }
    const clean = title.trim()
    if (!clean) return
    const id = uid()
    const next: Conversation = {
      id,
      title: clean,
      subtitle: 'AI 助手',
      avatar: initials(clean),
      accent: ['#6671e5', '#1e9c76', '#dc7d4c', '#a361c2'][readyState.conversations.length % 4]!,
      kind,
      unread: 0,
      pinned: false,
      updatedAt: Date.now(),
      transportId: 'builtin.local-demo',
    }
    setState((current) =>
      current
        ? {
            ...current,
            conversations: [next, ...current.conversations],
            messages: { ...current.messages, [id]: [] },
            activeConversationId: id,
          }
        : current,
    )
    setShowNewChat(false)
  }

  return {
    kind: 'ready' as const,
    active,
    appearance,
    canRetryLast,
    cancelGeneration,
    changeConversationOptions,
    chatDraft,
    clearModelKey,
    composerActions,
    conversationFilter,
    conversationSearch,
    createConversation,
    createPluginDraft,
    diagnosePluginDraft,
    draft,
    entryUnread,
    filtered,
    forwardDialog,
    groupPluginSlot,
    highlightMessage,
    historic,
    historyBusy,
    historyFailure,
    historyPositioning,
    hostPluginBusy,
    hostPlugins,
    hostStatus,
    installPluginDraft,
    lastMessage,
    loadHistory,
    locateUnread,
    membersById,
    messages,
    modelSettings,
    openCurrentContact,
    openProfile,
    pendingAttachment,
    pingHost,
    pluginDraftReport,
    pluginDrafts,
    pluginScope,
    plugins,
    profileTarget,
    query,
    quotedMessage,
    reading,
    readyState,
    renderSlot,
    resendMessage,
    resending,
    retractConfirm,
    returnToLatest,
    runComposerAction,
    runHostTool,
    saveModelSettings,
    selectConversation,
    sendAssistantMessage,
    sendMessage,
    serverState,
    setConversationFilter,
    setDraft,
    setEntryUnread,
    setForwardDialog,
    setGroupPluginSlot,
    setPendingAttachment,
    setProfileTarget,
    setQuery,
    setRetractConfirm,
    setShowContacts,
    setShowDetails,
    setShowMessageSearch,
    setShowNewChat,
    setShowPlugins,
    setShowServer,
    setShowSettings,
    setToast,
    showContacts,
    showDetails,
    showMessageSearch,
    showNewChat,
    showPlugins,
    showServer,
    showSettings,
    slotContext,
    slotEntries,
    state,
    stateRef,
    toast,
    toggleHostPlugin,
    togglePlugin,
    visibleMessages,
  }
}

export type WorkspaceViewContext = Extract<
  ReturnType<typeof useWorkspaceController>,
  { kind: 'ready' }
>
