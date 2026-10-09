import type { HostEventMessage } from '@more-than-chat/protocol'

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

/** Copies only the fields the renderer is allowed to see. */
export function toClientModelEvent(event: HostEventMessage): ModelClientEvent | null {
  switch (event.event) {
    case 'host.statusChanged':
      return null
    case 'model.chat.delta':
      return { type: 'delta', ...identity(event.payload), textDelta: event.payload.textDelta }
    case 'model.chat.completed':
      return { type: 'completed', ...identity(event.payload), text: event.payload.text }
    case 'model.chat.failed':
      return {
        type: 'failed',
        ...identity(event.payload),
        partialText: event.payload.partialText,
        errorMessage: event.payload.error.message,
      }
    case 'model.chat.cancelled':
      return { type: 'cancelled', ...identity(event.payload), partialText: event.payload.partialText }
    case 'model.authorTool':
      return publishAuthorTool(event.payload)
  }
}

function publishAuthorTool(payload: {
  streamId: string
  conversationId: string
  assistantMessageId: string
  generation: number
  phase: 'started' | 'finished'
  tool: ModelAuthorToolClientEvent['tool']
  ok: boolean
  summary: string
  pendingInstall: boolean
  draft: ModelAuthorToolClientEvent['draft']
}): ModelAuthorToolClientEvent {
  const draft = payload.draft
    ? {
        id: redactPublicText(payload.draft.id).trim().slice(0, 128),
        displayName: redactPublicText(payload.draft.displayName).trim().slice(0, 80),
        revision: payload.draft.revision,
        ok: payload.draft.ok,
      }
    : null
  const visibleDraft = draft && draft.id && draft.displayName ? draft : null
  return {
    type: 'author-tool',
    ...identity(payload),
    phase: payload.phase,
    tool: payload.tool,
    ok: payload.ok,
    summary: redactPublicText(payload.summary).trim().slice(0, 240) || '作者工具没有完成。源码没有执行。',
    pendingInstall: payload.pendingInstall && visibleDraft !== null,
    draft: visibleDraft,
  }
}

function redactPublicText(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

function identity(payload: {
  streamId: string
  conversationId: string
  assistantMessageId: string
  generation: number
}): Pick<ModelClientEvent, 'streamId' | 'conversationId' | 'assistantMessageId' | 'generation'> {
  return {
    streamId: payload.streamId,
    conversationId: payload.conversationId,
    assistantMessageId: payload.assistantMessageId,
    generation: payload.generation,
  }
}
