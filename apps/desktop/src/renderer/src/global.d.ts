export {}
import type { AttachmentRef, WireAttachment, ServerSnapshot, RelayEvent } from '@more-than-chat/central-protocol'

import type {
  HostPluginCatalog,
  HostStatusSnapshot,
  ModelChatMessage,
  ModelProviderMode,
  ModelSettingsSnapshot,
  ModelTokenUsage,
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
  | (ModelClientIdentity & { type: 'completed'; text: string; usage?: ModelTokenUsage })
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
      getWindowFocus():Promise<boolean>
      focusChatWindow():Promise<void>
      onWindowFocusChanged(listener:(focused:boolean)=>void):()=>void
      setReadingConversation(id:string|null):Promise<void>
      retryChatMessage(id:string):Promise<void>
      searchChatMessages(query:string,conversationId?:string):Promise<{messageId:string;conversationId:string;text:string;senderName:string;createdAt:number}[]>
      copyChatMessage(id:string):Promise<void>
      setConversationOptions(id:string,patch:{pinned?:boolean;archived?:boolean;muted?:boolean}):Promise<{pinned?:boolean;archived?:boolean;muted?:boolean}>
      setAppearance(theme:'light'|'dark'):Promise<void>
      getServerState():Promise<ServerSnapshot>
      copyGlobalUserId():Promise<void>
      getPluginInbox(groupId:string,pluginId:string):Promise<Extract<RelayEvent,{kind:'plugin'}>[]>
      connectServer(address:string,displayName:string):Promise<ServerSnapshot>
      disconnectServer():Promise<void>
      serverAction(route:string,data:unknown):Promise<ServerSnapshot>
      sendCentralMessage(input:{conversationId:string;clientMessageId:string;text:string;attachmentId?:string}):Promise<{eventId:string;acceptedAt:number;queued?:boolean}>
      chooseAttachment():Promise<AttachmentRef|null>
      recordVoice(input:{data:string;mime:string;durationMs:number}):Promise<AttachmentRef>
      readAttachment(id:string):Promise<WireAttachment>
      saveAttachment(id:string):Promise<void>
      onServerState(listener:(state:ServerSnapshot)=>void):()=>void
      onCentralChat(listener:(state:unknown)=>void):()=>void
      onPluginEvent(listener:(event:Extract<RelayEvent,{kind:'plugin'}>)=>void):()=>void
      loadState(): Promise<unknown | null>
      saveState(value: unknown): Promise<void>
      onBeforeClose(listener: () => Promise<void>): () => void
      getAppInfo(): Promise<{ version: string; platform: string }>
      getHostStatus(): Promise<HostStatusSnapshot>
      getHostPlugins(): Promise<HostPluginCatalog>
      setHostPluginEnabled(pluginId: string, enabled: boolean): Promise<HostPluginCatalog>
      invokeHostTool(pluginId: string, toolId: string, input?: string): Promise<{ generation: number; text: string; replaceDraft?: boolean }>
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
