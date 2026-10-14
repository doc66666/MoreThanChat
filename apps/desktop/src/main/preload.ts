import { contextBridge, ipcRenderer } from 'electron'
import type { HostPluginCatalog, HostStatusSnapshot, ModelProviderMode, ModelSettingsSnapshot, ModelTokenUsage, ProtocolErrorCode } from '@more-than-chat/protocol'

interface HostPingResult {
  generation: number
  roundTripMs: number
  sentAtMs: number
  hostReceivedAtMs: number
}

const api = {
  getClientPlugins: () => ipcRenderer.invoke('client-plugins:list'),
  importClientPlugin: () => ipcRenderer.invoke('client-plugins:import'),
  installClientDraft: (draftId: string, revision: number) => ipcRenderer.invoke('client-plugins:install-draft', {draftId, revision}),
  authorizeClientPlugin: (id: string, digest: string) => ipcRenderer.invoke('client-plugins:authorize', id, digest),
  recoverClientInterface: () => ipcRenderer.invoke('client-plugins:recover'),
  demoPluginsEnabled: process.argv.includes('--mtc-demo-plugins'),
  getHistoryTransferStatus:async()=>parseHistoryTransferStatus(await ipcRenderer.invoke('history:status')),
  onHistoryTransferStatus:(listener:(value:{busy:boolean;stage:string})=>void)=>{
    const handler=(_event:Electron.IpcRendererEvent,value:unknown)=>listener(parseHistoryTransferStatus(value))
    ipcRenderer.on('history:status-changed',handler)
    return()=>ipcRenderer.removeListener('history:status-changed',handler)
  },
  exportChatHistory:async(password:string)=>parseHistoryCounts(await ipcRenderer.invoke('history:export',password),['conversations','messages','attachments'] as const),
  importChatHistory:async(password:string)=>parseHistoryCounts(await ipcRenderer.invoke('history:import',password),['conversationsAdded','messagesAdded','messagesSkipped','retractionsApplied','attachments'] as const),
  getDesktopSettings:async()=>parseDesktopSettings(await ipcRenderer.invoke('app:desktop-settings')),
  configureDesktop:async(value:{notifications?:boolean;preview?:boolean;sound?:boolean;closeToTray?:boolean})=>parseDesktopSettings(await ipcRenderer.invoke('app:desktop-configure',value)),
  testNotification:():Promise<void>=>ipcRenderer.invoke('app:notification-test'),
  hideToTray:():Promise<void>=>ipcRenderer.invoke('app:hide-to-tray'),
  quitApp:():Promise<void>=>ipcRenderer.invoke('app:quit'),
  getPendingNavigation:()=>ipcRenderer.invoke('app:pending-navigation'),
  navigationApplied:(id:string):Promise<void>=>ipcRenderer.invoke('app:navigation-applied',id),
  onOpenConversation:(listener:(value:{id:string;conversationId:string})=>void)=>{const handler=(_e:Electron.IpcRendererEvent,value:{id:string;conversationId:string})=>listener(value);ipcRenderer.on('app:open-conversation',handler);return()=>ipcRenderer.removeListener('app:open-conversation',handler)},
  onDesktopSettings:(listener:(value:unknown)=>void)=>{const handler=(_e:Electron.IpcRendererEvent,value:unknown)=>listener(parseDesktopSettings(value));ipcRenderer.on('app:desktop-changed',handler);return()=>ipcRenderer.removeListener('app:desktop-changed',handler)},
  getIdentityProfiles:()=>ipcRenderer.invoke('identity:profiles'),
  backupIdentity:(password:string):Promise<boolean>=>ipcRenderer.invoke('identity:backup',password),
  restoreIdentity:(password:string):Promise<{id:string}|null>=>ipcRenderer.invoke('identity:restore',password),
  switchIdentity:async(id:string)=>parseChoice(await ipcRenderer.invoke('identity:switch',id),['restarting','cancelled','unchanged'] as const),
  getDevices:()=>ipcRenderer.invoke('central:devices'),
  removeDevice:async(id:string)=>parseChoice(await ipcRenderer.invoke('central:remove-device',id),['removed','cancelled'] as const),
  getWindowFocus:():Promise<boolean>=>ipcRenderer.invoke('app:window-focused'),
  focusChatWindow:():Promise<void>=>ipcRenderer.invoke('app:focus-window'),
  onWindowFocusChanged:(listener:(focused:boolean)=>void)=>{const handler=(_e:Electron.IpcRendererEvent,focused:boolean)=>listener(focused);ipcRenderer.on('app:window-focus-changed',handler);return()=>ipcRenderer.removeListener('app:window-focus-changed',handler)},
  setReadingConversation:(id:string|null):Promise<void>=>ipcRenderer.invoke('chat:set-reading',id),
  retryChatMessage:(id:string):Promise<void>=>ipcRenderer.invoke('chat:retry-message',id),
  searchChatMessages:(query:string,conversationId?:string)=>ipcRenderer.invoke('chat:search',{query,conversationId}),
  copyChatMessage:(id:string):Promise<void>=>ipcRenderer.invoke('chat:copy-message',id),
  getChatMessage:(id:string)=>ipcRenderer.invoke('chat:message',id),
  retractChatMessage:(id:string):Promise<void>=>ipcRenderer.invoke('central:retract',id),
  forwardChatMessage:(input:{messageId:string;conversationId:string;clientMessageId:string}):Promise<void>=>ipcRenderer.invoke('central:forward',input),
  setConversationOptions:(id:string,patch:{pinned?:boolean;muted?:boolean})=>ipcRenderer.invoke('chat:conversation-options',{id,patch}),
  getChatHistory:(conversationId:string,input:{before?:number;after?:number;around?:string;limit?:number}={})=>ipcRenderer.invoke('chat:history',{...input,conversationId}),
  setAppearance:(theme:'light'|'dark'):Promise<void>=>ipcRenderer.invoke('app:appearance',theme),
  getServerState:()=>ipcRenderer.invoke('central:state'),
  copyGlobalUserId:()=>ipcRenderer.invoke('central:copy-id'),
  getPluginInbox:(groupId:string,pluginId:string)=>ipcRenderer.invoke('central:plugin-inbox',{groupId,pluginId}),
  connectServer:(address:string,displayName:string)=>ipcRenderer.invoke('central:connect',{address,displayName}),
  disconnectServer:()=>ipcRenderer.invoke('central:disconnect'),
  serverAction:(route:string,data:unknown)=>ipcRenderer.invoke('central:action',{route,data}),
  groupPluginConsent:(input:unknown)=>ipcRenderer.invoke('central:plugin-consent',input),
  onGroupPluginConsentChanged:(listener:()=>void)=>{const handler=()=>listener();ipcRenderer.on('central:plugin-consent-changed',handler);return()=>ipcRenderer.removeListener('central:plugin-consent-changed',handler)},
  submitGroupDraft:(input:unknown)=>ipcRenderer.invoke('central:submit-draft',input),
  sendCentralMessage:(input:unknown)=>ipcRenderer.invoke('central:send',input),
  chooseAttachment:()=>ipcRenderer.invoke('attachment:choose'),
  recordVoice:(input:unknown)=>ipcRenderer.invoke('attachment:voice',input),
  readAttachment:(id:string)=>ipcRenderer.invoke('attachment:read',id),
  saveAttachment:async(id:string):Promise<'saved'|'cancelled'>=>{
    const result:unknown=await ipcRenderer.invoke('attachment:save',id)
    if(result!=='saved'&&result!=='cancelled')throw new Error('无效附件保存结果')
    return result
  },
  onServerState:(listener:(value:unknown)=>void)=>{const handler=(_e:Electron.IpcRendererEvent,value:unknown)=>listener(value);ipcRenderer.on('central:changed',handler);return()=>ipcRenderer.removeListener('central:changed',handler)},
  onCentralChat:(listener:(value:unknown)=>void)=>{const handler=(_e:Electron.IpcRendererEvent,value:unknown)=>listener(value);ipcRenderer.on('central:chat',handler);return()=>ipcRenderer.removeListener('central:chat',handler)},
  onPluginEvent:(listener:(value:unknown)=>void)=>{const handler=(_e:Electron.IpcRendererEvent,value:unknown)=>listener(value);ipcRenderer.on('central:plugin',handler);return()=>ipcRenderer.removeListener('central:plugin',handler)},
  loadState: (): Promise<unknown | null> => ipcRenderer.invoke('chat:state:load') as Promise<unknown | null>,
  saveState: (value: unknown): Promise<void> => ipcRenderer.invoke('chat:state:save', value) as Promise<void>,
  onBeforeClose: (listener: () => Promise<void>): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, token: unknown) => {
      if (typeof token !== 'string') return
      void listener().then(() => ipcRenderer.send('chat:state:flushed', { token, ok: true })).catch(() => ipcRenderer.send('chat:state:flushed', { token, ok: false }))
    }
    ipcRenderer.on('chat:state:flush', handler)
    return () => ipcRenderer.removeListener('chat:state:flush', handler)
  },
  getAppInfo: (): Promise<{ version: string; platform: string }> => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string }>,
  getHostStatus: async (): Promise<HostStatusSnapshot> => parseHostStatus(await ipcRenderer.invoke('host:status:get')),
  pingHost: async (): Promise<HostPingResult> => parseHostPing(await ipcRenderer.invoke('host:ping')),
  getHostPlugins: async (): Promise<HostPluginCatalog> => parsePluginCatalog(await ipcRenderer.invoke('host:plugins:list')),
  setHostPluginEnabled: async (pluginId: string, enabled: boolean): Promise<HostPluginCatalog> =>
    parsePluginCatalog(await ipcRenderer.invoke('host:plugins:set-enabled', { pluginId, enabled })),
  invokeHostTool: async (pluginId: string, toolId: string, input?: string): Promise<{ generation: number; text: string; replaceDraft?: boolean }> => {
    const value = await ipcRenderer.invoke('host:tools:invoke', { pluginId, toolId, ...(input === undefined ? {} : { input }) }) as { generation?: unknown; text?: unknown; replaceDraft?: unknown } | null
    if (!value || !Number.isSafeInteger(value.generation) || typeof value.text !== 'string' || value.text.length > 16384
      || (value.replaceDraft !== undefined && typeof value.replaceDraft !== 'boolean') || (value.replaceDraft !== true && !value.text.trim())) throw new Error('Invalid host tool response.')
    return { generation: value.generation as number, text: value.text, ...(value.replaceDraft === true ? { replaceDraft: true } : {}) }
  },
  getModelSettings: async (): Promise<ModelSettingsSnapshot> => parseModelSettings(await ipcRenderer.invoke('host:model:get-settings')),
  setModelSettings: async (input: {
    baseUrl?: string
    model?: string
    providerMode?: ModelProviderMode
    apiKey?: string
    clearApiKey?: boolean
  }): Promise<ModelSettingsSnapshot> => parseModelSettings(await ipcRenderer.invoke('host:model:set-settings', input)),
  startModelChat: async (input: {
    streamId: string
    conversationId: string
    assistantMessageId: string
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  }) => parseModelStreamRef(await ipcRenderer.invoke('host:model:chat-start', input)),
  cancelModelChat: async (streamId: string): Promise<{ streamId: string; cancelled: true }> => {
    const value = await ipcRenderer.invoke('host:model:chat-cancel', { streamId })
    return parseModelCancel(value)
  },
  inspectPluginDrafts: async () => parsePluginDraftInspection(await ipcRenderer.invoke('host:plugin-drafts:inspect')),
  createPluginDraft: async (input: { manifestJson: string; source: string }) =>
    parsePluginDraftCreateResult(await ipcRenderer.invoke('host:plugin-drafts:create', input)),
  validatePluginDraft: async (draftId: string) =>
    parsePluginDraftReport(await ipcRenderer.invoke('host:plugin-drafts:validate', { draftId })),
  diagnosePluginDraft: async (draftId: string) =>
    parsePluginDraftReport(await ipcRenderer.invoke('host:plugin-drafts:diagnose', { draftId })),
  installPluginDraft: async (input: { draftId: string; confirmed: boolean }) =>
    parsePluginDraftInstallResult(await ipcRenderer.invoke('host:plugin-drafts:install', input)),
  onHostStatusChanged: (listener: (status: HostStatusSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(parseHostStatus(value))
    ipcRenderer.on('host:status:changed', handler)
    return () => ipcRenderer.removeListener('host:status:changed', handler)
  },
  onModelChatEvent: (listener: (event: ModelClientEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      try {
        listener(parseModelClientEvent(value))
      }
      catch {
        // Never log the raw payload. It is untrusted and must not be allowed to carry a credential into logs.
      }
    }
    ipcRenderer.on('host:model:event', handler)
    return () => ipcRenderer.removeListener('host:model:event', handler)
  },
}

