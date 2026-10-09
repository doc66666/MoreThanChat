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

export interface ModelClientIdentity {
  streamId: string
  conversationId: string
  assistantMessageId: string
  generation: number
}

export interface ModelAuthorToolClientEvent extends ModelClientIdentity {
  type: 'author-tool'
  phase: 'started' | 'finished'
  tool: 'inspect_drafts' | 'create_draft' | 'validate_draft' | 'diagnose_draft' | 'install_draft' | 'unknown'
  ok: boolean
  summary: string
  pendingInstall: boolean
  draft: {
    id: string
    displayName: string
    revision: number
    ok: boolean
  } | null
}

export type ModelClientEvent =
  | (ModelClientIdentity & { type: 'delta'; textDelta: string })
  | (ModelClientIdentity & { type: 'completed'; text: string })
  | (ModelClientIdentity & { type: 'failed'; partialText: string; errorMessage: string })
  | (ModelClientIdentity & { type: 'cancelled'; partialText: string })
  | ModelAuthorToolClientEvent

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
