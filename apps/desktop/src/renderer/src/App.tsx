import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  Bot,
  ChevronDown,
  CircleHelp,
  Copy,
  Reply,
  Forward,
  Undo2,
  Info,
  BellOff,
  MessageCircleMore,
  Moon,
  Paperclip,
  PencilLine,
  Pin,
  Phone,
  PlugZap,
  Search,
  SendHorizontal,
  Server,
  Settings,
  Smile,
  Sparkles,
  Sun,
  Users,
  Video,
  X,
} from 'lucide-react'
import {
  applyModelChatUpdate,
  authorToolLabel,
  createSeedState,
  formatRelativeTime,
  formatMessageDay,
  interruptStreamingMessages,
  normalizeState,
  mergeCentralProjection,
  mergeHistoryProjection,
  redactMessageForRetraction,
  planAssistantRetry,
  toModelTranscript,
  type AuthorToolNote,
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
import type {
  HostPluginSnapshot,
  HostStatusSnapshot,
  ModelProviderMode,
  ModelSettingsSnapshot,
  PluginDraftInspection,
} from '@more-than-chat/protocol'
import type { ModelClientEvent, ModelSettingsInput } from './global'
import {
  composerActionRegistry,
  pluginRuntime,
  startBundledPlugins,
  transportRegistry,
} from './plugin-host'
import { uiSlotRegistry } from './plugin-host'
import type { UiSlotContribution } from '@more-than-chat/plugin-runtime'
import type {
  AttachmentRef,
  GroupPlugin,
  ServerSnapshot,
} from '@more-than-chat/central-protocol'
import {
  UI_SLOTS,
  type UiSlot as UiSlotName,
} from '@more-than-chat/central-protocol'
import { NetworkPanel, GroupPluginView } from './NetworkPanel'
import { GroupDraftSubmission } from './GroupDraftSubmission'
import { slotLabels } from './group-plugin-presentation'
import { shouldSendOnEnter } from './composer-input'
import { ChatComposer } from './ChatComposer'
import { MessageAttachment } from './MessageAttachment'
import { UiSlot } from './UiSlot'
import { MessageMarkdown } from './MessageMarkdown'
import { AppearancePicker } from './AppearancePicker'
import { DesktopSettings } from './DesktopSettings'
import { HistorySettings } from './HistorySettings'
import { setThemePreference, useAppearance } from './theme'
import { useChatDraft, clearRetractedDraftQuotes } from './chat-drafts'
import { useChatReading } from './use-chat-reading'
import { MessageSearch } from './MessageSearch'
import { GroupManager } from './GroupManager'

function uid(): string {
  return crypto.randomUUID()
}

function initials(value: string): string {
  return [...value.trim()].slice(0, 2).join('').toUpperCase() || '?'
}

export function App() {
  const appearance = useAppearance()
  const [state, setState] = useState<ChatState | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [serverState, setServerState] = useState<ServerSnapshot | null>(null)
  const [showServer, setShowServer] = useState(false)
  const chatDraft = useChatDraft(state?.activeConversationId ?? '')
  const pendingAttachment = chatDraft.attachment
  const setPendingAttachment = chatDraft.setAttachment
  const [slotEntries, setSlotEntries] = useState<
    RegisteredContribution<UiSlotContribution>[]
  >(() => uiSlotRegistry.list())
  const [groupPluginSlot, setGroupPluginSlot] =
    useState<UiSlotName>('chat.details')
  const [query, setQuery] = useState('')
  const draft = chatDraft.text
  const setDraft = chatDraft.setText
  const [showMessageSearch,setShowMessageSearch] = useState(false)
  const [highlightMessage,setHighlightMessage] = useState<string|null>(null)
  const [quotedMessage,setQuotedMessage]=useState<ChatMessage|null>(null)
  const [historyRevision,setHistoryRevision]=useState(0)
  const [forwardDialog,setForwardDialog]=useState<{message:ChatMessage;clientMessageId:string}|null>(null)
  const [retractConfirm,setRetractConfirm]=useState<ChatMessage|null>(null)
  const [messageActionBusy,setMessageActionBusy]=useState(false)
  type HistoryPage = Awaited<ReturnType<Window['moreThanChat']['getChatHistory']>>
  const [historyWindow,setHistoryWindow] = useState<(HistoryPage & {conversationId:string})|null>(null)
  const [historyBusy,setHistoryBusy] = useState(false)
  const historyRequestRef=useRef(0)
  const [showDetails, setShowDetails] = useState(() => window.innerWidth > 1080)
  const [showPlugins, setShowPlugins] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<PluginSnapshot[]>(() =>
    pluginRuntime.list(),
  )
  const [composerActions, setComposerActions] = useState<
    RegisteredContribution<ComposerAction>[]
  >(() => composerActionRegistry.list())
  const [hostStatus, setHostStatus] = useState<HostStatusSnapshot>({
    state: 'starting',
    generation: 0,
  })
  const [hostPlugins, setHostPlugins] = useState<HostPluginSnapshot[]>([])
  const [hostPluginBusy, setHostPluginBusy] = useState(false)
  const [pluginDrafts, setPluginDrafts] =
    useState<PluginDraftInspection | null>(null)
  const [pluginDraftReport, setPluginDraftReport] = useState<string | null>(
    null,
  )
  const [modelSettings, setModelSettings] =
    useState<ModelSettingsSnapshot | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const streamIdsRef = useRef(new Map<string, string>())
  const startingConversationsRef = useRef(new Set<string>())
  const humanSendsRef = useRef(new Set<string>())
  const pendingModelEventsRef = useRef<ModelClientEvent[]>([])
  const hostStatusRef = useRef(hostStatus)
  hostStatusRef.current = hostStatus
  const stateRef = useRef(state)
  stateRef.current = state
  const [navigation,setNavigation]=useState<{id:string;conversationId:string}|null>(null)
  useEffect(()=>{
    let changed=false,live=true
    const stop=window.moreThanChat.onOpenConversation(value=>{changed=true;if(live)setNavigation(value)})
    void window.moreThanChat.getPendingNavigation().then(value=>{if(live&&!changed)setNavigation(value)}).catch(()=>undefined)
    return()=>{live=false;stop()}
  },[])
  useEffect(()=>{
    if(!navigation||!state)return
    const target=state.conversations.find(c=>c.id===navigation.conversationId&&!c.unavailable)
    if(target&&state.activeConversationId!==target.id){
      selectConversation(target.id)
      setShowSettings(false);setShowServer(false);setShowPlugins(false);setShowMessageSearch(false);setShowNewChat(false)
      setForwardDialog(null);setRetractConfirm(null)
      return
    }
    if(target){
      setShowSettings(false);setShowServer(false);setShowPlugins(false);setShowMessageSearch(false);setShowNewChat(false)
      setForwardDialog(null);setRetractConfirm(null)
      historyRequestRef.current++;setHistoryWindow(null);setHistoryBusy(false)
    }
    void window.moreThanChat.navigationApplied(navigation.id).catch(()=>undefined)
    setNavigation(null)
  },[navigation,state])
  const saveTimerRef = useRef<number | undefined>(undefined)
  useLayoutEffect(()=>{
    if(!forwardDialog&&!retractConfirm)return
    const dialog=document.querySelector<HTMLElement>('[data-forward-dialog], [data-retract-dialog]')
    if(!dialog)return
    dialog.tabIndex=-1
    const focusable=()=>[...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    ;(focusable()[0]??dialog).focus()
    const trap=(event:globalThis.KeyboardEvent)=>{
      if(event.key!=='Tab')return
      const controls=focusable(),first=controls[0],last=controls.at(-1)
      if(!first){event.preventDefault();dialog.focus();return}
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
    }
    dialog.addEventListener('keydown',trap)
    return()=>dialog.removeEventListener('keydown',trap)
  },[forwardDialog,retractConfirm,messageActionBusy])

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('.composer-menu')) return
      if(forwardDialog){if(!messageActionBusy)setForwardDialog(null)}
      else if(retractConfirm){if(!messageActionBusy)setRetractConfirm(null)}
      else if (showMessageSearch) setShowMessageSearch(false)
      else if (showServer) setShowServer(false)
      else if (showSettings) setShowSettings(false)
      else if (showPlugins) setShowPlugins(false)
      else if (showNewChat) setShowNewChat(false)
      else if (window.innerWidth <= 1080) setShowDetails(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [showServer, showSettings, showPlugins, showNewChat, showMessageSearch, forwardDialog,retractConfirm,messageActionBusy])

  useEffect(() => {
    const dispose = uiSlotRegistry.subscribe(() =>
      setSlotEntries(uiSlotRegistry.list()),
    )
    setSlotEntries(uiSlotRegistry.list())
    return () => {
      void dispose()
    }
  }, [])

  useEffect(() => {
    let changed = false
    if (typeof window.moreThanChat.onServerState !== 'function') {
      setToast('中心服务功能需要完整重启客户端')
      return
    }
    const dispose = window.moreThanChat.onServerState((snapshot) => {
      changed = true
      setServerState(snapshot)
    })
    const chatDispose = window.moreThanChat.onCentralChat((value) => {
      const imported=(value as {historyImported?:boolean})?.historyImported===true
      setState((current) =>
        current ? (imported?mergeHistoryProjection:mergeCentralProjection)(current, value as ChatState) : current,
      )
      if(imported){
        historyRequestRef.current++
        setHistoryWindow(null);setHistoryBusy(false);setHighlightMessage(null)
        setForwardDialog(null);setRetractConfirm(null);setShowMessageSearch(false)
        setQuotedMessage(null);setHistoryRevision(revision=>revision+1)
      }
      const change=(value as {retraction?:import('@more-than-chat/central-protocol').MessageRetraction&{serverId:string}})?.retraction
      if(change){
        clearRetractedDraftQuotes(change.serverId,change.messageId)
        setHistoryWindow(current=>current?{...current,messages:current.messages.map(m=>redactMessageForRetraction(m,change))}:current)
        setForwardDialog(current=>current?.message.id===change.messageId&&current.message.serverId===change.serverId?null:current)
        setRetractConfirm(current=>current?.id===change.messageId&&current.serverId===change.serverId?null:current)
      }
    })
    void window.moreThanChat
      .getServerState()
      .then((snapshot) => {
        if (!changed) setServerState(snapshot)
      })
      .catch(() => undefined)
    return () => {
      dispose()
      chatDispose()
    }
  }, [])

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

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = window.moreThanChat.onHostStatusChanged((status) => {
      receivedEvent = true
      if (active) setHostStatus(status)
    })
    void window.moreThanChat
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
  }, [])

  useEffect(() => {
    if (hostStatus.state !== 'ready') {
      setHostPlugins([])
      return
    }
    let active = true
    void window.moreThanChat
      .getHostPlugins()
      .then((catalog) => {
        if (active && catalog.generation === hostStatus.generation)
          setHostPlugins(catalog.plugins)
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
  }, [hostStatus.state, hostStatus.generation])

  useEffect(() => {
    if (!showPlugins || hostStatus.state !== 'ready') return
    let active = true
    void window.moreThanChat
      .inspectPluginDrafts()
      .then((inspection) => {
        if (active) setPluginDrafts(inspection)
      })
      .catch((error) => {
        if (active) {
          console.error(
            error instanceof Error ? error.message : 'plugin drafts',
          )
          setToast('无法读取插件草稿')
        }
      })
    return () => {
      active = false
    }
  }, [showPlugins, hostStatus.state, hostStatus.generation])

  useEffect(() => {
    if (hostStatus.state === 'ready') return
    setState((current) =>
      current ? interruptStreamingMessages(current) : current,
    )
  }, [hostStatus.state, hostStatus.generation])

  useEffect(() => {
    if (hostStatus.state !== 'ready') return
    let alive = true
    void window.moreThanChat
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
  }, [hostStatus.state, hostStatus.generation])

  useEffect(() => {
    return window.moreThanChat.onModelChatEvent((event) => {
      if (event.generation !== hostStatusRef.current.generation) return
      if (
        event.type === 'author-tool' &&
        event.phase === 'finished' &&
        event.draft
      ) {
        void window.moreThanChat
          .inspectPluginDrafts()
          .then((inspection) => {
            if (event.generation === hostStatusRef.current.generation)
              setPluginDrafts(inspection)
          })
          .catch(() => undefined)
      }
      setState((current) =>
        current
          ? applyIncomingModelEvent(
              current,
              event,
              pendingModelEventsRef.current,
            )
          : current,
      )
      if (event.type === 'failed') setToast(event.errorMessage)
      if (event.type !== 'delta' && event.type !== 'author-tool')
        streamIdsRef.current.delete(event.assistantMessageId)
    })
  }, [])

  useEffect(() => {
    void window.moreThanChat
      .loadState()
      .then(async (value) => {
        const initial = value ? normalizeState(value) : createSeedState()
        // A newly imported profile can authenticate immediately with existing friends.
        // Persist its seed before exposing Connect, so Main can project those entries.
        if (!value) await window.moreThanChat.saveState(initial)
        setState(initial)
      })
      .catch(() => setLoadError(true))
  }, [])

  useEffect(() => {
    if (!state) return
    if (saveTimerRef.current !== undefined) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined
      void window.moreThanChat.saveState(stateRef.current).catch(() => {
        setToast('本地保存失败，请稍后重试')
      })
    }, 180)
  }, [state])

  useEffect(
    () =>
      window.moreThanChat.onBeforeClose(async () => {
        if (saveTimerRef.current !== undefined)
          window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = undefined
        if (stateRef.current)
          await window.moreThanChat.saveState(stateRef.current)
      }),
    [],
  )

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const active = state?.conversations.find(
    (item) => item.id === state.activeConversationId,
  )
  const messages = active && state ? (state.messages[active.id] ?? []) : []
  useEffect(()=>{
    let cancelled=false
    setQuotedMessage(null)
    if(!chatDraft.quoteMessageId)return
    void window.moreThanChat.getChatMessage(chatDraft.quoteMessageId).then(message=>{
      if(cancelled)return
      if(message&&message.conversationId===active?.id&&!message.retractedAt)setQuotedMessage(message)
      else chatDraft.setQuoteMessageId(null)
    }).catch(()=>{if(!cancelled)chatDraft.setQuoteMessageId(null)})
    return()=>{cancelled=true}
  },[active?.id,chatDraft.quoteMessageId,historyRevision])
  const historic=historyWindow?.conversationId===active?.id ? historyWindow : null
  const visibleMessages=historic?.messages ?? messages
  const reading = useChatReading(active?.id,visibleMessages,showMessageSearch || showSettings || showPlugins || showServer || showNewChat || Boolean(highlightMessage) || Boolean(historic) || historyBusy || Boolean(forwardDialog) || Boolean(retractConfirm))
  useLayoutEffect(()=>{
    if(!highlightMessage)return
    reading.pauseReading()
    document.querySelector('[data-message-id="'+CSS.escape(highlightMessage)+'"]')?.scrollIntoView({block:'center',behavior:'instant'})
    const clear=window.setTimeout(()=>setHighlightMessage(null),3000)
    return()=>{clearTimeout(clear)}
  },[highlightMessage,active?.id,historic])
  const filtered = useMemo(() => {
    if (!state) return []
    const needle = query.trim().toLocaleLowerCase()
    return [...state.conversations]
      .filter(item=>!item.serverId || !item.unavailable)
      .filter(
        (item) => !needle || item.title.toLocaleLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
      )
  }, [query, state])

  if (!state || !active) return <LoadingScreen error={loadError} />
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
        plugin.groupId === active.targetId &&
        active.serverId === serverState?.serverId,
    )
    .filter(
      (plugin, _index, all) =>
        !all.some(
          (other) =>
            other.pack.id === plugin.pack.id &&
            other.pack.version > plugin.pack.version,
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
      {groupPlugins
        .filter((plugin) => plugin.pack.slot === name)
        .map((plugin) => (
          <GroupPluginView
            key={`${serverState?.serverId}:${serverState?.userId}:${plugin.groupId}:${plugin.pack.id}:${plugin.digest}`}
            plugin={plugin}
            userId={serverState?.userId ?? ''}
            members={serverState?.directory?.groups.find(g=>g.id===plugin.groupId)?.members.map(m=>m.id)??[]}
            onError={setToast}
          />
        ))}
    </div>
  )

  function selectConversation(id: string) {
    historyRequestRef.current++;setHistoryWindow(null);setHistoryBusy(false);setHighlightMessage(null)
    void window.moreThanChat.focusChatWindow?.().catch(()=>undefined)
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
  }
  async function changeConversationOptions(patch:{pinned?:boolean;muted?:boolean}) {
    try {
      const saved=await window.moreThanChat.setConversationOptions(active!.id,patch)
      setState(current=>current?{...current,conversations:current.conversations.map(c=>c.id===active!.id?{...c,...saved}:c)}:current)
    } catch(error){setToast(errorText(error))}
  }

  async function loadHistory(conversationId:string,input:{before?:number;after?:number;around?:string}={}) {
    const request=++historyRequestRef.current
    setHistoryBusy(true);reading.pauseReading()
    try {
      // Flush local AI edits before reading SQLite; network messages are already durable.
      if(stateRef.current)await window.moreThanChat.saveState(stateRef.current)
      const page=await window.moreThanChat.getChatHistory(conversationId,input)
      if(request!==historyRequestRef.current)return
      setHistoryWindow({...page,conversationId});setHighlightMessage(input.around??null)
      if(!input.around)requestAnimationFrame(()=>{if(request===historyRequestRef.current&&reading.scrollRef.current)reading.scrollRef.current.scrollTop=0})
    }catch(error){if(request===historyRequestRef.current)setToast(errorText(error))}
    finally{if(request===historyRequestRef.current)setHistoryBusy(false)}
  }
  function returnToLatest() {
    historyRequestRef.current++;setHistoryWindow(null);setHistoryBusy(false);setHighlightMessage(null)
    requestAnimationFrame(()=>reading.jumpToLatest())
  }
  async function forwardTo(conversationId:string) {
    if(!forwardDialog||messageActionBusy)return
    setMessageActionBusy(true)
    try{await window.moreThanChat.forwardChatMessage({messageId:forwardDialog.message.id,conversationId,clientMessageId:forwardDialog.clientMessageId});setForwardDialog(null);setToast('转发已加入发送队列')}
    catch(error){setToast(errorText(error))}finally{setMessageActionBusy(false)}
  }
  async function confirmRetraction() {
    if(!retractConfirm||messageActionBusy)return
    setMessageActionBusy(true)
    try{await window.moreThanChat.retractChatMessage(retractConfirm.id);setRetractConfirm(null);setToast('消息已撤回')}
    catch(error){setToast(errorText(error))}finally{setMessageActionBusy(false)}
  }

  async function sendMessage(voiceAttachment?: AttachmentRef) {
    const text = draft.trim()
    const attachment = voiceAttachment ?? pendingAttachment
    if ((!text && !attachment) || !active) return
    if(historic)returnToLatest()
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
      if(humanSendsRef.current.has(active.id))return
      const plugin=transportRegistry.get(active.transportId)
      if(!plugin){setToast('当前会话的传输插件不可用');return}
      humanSendsRef.current.add(active.id)
      try {
        await plugin.create().send({clientMessageId,conversationId:active.id,text,createdAt:now,...(attachment?{attachmentId:attachment.id}:{}),...(chatDraft.quoteMessageId?{quoteMessageId:chatDraft.quoteMessageId}:{})})
        chatDraft.consume(attachment)
      }catch(error){setToast(errorText(error))}finally{humanSendsRef.current.delete(active.id)}
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
    setState((current) =>
      current ? appendMessage(current, outgoing) : current,
    )

    const plugin = transportRegistry.get(active.transportId)
    if (!plugin) {
      setState((current) =>
        current
          ? updateMessageStatus(current, active.id, clientMessageId, 'failed')
          : current,
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
        ...(attachment ? { attachmentId: attachment.id } : {}),
      })
      setState((current) =>
        current
          ? active.transportId === 'builtin.central'
            ? {
                ...current,
                messages: {
                  ...current.messages,
                  [active.id]: (current.messages[active.id] ?? []).map(
                    (item) =>
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
          () =>
            setState((current) =>
              current ? appendMessage(current, reply) : current,
            ),
          260,
        )
      }
    } catch (error) {
      console.error(error)
      setState((current) =>
        current
          ? updateMessageStatus(current, active.id, clientMessageId, 'failed')
          : current,
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
    const transcript =
      retryPlan?.transcript ?? toModelTranscript(messages, text)
    if (!retry) setDraft('')
    streamIdsRef.current.set(assistantId, streamId)
    setState((current) => {
      if (!current) return current
      const base = retry
        ? {
            ...current,
            messages: {
              ...current.messages,
              [conversationId]: (current.messages[conversationId] ?? []).map(
                (message) =>
                  message.id === retry.id
                    ? { ...message, supersededById: assistantId }
                    : message,
              ),
            },
          }
        : appendMessage(current, userMessage)
      return drainModelEvents(
        appendMessage(base, assistantMessage),
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
        setState((current) =>
          current ? interruptStreamingMessages(current) : current,
        )
        void window.moreThanChat
          .cancelModelChat(streamId)
          .catch(() => undefined)
        return
      }
      setState((current) =>
        current
          ? updateMessageStatus(current, conversationId, userId, 'sent')
          : current,
      )
    } catch (error) {
      streamIdsRef.current.delete(assistantId)
      setState((current) => {
        if (!current) return current
        const failedUser = updateMessageStatus(
          current,
          conversationId,
          userId,
          'failed',
        )
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
    setState((current) =>
      current ? interruptStreamingMessages(current, active.id) : current,
    )
    if (!streamId || hostStatusRef.current.state !== 'ready') return
    try {
      await window.moreThanChat.cancelModelChat(streamId)
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'cancel failed')
    }
  }

  async function saveModelSettings(input: ModelSettingsInput) {
    const snapshot = await window.moreThanChat.setModelSettings(input)
    setModelSettings(snapshot)
    setToast(
      snapshot.hasApiKey
        ? '模型设置已保存，密钥只留在本机 Host'
        : '模型设置已保存',
    )
  }

  async function clearModelKey() {
    const snapshot = await window.moreThanChat.setModelSettings({
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
      if (enable) await pluginRuntime.activate(plugin.manifest.id)
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
      const result = await window.moreThanChat.pingHost()
      setToast(
        `PC Host G${result.generation} 响应正常 · ${result.roundTripMs} ms`,
      )
    } catch (error) {
      console.error(error)
      setToast('PC Host ping 失败，Supervisor 将尝试恢复')
    }
  }

  async function toggleHostPlugin(plugin: HostPluginSnapshot) {
    if (hostPluginBusy || hostStatus.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const catalog = await window.moreThanChat.setHostPluginEnabled(
        plugin.id,
        plugin.status !== 'active',
      )
      if (
        hostStatusRef.current.state === 'ready' &&
        hostStatusRef.current.generation === catalog.generation
      )
        setHostPlugins(catalog.plugins)
    } catch (error) {
      console.error(error)
      setToast('后台插件操作失败，请稍后重试')
    } finally {
      setHostPluginBusy(false)
    }
  }

  async function refreshPluginDrafts() {
    const inspection = await window.moreThanChat.inspectPluginDrafts()
    setPluginDrafts(inspection)
  }

  async function createPluginDraft(manifestJson: string, source: string) {
    if (hostPluginBusy || hostStatusRef.current.state !== 'ready') return
    setHostPluginBusy(true)
    try {
      const result = await window.moreThanChat.createPluginDraft({
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
      const report = await window.moreThanChat.diagnosePluginDraft(draftId)
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
      const alreadyInstalled = hostPlugins.some(
        (plugin) => plugin.id === draftId,
      )
      const result = await window.moreThanChat.installPluginDraft({
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
      const installedPlugin = result.catalog.plugins.find(
        (plugin) => plugin.id === draftId,
      )
      const composerInstalled =
        result.summary.includes('输入框动作') ||
        (installedPlugin?.composerActions.length ?? 0) > 0
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
      const result = await window.moreThanChat.invokeHostTool(
        pluginId,
        toolId,
        draft,
      )
      if (
        hostStatusRef.current.state !== 'ready' ||
        hostStatusRef.current.generation !== result.generation
      )
        return
      setDraft((draft) =>
        result.replaceDraft
          ? result.text
          : draft.trim()
            ? `${draft}\n${result.text}`
            : result.text,
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
    if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
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
      accent: ['#6671e5', '#1e9c76', '#dc7d4c', '#a361c2'][
        readyState.conversations.length % 4
      ]!,
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

  return (
    <div className={`app-shell ${showDetails ? '' : 'details-collapsed'}`}>
      <div className="window-drag-region">
        <span className="window-title">
          <Sparkles size={14} /> MoreThanChat
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

      <nav className="app-rail" aria-label="主导航">
        <button className="brand-mark" aria-label="MoreThanChat">
          <span>M</span>
        </button>
        <div className="rail-actions">
          <RailButton active icon={<MessageCircleMore />} label="聊天" />
          <RailButton
            icon={<Users />}
            label="联系人"
            onClick={() => setShowServer(true)}
          />
          <RailButton
            icon={<PlugZap />}
            label="插件"
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
              setToast('MoreThanChat 0.1 · AI 回复由 PC Host 生成')
            }
          />
          <RailButton
            icon={<Settings />}
            label="设置"
            active={showSettings}
            onClick={() => setShowSettings(true)}
          />
          <div className="profile-avatar" title={serverState?.userId}>
            {readyState.profile.avatar}
            <span className="online-dot" />
          </div>
        </div>
        {renderSlot('app.rail')}
      </nav>

      <aside className="conversation-sidebar">
        <div className="sidebar-heading">
          <div>
            <p className="eyebrow">工作区</p>
            <button className="workspace-name">
              我的空间 <ChevronDown size={15} />
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
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
          />
          <kbd>⌘K</kbd>
        </label>
        <div className="conversation-section-label">
          <span>最近消息</span>
          <span>{filtered.length}</span>
        </div>
        <div className="conversation-list">
          {filtered.map((item) => {
            const last = state.messages[item.id]?.at(-1)
            return (
              <button
                key={item.id}
                data-conversation-id={item.id}
                className={`conversation-item ${item.id === active.id ? 'active' : ''}`}
                onClick={() => selectConversation(item.id)}
              >
                <Avatar conversation={item} />
                <span className="conversation-copy">
                  <span className="conversation-title-row">
                    <strong>{item.title}</strong>
                    <time>{formatRelativeTime(item.updatedAt)}</time>
                  </span>
                  <span className="conversation-preview-row">
                    <span>{item.muted&&<BellOff size={11}/>} {last?.text || (last?.attachment ? last.attachment.durationMs ? '[语音]' : '[文件] '+last.attachment.name : '还没有消息')}</span>
                    {item.unread > 0 && <b className={item.muted?'muted-unread':''}>{item.unread>99?'99+':item.unread}</b>}
                  </span>
                </span>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="empty-search">没有找到相关会话</div>
          )}
        </div>
        {renderSlot('app.sidebar')}
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div
            className="chat-identity"
            data-model-mode={
              active.kind === 'assistant'
                ? (modelSettings?.providerMode ?? 'unknown')
                : 'chat'
            }
          >
            <Avatar conversation={active} small />
            <div>
              <h1>{active.title}</h1>
              <p>
                <span className="status-dot" />{' '}
                {active.kind === 'assistant'
                  ? modelSubtitle(modelSettings)
                  : active.subtitle}
              </p>
            </div>
          </div>
          <div className="header-actions">
            <button className="icon-button" title="搜索聊天记录" onClick={()=>setShowMessageSearch(true)}><Search size={18}/></button>
            <button
              className="icon-button"
              title="语音通话"
              onClick={() => setToast('通话将由 WebRTC 插件提供')}
            >
              <Phone size={18} />
            </button>
            <button
              className="icon-button"
              title="视频通话"
              onClick={() => setToast('视频将由 WebRTC 插件提供')}
            >
              <Video size={19} />
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
        <div className="chat-header-plugins">{renderSlot('chat.header')}</div>

        <section className="message-scroll" aria-live="polite" ref={reading.scrollRef} onScroll={reading.onScroll}>
          {(historic?.hasOlder ?? state.history?.[active.id]?.hasOlder)&&<button className="history-more" data-history-older disabled={historyBusy} onClick={()=>void loadHistory(active.id,{before:(historic?.before ?? state.history?.[active.id]?.before)!})}>{historyBusy?'加载中…':'查看更早的消息'}</button>}
          {historic&&<button className="history-more" data-history-latest onClick={returnToLatest}>正在浏览历史 · 返回最新消息{active.unread>0?' · '+active.unread:''}</button>}
          {visibleMessages.length === 0 ? (
            <div className="empty-conversation">
              <div className="empty-icon">
                <MessageCircleMore />
              </div>
              <h2>开始一段新对话</h2>
              <p>从一条消息开始。聊天记录会保存在这台设备上。</p>
            </div>
          ) : (
            visibleMessages.map((message, index,visible) => (
              <div key={message.id}>
                {(index===0 || new Date(visible[index-1]!.createdAt).toDateString()!==new Date(message.createdAt).toDateString())&&<div className="message-day"><span>{formatMessageDay(message.createdAt)}</span></div>}
                {renderSlot('chat.message.before', message)}
                <MessageBubble
                  message={message}
                  compact={visible[index - 1]?.senderId === message.senderId}
                  highlighted={highlightMessage===message.id}
                  onCopy={()=>void window.moreThanChat.copyChatMessage(message.id).then(()=>setToast('已复制')).catch(e=>setToast(e.message))}
                  onResend={message.serverId && message.role==='self' && ['failed','queued'].includes(message.status) ? ()=>void window.moreThanChat.retryChatMessage(message.id).catch(e=>setToast(e.message)) : undefined}
                  onQuote={message.serverId&&message.actionsSupported&&message.status==='sent'&&!active.unavailable?()=>{chatDraft.setQuoteMessageId(message.id);requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())}:undefined}
                  onForward={message.serverId&&message.actionsSupported&&message.status==='sent'?()=>setForwardDialog({message,clientMessageId:uid()}):undefined}
                  onRetract={message.serverId&&message.actionsSupported&&message.role==='self'&&message.status==='sent'&&Date.now()-message.createdAt<=120000?()=>setRetractConfirm(message):undefined}
                  onLocateQuote={message.quote&&!message.quote.retracted?()=>void loadHistory(active.id,{around:message.quote!.messageId}):undefined}
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
          {historic?.hasNewer&&<button className="history-more" data-history-newer disabled={historyBusy} onClick={()=>void loadHistory(active.id,{after:historic.after!})}>查看较新的消息</button>}
          <div ref={reading.endRef} />
        </section>
        {!reading.atBottom&&<button className="jump-latest" onClick={returnToLatest}>回到最新消息{active.unread>0?' · '+active.unread:''}</button>}

        <footer
          className="composer-wrap"
          data-generating={
            messages.some((message) => message.status === 'streaming')
              ? 'true'
              : 'false'
          }
        >
          {renderSlot('chat.composer.before')}
          {chatDraft.error&&<p className="settings-error">草稿未能保存到设备，请检查可用空间。</p>}
          {active.serverId&&(active.unavailable || active.serverId!==serverState?.serverId || serverState.status!=='connected')&&<p className="connection-note">{active.unavailable?'当前联系人或群已不可用。聊天记录仍保留。':'当前未连接此会话的服务器，发送的消息会保存在本机队列，连接恢复后自动发送。'}</p>}
          <div
            style={{
              display: slotEntries.some(
                (entry) => entry.contribution.slot === 'chat.composer',
              )
                ? 'none'
                : undefined,
            }}
          >
            {active.serverId&&active.unavailable ? <div className="composer" data-history-readonly><p className="settings-note">好友或群关系已结束。这是保留在本机的只读历史，不能发送新消息。</p></div> : <ChatComposer
              reference={quotedMessage&&<div className="composer-quote" data-composer-quote={quotedMessage.id}><Reply size={16}/><div><strong>回复 {quotedMessage.senderName}</strong><p>{quotedMessage.text.slice(0,180)||quotedMessage.attachment?.name||'消息'}</p></div><button className="icon-button" title="取消引用" data-clear-quote onClick={()=>chatDraft.setQuoteMessageId(null)}><X size={16}/></button></div>}
              key={active.id}
              draft={draft}
              setDraft={setDraft}
              onSend={() => sendMessage()}
              onVoice={async (ref) => { setPendingAttachment(ref); await sendMessage(ref) }}
              onError={setToast}
              canAttach={
                active.transportId === 'builtin.central' && !active.unavailable
              }
              generating={messages.some(
                (message) => message.status === 'streaming',
              )}
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
                      onClick={() =>
                        void runHostTool(plugin.id, action.id, action.label)
                      }
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
                      onClick={() =>
                        void runHostTool(plugin.id, tool.id, tool.label)
                      }
                    >
                      <Server size={16} />
                      <span>{tool.label}</span>
                    </button>
                  )),
                )}
            </ChatComposer>}
          </div>
          <UiSlot
            name="chat.composer"
            entries={slotEntries}
            context={slotContext}
            fallback={
              <div>
                <p className="settings-error">
                  自定义输入区加载失败，可停用插件恢复默认输入区。
                </p>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button onClick={() => void sendMessage()}>发送</button>
              </div>
            }
          />
          {renderSlot('chat.composer.after')}
        </footer>
      </main>

      {showDetails && (
        <div className="details-with-plugins" id="conversation-details">
          <DetailsPanel
            conversation={active}
            transportName={
              active.kind === 'assistant'
                ? 'PC Host 模型'
                : (transportRegistry.get(active.transportId)?.displayName ??
                  '插件不可用')
            }
            {...(active.kind === 'assistant'
              ? { modelLabel: modelSubtitle(modelSettings) }
              : {})}
            onClose={() => setShowDetails(false)}
            onPlugins={() => setShowPlugins(true)}
            onSettings={() => active.kind === 'assistant' ? setShowSettings(true) : setShowServer(true)}
            onPin={()=>void changeConversationOptions({pinned:!active.pinned})}
            onMute={()=>void changeConversationOptions({muted:!active.muted})}
          />
          {active.kind==='group'&&active.serverId===serverState?.serverId&&serverState?.directory&&serverState.directory.groups.filter(group=>group.id===active.targetId).map(group=><GroupManager key={group.id} group={group} directory={serverState.directory!} userId={serverState.userId}/>)}
          {renderSlot('chat.details')}
          {active.kind === 'group' &&
            active.serverId &&
            serverState?.serverId === active.serverId && (
              <div className="group-plugin-controls">
                <h3>本群插件</h3>
                <p>提交申请后由群管理员批准并分发。</p>
                <button onClick={()=>setShowPlugins(true)}>提交 AI 创作的群插件</button>
                <p>在 More AI 中描述插件需求，创建并校验草稿后，在插件面板选择本群提交。下面是内置演示模板，并非 AI 创作。</p>
                <label>
                  插件显示位置{' '}
                  <select
                    data-group-plugin-slot
                    value={groupPluginSlot}
                    onChange={(event) =>
                      setGroupPluginSlot(event.target.value as UiSlotName)
                    }
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
                      void window.moreThanChat
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
                <button onClick={() => setShowServer(true)}>
                  打开群管理与审批
                </button>
              </div>
            )}
        </div>
      )}
      {showPlugins && (
        <PluginPanel
          serverSnapshot={serverState}
          plugins={plugins}
          hostPlugins={hostPlugins}
          hostBusy={hostPluginBusy}
          drafts={pluginDrafts}
          draftReport={pluginDraftReport}
          onCreateDraft={(manifestJson, source) =>
            void createPluginDraft(manifestJson, source)
          }
          onDiagnoseDraft={(draftId) => void diagnosePluginDraft(draftId)}
          onInstallDraft={(draftId) => void installPluginDraft(draftId)}
          onHostToggle={(plugin) => void toggleHostPlugin(plugin)}
          onToggle={(plugin) => void togglePlugin(plugin)}
          onClose={() => setShowPlugins(false)}
        />
      )}
      {showNewChat && (
        <NewChatDialog
          onClose={() => setShowNewChat(false)}
          onCreate={createConversation}
        />
      )}
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
      {forwardDialog&&<div className="modal-backdrop" onMouseDown={()=>{if(!messageActionBusy)setForwardDialog(null)}}><section className="new-chat-modal message-action-modal" data-forward-dialog role="dialog" aria-modal="true" aria-label="转发消息" onMouseDown={e=>e.stopPropagation()}><div className="drawer-header"><h2>转发消息</h2><button className="icon-button" disabled={messageActionBusy} onClick={()=>setForwardDialog(null)} aria-label="关闭转发"><X size={18}/></button></div><p className="settings-note">作为独立新消息发送，只能选择同一中心服务器的好友或群。</p><p className="forward-preview">{forwardDialog.message.text.slice(0,160)||forwardDialog.message.attachment?.name}</p><div className="forward-targets">{state.conversations.filter(c=>c.serverId===forwardDialog.message.serverId&&!c.unavailable&&c.kind!=='assistant').map(c=><button className="secondary-button" key={c.id} data-forward-target={c.id} disabled={messageActionBusy} onClick={()=>void forwardTo(c.id)}><span>{c.title}</span><small>{c.kind==='group'?'群聊':'好友'}</small></button>)}</div></section></div>}
      {retractConfirm&&<div className="modal-backdrop" onMouseDown={()=>{if(!messageActionBusy)setRetractConfirm(null)}}><section className="new-chat-modal message-action-modal" data-retract-dialog role="dialog" aria-modal="true" aria-label="确认撤回" onMouseDown={e=>e.stopPropagation()}><h2>撤回这条消息？</h2><p className="settings-note">仅本人两分钟内的消息可以撤回。离线成员上线后会收到撤回通知；已经转发、下载或复制的内容无法保证删除。</p><div className="modal-actions"><button className="secondary-button" disabled={messageActionBusy} onClick={()=>setRetractConfirm(null)}>取消</button><button className="primary-button" data-confirm-retract disabled={messageActionBusy} onClick={()=>void confirmRetraction()}>{messageActionBusy?'正在撤回…':'确认撤回'}</button></div></section></div>}
      {showMessageSearch&&<MessageSearch conversationId={active.id} title={active.title} onClose={()=>setShowMessageSearch(false)} onSelect={row=>{selectConversation(row.conversationId);setShowMessageSearch(false);void loadHistory(row.conversationId,{around:row.messageId})}}/>}
      {showServer && (
        <NetworkPanel
          snapshot={serverState}
          onClose={() => setShowServer(false)}
          onOpenChat={(targetId) => {
            const conversation = stateRef.current?.conversations.find(
              (item) =>
                item.serverId === serverState?.serverId &&
                item.targetId === targetId,
            )
            if (conversation) selectConversation(conversation.id)
          }}
        />
      )}
      {renderSlot('app.overlay')}
      {toast && (
        <div className="toast" role="status" aria-live="polite" aria-atomic="true">
          <Info size={17} aria-hidden="true" />
          <span>{toast}</span>
          <button className="icon-button" aria-label="关闭通知" onClick={() => setToast(null)}><X size={15} /></button>
        </div>
      )}
    </div>
  )
}

function appendMessage(state: ChatState, message: ChatMessage): ChatState {
  return {
    ...state,
    conversations: state.conversations.map((item) =>
      item.id === message.conversationId
        ? { ...item, updatedAt: message.createdAt }
        : item,
    ),
    messages: {
      ...state.messages,
      [message.conversationId]: [
        ...(state.messages[message.conversationId] ?? []),
        message,
      ],
    },
  }
}

function updateMessageStatus(
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

function RailButton({
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
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function Avatar({
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
    >
      {conversation.avatar}
    </span>
  )
}

const MessageBubble = memo(function MessageBubble({
  message,
  compact,
  onRetry,
  onCopy,
  onResend,
  highlighted,
  onQuote,
  onForward,
  onRetract,
  onLocateQuote,
}: {
  message: ChatMessage
  compact: boolean
  onRetry: (() => void) | undefined
  onCopy: () => void
  onResend?: (() => void) | undefined
  highlighted?: boolean
  onQuote?:(()=>void)|undefined
  onForward?:(()=>void)|undefined
  onRetract?:(()=>void)|undefined
  onLocateQuote?:(()=>void)|undefined
}) {
  if(message.retractedAt)return <article className="message-retracted" data-message-id={message.id} data-retracted-message><Undo2 size={13}/><span>{message.role==='self'?'你':message.senderName}撤回了一条消息</span></article>
  if (message.type === 'system')
    return <div className="system-message">{message.text}</div>
  const own = message.role === 'self'
  return (
    <article
      data-message-id={message.id}
      className={`message-row ${own ? 'own' : ''} ${compact ? 'compact' : ''} status-${message.status} ${highlighted?'message-highlight':''}`}
    >
      {!own && <span className="message-avatar">{message.senderAvatar}</span>}
      <div className="message-content">
        {!compact && !own && (
          <span className="sender-name">{message.senderName}</span>
        )}
        <div className="bubble">
          {message.forwarded&&<span className="message-forwarded"><Forward size={12}/>转发自 {message.forwarded.senderName}</span>}
          {message.quote&&<button className="message-quote" data-quote-source={message.quote.messageId} disabled={!onLocateQuote} onClick={onLocateQuote}><strong>{message.quote.senderName}</strong><span>{message.quote.text||message.quote.attachmentName||'消息'}{message.quote.attachmentName?' · '+message.quote.attachmentName:''}</span></button>}
          {own ? (
            <p>{displayText(message)}</p>
          ) : (
            <MessageMarkdown text={displayText(message)} />
          )}
          {message.attachment && (
            <MessageAttachment attachment={message.attachment} />
          )}
          {message.errorMessage && (
            <p className="message-error">{message.errorMessage}</p>
          )}
          {message.authorNotes && message.authorNotes.length > 0 && (
            <ul className="author-tool-notes">
              {message.authorNotes.map((note, index) => (
                <li
                  key={`${note.phase}-${note.tool}-${index}`}
                  className={authorToolClass(note)}
                >
                  {authorToolLabel(note)}
                </li>
              ))}
            </ul>
          )}
          <span className="bubble-meta">{messageMeta(message)}</span>
          <div className="message-actions"><button className="message-copy" title="复制消息" onClick={onCopy}><Copy size={13}/></button>{onQuote&&<button title="引用回复" data-quote-message={message.id} onClick={onQuote}><Reply size={13}/></button>}{onForward&&<button title="转发消息" data-forward-message={message.id} onClick={onForward}><Forward size={13}/></button>}{onRetract&&<button title="撤回消息" data-retract-message={message.id} onClick={onRetract}><Undo2 size={13}/></button>}{onResend&&<button className="message-resend" onClick={onResend}>{message.status==='queued'?'立即重试':'重新发送'}</button>}</div>
          {message.usage && (
            <span
              className="message-usage"
              data-token-total={message.usage.totalTokens}
              title={`输入 ${message.usage.inputTokens} · 输出 ${message.usage.outputTokens} · ${message.usage.reportedRequests}/${message.usage.requestCount} 次请求返回用量`}
            >
              {message.usage.totalTokens.toLocaleString()} tokens
              {message.usage.reportedRequests < message.usage.requestCount
                ? '（部分）'
                : ''}
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

function DetailsPanel({
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
        <div className="conversation-options"><button className="secondary-button" data-mute-conversation aria-pressed={Boolean(conversation.muted)} onClick={onMute}>{conversation.muted?'关闭免打扰':'免打扰'}</button></div>
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

function PluginPanel({
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
  onHostToggle: (plugin: HostPluginSnapshot) => void
  onToggle: (plugin: PluginSnapshot) => void
  onClose: () => void
}) {
  const [manifestJson, setManifestJson] = useState('')
  const [source, setSource] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="plugin-drawer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <div>
            <p className="eyebrow">运行时</p>
            <h2>插件</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="plugin-list">
          {plugins.map((plugin) => {
            const busy =
              plugin.status === 'activating' || plugin.status === 'deactivating'
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
                  {plugin.error && (
                    <span className="plugin-error">{plugin.error}</span>
                  )}
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
          {hostPlugins.map((plugin) => (
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
                  {plugin.id} · {plugin.version} · 独立后台进程
                </small>
                {plugin.error && (
                  <span className="plugin-error">{plugin.error}</span>
                )}
              </div>
              <button
                className={`plugin-toggle ${plugin.status === 'active' ? 'active' : ''}`}
                disabled={
                  hostBusy ||
                  plugin.status === 'activating' ||
                  plugin.status === 'deactivating'
                }
                onClick={() => onHostToggle(plugin)}
              >
                {hostBusy
                  ? '处理中'
                  : plugin.status === 'active'
                    ? '停用'
                    : '启用'}
              </button>
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
            为你创建文本动作或实时群插件。文本动作可本机安装；群插件先选择群聊提交审批，成员收到后自主载入，不授予文件或系统权限。
          </p>
          {(drafts?.drafts ?? []).map((item) => {
            const installed = hostPlugins.some(
              (plugin) => plugin.id === item.id,
            )
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
                  {installed ? '已安装' : '未安装'} ·{' '}
                  {item.ok ? '校验通过' : '校验未通过'}
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
                  {item.distribution==='group' ? <GroupDraftSubmission key={`${serverSnapshot?.serverId}:${item.id}:${item.revision}`} draft={item} snapshot={serverSnapshot}/> : confirmId === item.id ? (
                    <div className="draft-confirm" data-draft-confirm={item.id}>
                      <p>
                        {installed
                          ? '确认用这份草稿更新？失败会保留当前版本。源码不会被执行。'
                          : '确认安装这个声明式文本工具或输入框动作？源码不会被执行。'}
                      </p>
                      <div className="draft-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          data-draft-confirm-cancel
                          disabled={hostBusy}
                          onClick={() => setConfirmId(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          data-draft-confirm-ok
                          disabled={hostBusy}
                          onClick={() => {
                            setConfirmId(null)
                            onInstallDraft(item.id)
                          }}
                        >
                          {installed ? '确认更新' : '确认安装'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      {...(installed
                        ? { 'data-draft-update': 'true' }
                        : { 'data-draft-install': 'true' })}
                      disabled={hostBusy}
                      onClick={() => setConfirmId(item.id)}
                    >
                      {installed ? '更新' : '安装'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {drafts && drafts.drafts.length === 0 && (
            <p className="settings-note">还没有草稿。</p>
          )}
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
          <h3>可信插件模式</h3>
          <p>
            示例插件经过版本化 manifest
            和生命周期运行时接入。任意磁盘代码将在独立进程与权限代理完成后开放。
          </p>
        </div>
      </aside>
    </div>
  )
}

function NewChatDialog({
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

function ModelSettingsPanel({
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
  const [baseUrl, setBaseUrl] = useState(
    snapshot?.baseUrl ?? 'https://api.deepseek.com',
  )
  const [model, setModel] = useState(snapshot?.model ?? 'deepseek-flash')
  const [providerMode, setProviderMode] = useState<ModelProviderMode>(
    snapshot?.providerMode ?? 'mock',
  )
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
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function clearKey() {
    setBusy(true)
    setError(null)
    try {
      await onClearKey()
      setApiKey('')
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <form
        className="plugin-drawer settings-drawer"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
        data-provider-mode={providerMode}
        data-has-api-key={snapshot?.hasApiKey ? 'true' : 'false'}
      >
        <div className="drawer-header">
          <h2>设置</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <AppearancePicker />
        <DesktopSettings />
        <HistorySettings />
        <button
          type="button"
          className="secondary-button"
          onClick={onServerSettings}
        >
          中心服务器 / 身份 / 联系人
        </button>
        <div className="settings-section-heading"><h3>AI 模型</h3></div>
        <p className="settings-note">
          API Key
          由主进程使用系统加密保存，仅供模型服务调用。界面只显示是否已保存，不回传密钥。
        </p>
        <label className="settings-field">
          <span>提供方</span>
          <select
            data-model-field="provider"
            value={providerMode}
            onChange={(event) =>
              setProviderMode(event.target.value as ModelProviderMode)
            }
          >
            <option value="mock">模拟（不访问网络）</option>
            <option value="openai-compatible">OpenAI 兼容 / DeepSeek</option>
          </select>
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input
            data-model-field="base-url"
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
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              snapshot?.hasApiKey ? '已保存，留空则不修改' : '未设置'
            }
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {error && <p className="settings-error">{error}</p>}
        <div className="dialog-actions">
          {snapshot?.hasApiKey && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void clearKey()}
            >
              删除密钥
            </button>
          )}
          <button
            className="primary-button"
            disabled={busy || !snapshot || !baseUrl.trim() || !model.trim()}
          >
            {busy ? '保存中' : '保存'}
          </button>
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
  if (message.status === 'failed') return message.role==='self'?'消息发送失败。':'回复没有完成。'
  return ''
}

function messageMeta(message: ChatMessage): string {
  const time = formatRelativeTime(message.createdAt)
  if (message.status === 'streaming') return `${time} · 生成中`
  if (message.status === 'cancelled') return `${time} · 已取消`
  if (message.status === 'failed')
    return `${time} · 失败${message.supersededById ? ' · 已重试' : ''}`
  if (message.role === 'self' && message.status === 'sending')
    return `${time} · 发送中`
  if (message.status === 'queued') return `${time} · 待发送`
  if (message.role==='self' && message.receipt?.recipientCount) {
    const receipt=message.receipt
    if(receipt.recipientCount===1)return `${time} · ${receipt.readCount?'已读':receipt.deliveredCount?'已送达':'已提交中心'}`
    return `${time} · ${receipt.deliveredCount}/${receipt.recipientCount} 已送达 · ${receipt.readCount} 已读`
  }
  if (message.role === 'self')
    return message.serverId ? `${time} · 已提交中心` : `${time} ✓`
  return message.retryOfId ? `${time} · 重试回复` : time
}

function errorText(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : '模型请求失败'
  return message.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240)
}

function authorToolClass(note: AuthorToolNote): string {
  if (note.pendingInstall) return 'author-tool-note pending'
  if (!note.ok) return 'author-tool-note failed'
  if (note.phase === 'started') return 'author-tool-note progress'
  return 'author-tool-note'
}

function toModelUpdate(event: ModelClientEvent): ModelChatUpdate {
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

function applyIncomingModelEvent(
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

function drainModelEvents(
  state: ChatState,
  pending: ModelClientEvent[],
): ChatState {
  if (pending.length === 0) return state
  const queued = pending.splice(0, pending.length)
  return queued.reduce(
    (current, event) => applyModelChatUpdate(current, toModelUpdate(event)),
    state,
  )
}

function LoadingScreen({ error = false }: { error?: boolean }) {
  return (
    <div className="loading-screen">
      <div className="loading-mark">M</div>
      <p>
        {error
          ? '会话恢复失败，原数据已保留。请重新打开应用。'
          : '正在恢复会话…'}
      </p>
    </div>
  )
}

function hostStatusLabel(status: HostStatusSnapshot): string {
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