interface ModelClientIdentity {
  streamId: string
  conversationId: string
  assistantMessageId: string
  generation: number
}

interface ModelClientEventBase extends ModelClientIdentity {
  type: 'delta' | 'completed' | 'failed' | 'cancelled' | 'author-tool'
  textDelta?: string
  text?: string
  usage?: ModelTokenUsage
  partialText?: string
  errorMessage?: string
  phase?: 'started' | 'finished'
  tool?: 'inspect_drafts' | 'create_draft' | 'validate_draft' | 'diagnose_draft' | 'install_draft' | 'unknown'
  ok?: boolean
  summary?: string
  pendingInstall?: boolean
  draft?: { id: string; displayName: string; revision: number; ok: boolean } | null
}

type ModelClientEvent = ModelClientEventBase

const hostStates = new Set(['starting', 'ready', 'restarting', 'failed', 'stopped'])
const pluginStates = new Set(['inactive', 'activating', 'active', 'deactivating', 'failed'])

// Sandboxed preload cannot require workspace modules; main and Host use the
// shared protocol parser, and this narrow bridge independently checks its DTOs.
function parsePluginCatalog(value: unknown): HostPluginCatalog {
  if (!value || typeof value !== 'object') throw new Error('Invalid host plugin catalog.')
  const catalog = value as HostPluginCatalog
  if (!Number.isSafeInteger(catalog.generation) || catalog.generation < 0 || !Array.isArray(catalog.plugins)) throw new Error('Invalid host plugin catalog.')
  return {
    generation: catalog.generation,
    plugins: catalog.plugins.map(plugin => {
      if (!plugin || typeof plugin !== 'object' || !pluginStates.has(plugin.status)
        || (plugin.error !== null && typeof plugin.error !== 'string')
        || !Array.isArray(plugin.tools) || !Array.isArray(plugin.composerActions)) throw new Error('Invalid host plugin.')
      for (const key of ['id', 'displayName', 'description', 'version'] as const) {
        if (typeof plugin[key] !== 'string' || !plugin[key].trim()) throw new Error('Invalid host plugin.')
      }
      return {
        id: plugin.id,
        displayName: plugin.displayName,
        description: plugin.description,
        version: plugin.version,
        status: plugin.status,
        error: plugin.error,
        tools: plugin.tools.map(tool => parseContribution(tool, 'Invalid host tool.')),
        composerActions: plugin.composerActions.map(action => parseContribution(action, 'Invalid composer action.')),
      }
    }),
  }
}

