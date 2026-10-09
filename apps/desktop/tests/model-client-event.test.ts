import { describe, expect, it } from 'vitest'
import { createHostEvent } from '@more-than-chat/protocol'
import { toClientModelEvent } from '../src/main/model-client-event'

describe('toClientModelEvent', () => {
  it('copies only renderer-visible stream fields', () => {
    const secret = 'sk-test-more-than-chat-secret'
    const failed = createHostEvent('model.chat.failed', {
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      generation: 2,
      partialText: '部分',
      error: { code: 'MODEL_REQUEST_FAILED', message: '模型请求失败。', retryable: true },
    })
    expect(toClientModelEvent(failed)).toEqual({
      type: 'failed',
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      generation: 2,
      partialText: '部分',
      errorMessage: '模型请求失败。',
    })
    expect(JSON.stringify(toClientModelEvent(failed))).not.toContain(secret)
    expect(toClientModelEvent(createHostEvent('host.statusChanged', { state: 'ready', generation: 1 }))).toBeNull()
    expect(toClientModelEvent(createHostEvent('model.chat.cancelled', {
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      generation: 2,
      partialText: '',
    }))).toMatchObject({ type: 'cancelled', partialText: '' })
  })
})