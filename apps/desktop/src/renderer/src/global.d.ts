export {}

import type { HostPluginCatalog, HostStatusSnapshot } from '@more-than-chat/protocol'

declare global {
  interface Window {
    moreThanChat: {
      loadState(): Promise<unknown | null>
      saveState(value: unknown): Promise<void>
      getAppInfo(): Promise<{ version: string; platform: string }>
      getHostStatus(): Promise<HostStatusSnapshot>
      getHostPlugins(): Promise<HostPluginCatalog>
      setHostPluginEnabled(pluginId: string, enabled: boolean): Promise<HostPluginCatalog>
      invokeHostTool(pluginId: string, toolId: string): Promise<{ generation: number; text: string }>
      pingHost(): Promise<{
        generation: number
        roundTripMs: number
        sentAtMs: number
        hostReceivedAtMs: number
      }>
      onHostStatusChanged(listener: (status: HostStatusSnapshot) => void): () => void
    }
  }
}
