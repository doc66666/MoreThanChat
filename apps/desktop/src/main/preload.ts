import { contextBridge, ipcRenderer } from 'electron'
import type { HostPluginCatalog, HostStatusSnapshot, ProtocolErrorCode } from '@more-than-chat/protocol'

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
  onHostStatusChanged: (listener: (status: HostStatusSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(parseHostStatus(value))
    ipcRenderer.on('host:status:changed', handler)
    return () => ipcRenderer.removeListener('host:status:changed', handler)
  },
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