function parseContribution(value: unknown, message: string): { id: string; label: string } {
  if (!value || typeof value !== 'object') throw new Error(message)
  const contribution = value as { id?: unknown; label?: unknown }
  if (typeof contribution.id !== 'string' || !contribution.id.trim() || typeof contribution.label !== 'string' || !contribution.label.trim()) {
    throw new Error(message)
  }
  return { id: contribution.id, label: contribution.label }
}

function parseHostStatus(value: unknown): HostStatusSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid PC Host status.')
  const candidate = value as { state?: unknown; generation?: unknown; error?: unknown }
  if (typeof candidate.state !== 'string' || !hostStates.has(candidate.state)
    || !Number.isSafeInteger(candidate.generation) || Number(candidate.generation) < 0) {
    throw new Error('Invalid PC Host status.')
  }
  const base = {
    state: candidate.state as HostStatusSnapshot['state'],
    generation: candidate.generation as number,
  }
  if (candidate.error === undefined) return base
  if (!candidate.error || typeof candidate.error !== 'object') throw new Error('Invalid PC Host error.')
  const error = candidate.error as { code?: unknown; message?: unknown; retryable?: unknown }
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || typeof error.retryable !== 'boolean') {
    throw new Error('Invalid PC Host error.')
  }
  return {
    ...base,
    error: { code: error.code as ProtocolErrorCode, message: error.message, retryable: error.retryable },
  }
}

