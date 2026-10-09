export {}

import type {
  HostPluginCatalog,
  HostStatusSnapshot,
  ModelChatMessage,
  ModelProviderMode,
  ModelSettingsSnapshot,
  PluginDraftCreateResult,
  PluginDraftInspection,
  PluginDraftInstallResult,
  PluginDraftReport,
} from '@more-than-chat/protocol'

export interface ModelClientEvent {
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

export interface ModelSettingsInput {
  baseUrl?: string
  model?: string
  providerMode?: ModelProviderMode
  apiKey?: string
  clearApiKey?: boolean
}

export interface ModelStreamRef {
  streamId: string
  conversationId: string
  assistantMessageId: string
  generation: number
}

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
      getModelSettings(): Promise<ModelSettingsSnapshot>
      setModelSettings(input: ModelSettingsInput): Promise<ModelSettingsSnapshot>
      startModelChat(input: {
        streamId: string
        conversationId: string
        assistantMessageId: string
        messages: ModelChatMessage[]
      }): Promise<ModelStreamRef>
      cancelModelChat(streamId: string): Promise<{ streamId: string; cancelled: true }>
      inspectPluginDrafts(): Promise<PluginDraftInspection>
      createPluginDraft(input: { manifestJson: string; source: string }): Promise<PluginDraftCreateResult>
      validatePluginDraft(draftId: string): Promise<PluginDraftReport>
      diagnosePluginDraft(draftId: string): Promise<PluginDraftReport>
      installPluginDraft(input: { draftId: string; confirmed: boolean }): Promise<PluginDraftInstallResult>
      onHostStatusChanged(listener: (status: HostStatusSnapshot) => void): () => void
      onModelChatEvent(listener: (event: ModelClientEvent) => void): () => void
    }
  }
}
