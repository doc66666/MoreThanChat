import { contextBridge, ipcRenderer } from 'electron'
import type { HostPluginCatalog, HostStatusSnapshot, ModelProviderMode, ModelSettingsSnapshot, ProtocolErrorCode } from '@more-than-chat/protocol'

interface HostPingResult {
  generation: number
  roundTripMs: number
  sentAtMs: number
  hostReceivedAtMs: number
}

const api = {
  loadState: (): Promise<unknown | null> => ipcRenderer.invoke('chat:state:load') as Promise<unknown | null>,
  saveState: (value: unknown): Promise<void> => ipcRenderer.invoke('chat:state:save', value) as Promise<void>,
  getAppInfo: (): Promise<{ version: string; platform: string }> => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string }>,
  getHostStatus: async (): Promise<HostStatusSnapshot> => parseHostStatus(await ipcRenderer.invoke('host:status:get')),
  pingHost: async (): Promise<HostPingResult> => parseHostPing(await ipcRenderer.invoke('host:ping')),
  getHostPlugins: async (): Promise<HostPluginCatalog> => parsePluginCatalog(await ipcRenderer.invoke('host:plugins:list')),
  setHostPluginEnabled: async (pluginId: string, enabled: boolean): Promise<HostPluginCatalog> =>
    parsePluginCatalog(await ipcRenderer.invoke('host:plugins:set-enabled', { pluginId, enabled })),
  invokeHostTool: async (pluginId: string, toolId: string): Promise<{ generation: number; text: string }> => {
    const value = await ipcRenderer.invoke('host:tools:invoke', { pluginId, toolId }) as { generation?: unknown; text?: unknown } | null
    if (!value || !Number.isSafeInteger(value.generation) || typeof value.text !== 'string' || !value.text.trim()) throw new Error('Invalid host tool response.')
    return { generation: value.generation as number, text: value.text }
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

interface ModelClientEvent {
  type: 'delta' | 'completed' | 'failed' | 'cancelled'
  streamId: string
  conversationId: string
  assistantMessageId: string
  generation: number
  textDelta?: string
  text?: string
  partialText?: string
  errorMessage?: string
}

const hostStates = new Set(['starting', 'ready', 'restarting', 'failed', 'stopped'])
const pluginStates = new Set(['inactive', 'activating', 'active', 'deactivating', 'failed'])

// Sandboxed preload cannot require workspace modules; main and Host use the
// shared protocol parser, and this narrow bridge independently checks its DTOs.
function parsePluginCatalog(value: unknown): HostPluginCatalog {
  if (!value || typeof value !== 'object') throw new Error('Invalid host plugin catalog.')
  const catalog = value as HostPluginCatalog
  if (!Number.isSafeInteger(catalog.generation) || catalog.generation < 0 || !Array.isArray(catalog.plugins)) throw new Error('Invalid host plugin catalog.')
  for (const plugin of catalog.plugins) {
    if (!plugin || typeof plugin !== 'object' || !pluginStates.has(plugin.status)
      || (plugin.error !== null && typeof plugin.error !== 'string') || !Array.isArray(plugin.tools)) throw new Error('Invalid host plugin.')
    for (const key of ['id', 'displayName', 'description', 'version'] as const) {
      if (typeof plugin[key] !== 'string' || !plugin[key].trim()) throw new Error('Invalid host plugin.')
    }
    for (const tool of plugin.tools) {
      if (!tool || typeof tool.id !== 'string' || !tool.id.trim() || typeof tool.label !== 'string' || !tool.label.trim()) throw new Error('Invalid host tool.')
    }
  }
  return catalog
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
  'textDelta', 'text', 'partialText', 'errorMessage',
])

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
    return { type: 'completed', ...identity, text: record.text }
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
  throw new Error('Invalid model event.')
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
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

contextBridge.exposeInMainWorld('moreThanChat', Object.freeze(api))