const modelProviderModes = new Set(['mock', 'openai-compatible'])
const modelEventFields = new Set([
  'type', 'streamId', 'conversationId', 'assistantMessageId', 'generation',
  'textDelta', 'text', 'partialText', 'errorMessage', 'usage',
  'phase', 'tool', 'ok', 'summary', 'pendingInstall', 'draft',
])
const authorToolNames = new Set(['inspect_drafts', 'create_draft', 'validate_draft', 'diagnose_draft', 'install_draft', 'unknown'])
const authorToolPhases = new Set(['started', 'finished'])

function parseModelSettings(value: unknown): ModelSettingsSnapshot {
  const record = asRecord(value, 'Invalid model settings.')
  assertExactKeys(record, ['baseUrl', 'model', 'providerMode', 'hasApiKey'], 'Invalid model settings.')
  if (!isBoundedText(record.baseUrl, 2048) || !isBoundedText(record.model, 256)) throw new Error('Invalid model settings.')
  if (typeof record.providerMode !== 'string' || !modelProviderModes.has(record.providerMode)) throw new Error('Invalid model settings.')
  if (typeof record.hasApiKey !== 'boolean') throw new Error('Invalid model settings.')
  return {
    baseUrl: record.baseUrl,
    model: record.model,
    providerMode: record.providerMode as ModelProviderMode,
    hasApiKey: record.hasApiKey,
  }
}

