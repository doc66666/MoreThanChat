import type { HostEventMessage } from '@more-than-chat/protocol'

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
  }
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