function parseModelStreamRef(value: unknown): {
  streamId: string
  conversationId: string
  assistantMessageId: string
  generation: number
} {
  const record = asRecord(value, 'Invalid model stream.')
  assertExactKeys(record, ['streamId', 'conversationId', 'assistantMessageId', 'generation'], 'Invalid model stream.')
  return {
    streamId: requiredId(record.streamId, 'Invalid model stream.'),
    conversationId: requiredId(record.conversationId, 'Invalid model stream.'),
    assistantMessageId: requiredId(record.assistantMessageId, 'Invalid model stream.'),
    generation: requiredGeneration(record.generation, 'Invalid model stream.'),
  }
}

function parseModelCancel(value: unknown): { streamId: string; cancelled: true } {
  const record = asRecord(value, 'Invalid model cancellation.')
  assertExactKeys(record, ['streamId', 'cancelled'], 'Invalid model cancellation.')
  if (record.cancelled !== true) throw new Error('Invalid model cancellation.')
  return { streamId: requiredId(record.streamId, 'Invalid model cancellation.'), cancelled: true }
}

function parseModelClientEvent(value: unknown): ModelClientEvent {
  const record = asRecord(value, 'Invalid model event.')
  for (const key of Object.keys(record)) {
    if (!modelEventFields.has(key)) throw new Error('Invalid model event.')
  }
  const identity = {
    streamId: requiredId(record.streamId, 'Invalid model event.'),
    conversationId: requiredId(record.conversationId, 'Invalid model event.'),
    assistantMessageId: requiredId(record.assistantMessageId, 'Invalid model event.'),
    generation: requiredGeneration(record.generation, 'Invalid model event.'),
  }
  if (record.type === 'delta') {
    if (typeof record.textDelta !== 'string') throw new Error('Invalid model event.')
    return { type: 'delta', ...identity, textDelta: record.textDelta }
  }
  if (record.type === 'completed') {
    if (typeof record.text !== 'string') throw new Error('Invalid model event.')
    return { type: 'completed', ...identity, text: record.text, ...(record.usage === undefined ? {} : { usage: parseClientUsage(record.usage) }) }
  }
  if (record.type === 'failed') {
    if (typeof record.partialText !== 'string' || typeof record.errorMessage !== 'string' || !record.errorMessage.trim()) {
      throw new Error('Invalid model event.')
    }
    return { type: 'failed', ...identity, partialText: record.partialText, errorMessage: record.errorMessage }
  }
  if (record.type === 'cancelled') {
    if (typeof record.partialText !== 'string') throw new Error('Invalid model event.')
    return { type: 'cancelled', ...identity, partialText: record.partialText }
  }
  if (record.type === 'author-tool') return parseAuthorToolClientEvent(record, identity)
  throw new Error('Invalid model event.')
}

function parseClientUsage(value: unknown): ModelTokenUsage {
  const record = asRecord(value, 'Invalid token usage.')
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'reportedRequests', 'requestCount']
  assertExactKeys(record, fields, 'Invalid token usage.')
  for (const field of fields) if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0 || Number(record[field]) > 1000000000) throw new Error('Invalid token usage.')
  if (Number(record.totalTokens) !== Number(record.inputTokens) + Number(record.outputTokens) || Number(record.reportedRequests) < 1 || Number(record.reportedRequests) > Number(record.requestCount) || Number(record.requestCount) > 6) throw new Error('Invalid token usage.')
  return record as unknown as ModelTokenUsage
}

function parseAuthorToolClientEvent(
  record: Record<string, unknown>,
  identity: { streamId: string; conversationId: string; assistantMessageId: string; generation: number },
): ModelClientEvent {
  if (typeof record.phase !== 'string' || !authorToolPhases.has(record.phase)) throw new Error('Invalid model event.')
  if (typeof record.tool !== 'string' || !authorToolNames.has(record.tool)) throw new Error('Invalid model event.')
  if (typeof record.ok !== 'boolean' || typeof record.pendingInstall !== 'boolean') throw new Error('Invalid model event.')
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0 || record.summary.length > 240) {
    throw new Error('Invalid model event.')
  }
  const draft = parseAuthorToolDraft(record.draft)
  const summary = redactBridgeText(record.summary).trim().slice(0, 240) || '作者工具没有完成。源码没有执行。'
  return {
    type: 'author-tool',
    ...identity,
    phase: record.phase as 'started' | 'finished',
    tool: record.tool as 'inspect_drafts' | 'create_draft' | 'validate_draft' | 'diagnose_draft' | 'install_draft' | 'unknown',
    ok: record.ok,
    summary,
    pendingInstall: record.pendingInstall && draft !== null,
    draft,
  }
}

function parseAuthorToolDraft(value: unknown): { id: string; displayName: string; revision: number; ok: boolean } | null {
  if (value === null) return null
  const record = asRecord(value, 'Invalid model event.')
  assertExactKeys(record, ['id', 'displayName', 'revision', 'ok'], 'Invalid model event.')
  if (typeof record.ok !== 'boolean' || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
    throw new Error('Invalid model event.')
  }
  if (typeof record.id !== 'string' || record.id.trim().length === 0 || record.id.length > 128) throw new Error('Invalid model event.')
  if (typeof record.displayName !== 'string' || record.displayName.trim().length === 0 || record.displayName.length > 80) {
    throw new Error('Invalid model event.')
  }
  const id = redactBridgeText(record.id).trim().slice(0, 128)
  const displayName = redactBridgeText(record.displayName).trim().slice(0, 80)
  if (!id || !displayName) return null
  return { id, displayName, revision: record.revision as number, ok: record.ok }
}

function redactBridgeText(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function parseHistoryTransferStatus(value:unknown):{busy:boolean;stage:string} {
  const record=asRecord(value,'Invalid history transfer status.')
  assertExactKeys(record,['busy','stage'],'Invalid history transfer status.')
  if(typeof record.busy!=='boolean'||typeof record.stage!=='string'||record.stage.length>200)throw new Error('Invalid history transfer status.')
  return {busy:record.busy,stage:record.stage}
}

function parseHistoryCounts<T extends string>(value:unknown,fields:readonly T[]):(Record<T,number>&{cleanupWarning?:true})|null {
  if(value===null)return null
  const record=asRecord(value,'Invalid history transfer result.')
  assertExactKeys(record,record.cleanupWarning===true?[...fields,'cleanupWarning']:fields,'Invalid history transfer result.')
  for(const field of fields)if(!Number.isSafeInteger(record[field])||Number(record[field])<0)throw new Error('Invalid history transfer result.')
  return record as Record<T,number>
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error(message)
}

function requiredId(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) throw new Error(message)
  return value
}

function requiredGeneration(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(message)
  return value as number
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

const draftIssueCodes = new Set(['MANIFEST_INVALID', 'SECRET_MATERIAL', 'DANGEROUS_API', 'EMPTY_SOURCE', 'INSTALLED_ID', 'NOT_DECLARATIVE', 'NOT_INSTALLABLE', 'CONFIRMATION_REQUIRED'])

function parsePluginDraftInspection(value: unknown) {
  const record = asRecord(value, 'Invalid plugin draft inspection.')
  assertExactKeys(record, ['installed', 'drafts'], 'Invalid plugin draft inspection.')
  if (!Array.isArray(record.installed) || record.installed.length > 100 || !Array.isArray(record.drafts) || record.drafts.length > 100) {
    throw new Error('Invalid plugin draft inspection.')
  }
  return {
    installed: record.installed.map(item => {
      const entry = asRecord(item, 'Invalid installed plugin.')
      assertExactKeys(entry, ['id', 'version', 'displayName', 'status'], 'Invalid installed plugin.')
      if (typeof entry.status !== 'string' || !pluginStates.has(entry.status)) throw new Error('Invalid installed plugin.')
      return {
        id: requiredBounded(entry.id, 128, 'Invalid installed plugin.'),
        version: requiredBounded(entry.version, 32, 'Invalid installed plugin.'),
        displayName: requiredBounded(entry.displayName, 80, 'Invalid installed plugin.'),
        status: entry.status as 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed',
      }
    }),
    drafts: record.drafts.map(item => parseDraftSummary(item)),
  }
}

function parsePluginDraftCreateResult(value: unknown) {
  const record = asRecord(value, 'Invalid plugin draft result.')
  assertExactKeys(record, ['persisted', 'draft', 'ok', 'summary', 'issues'], 'Invalid plugin draft result.')
  if (typeof record.persisted !== 'boolean') throw new Error('Invalid plugin draft result.')
  return {
    persisted: record.persisted,
    draft: record.draft === null ? null : parseDraftSummary(record.draft),
    ...parseDraftDiagnosis(record),
  }
}

function parsePluginDraftReport(value: unknown) {
  const record = asRecord(value, 'Invalid plugin draft report.')
  assertExactKeys(record, ['draft', 'ok', 'summary', 'issues'], 'Invalid plugin draft report.')
  return { draft: parseDraftSummary(record.draft), ...parseDraftDiagnosis(record) }
}

function parsePluginDraftInstallResult(value: unknown) {
  const record = asRecord(value, 'Invalid plugin draft install result.')
  assertExactKeys(record, ['installed', 'draft', 'ok', 'summary', 'issues', 'catalog'], 'Invalid plugin draft install result.')
  if (typeof record.installed !== 'boolean') throw new Error('Invalid plugin draft install result.')
  return {
    installed: record.installed,
    draft: parseDraftSummary(record.draft),
    ...parseDraftDiagnosis(record),
    catalog: parsePluginCatalog(record.catalog),
  }
}

function parseDraftDiagnosis(record: Record<string, unknown>) {
  if (typeof record.ok !== 'boolean' || !Array.isArray(record.issues) || record.issues.length > 20) throw new Error('Invalid plugin draft report.')
  return {
    ok: record.ok,
    summary: requiredBounded(record.summary, 500, 'Invalid plugin draft report.'),
    issues: record.issues.map(item => {
      const issue = asRecord(item, 'Invalid plugin draft issue.')
      assertExactKeys(issue, ['severity', 'code', 'message'], 'Invalid plugin draft issue.')
      if ((issue.severity !== 'error' && issue.severity !== 'warning') || typeof issue.code !== 'string' || !draftIssueCodes.has(issue.code)) {
        throw new Error('Invalid plugin draft issue.')
      }
      return {
        severity: issue.severity,
        code: issue.code as 'MANIFEST_INVALID' | 'SECRET_MATERIAL' | 'DANGEROUS_API' | 'EMPTY_SOURCE' | 'INSTALLED_ID' | 'NOT_DECLARATIVE' | 'NOT_INSTALLABLE' | 'CONFIRMATION_REQUIRED',
        message: requiredBounded(issue.message, 240, 'Invalid plugin draft issue.'),
      }
    }),
  }
}

function parseDraftSummary(value: unknown) {
  const record = asRecord(value, 'Invalid plugin draft.')
  assertExactKeys(record, ['id', 'revision', 'displayName', 'version', 'updatedAt', 'ok', ...(record.distribution==='group'||record.distribution==='local-client'?['distribution']:[])], 'Invalid plugin draft.')
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('Invalid plugin draft.')
  if (typeof record.updatedAt !== 'number' || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) throw new Error('Invalid plugin draft.')
  if (typeof record.ok !== 'boolean') throw new Error('Invalid plugin draft.')
  return {
    id: requiredBounded(record.id, 128, 'Invalid plugin draft.'),
    revision: record.revision,
    displayName: requiredBounded(record.displayName, 80, 'Invalid plugin draft.'),
    version: requiredBounded(record.version, 32, 'Invalid plugin draft.'),
    updatedAt: record.updatedAt,
    ok: record.ok,
    ...(record.distribution==='group'||record.distribution==='local-client'?{distribution:record.distribution}:{}),
  }
}

function requiredBounded(value: unknown, maxLength: number, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) throw new Error(message)
  return value
}

function parseHostPing(value: unknown): HostPingResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid PC Host ping response.')
  const candidate = value as Partial<HostPingResult>
  for (const field of ['generation', 'roundTripMs', 'sentAtMs', 'hostReceivedAtMs'] as const) {
    if (typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field])) {
      throw new Error('Invalid PC Host ping response.')
    }
  }
  return candidate as HostPingResult
}

function parseChoice<T extends string>(value:unknown,choices:readonly T[]):T {
  if(typeof value!=='string'||!choices.includes(value as T))throw new Error('无效操作结果，请刷新后确认当前状态')
  return value as T
}
function parseDesktopSettings(value:unknown) {
  if(!value||typeof value!=='object')throw new Error('通知设置尚未就绪，请重试')
  const v=value as Record<string,unknown>,p=v.preferences
  if(!p||typeof p!=='object'||typeof v.trayAvailable!=='boolean'||typeof v.notificationsSupported!=='boolean'||(v.error!==null&&typeof v.error!=='string'))throw new Error('无效通知设置')
  const preferences=p as Record<string,unknown>
  for(const key of ['notifications','preview','sound','closeToTray'])if(typeof preferences[key]!=='boolean')throw new Error('无效通知偏好')
  return value as {preferences:{notifications:boolean;preview:boolean;sound:boolean;closeToTray:boolean};trayAvailable:boolean;notificationsSupported:boolean;error:string|null}
}
contextBridge.exposeInMainWorld('moreThanChat', Object.freeze(api))
