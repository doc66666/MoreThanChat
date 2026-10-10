import { describe, expect, it } from 'vitest'
import { createHostEvent } from '@more-than-chat/protocol'
import { toClientModelEvent } from '../src/main/model-client-event'

describe('toClientModelEvent', () => {
  it('publishes token counts without forwarding provider-specific fields', () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, reportedRequests: 1, requestCount: 1 }
    const client = toClientModelEvent(createHostEvent('model.chat.completed', { streamId: 's', conversationId: 'c', assistantMessageId: 'm', generation: 1, text: 'reply', usage }))
    expect(client).toMatchObject({ type: 'completed', usage })
    if (client?.type === 'completed') expect(client.usage).not.toBe(usage)
  })
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

  it('copies author-tool progress without draft source or an API key', () => {
    const secret = 'sk-test-more-than-chat-secret'
    const source = 'globalThis.__mtcAuthorToolRan = true'
    const event = createHostEvent('model.authorTool', {
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      generation: 2,
      phase: 'finished',
      tool: 'create_draft',
      ok: true,
      summary: `校验通过。这份草稿尚未安装。${secret}`,
      pendingInstall: true,
      draft: { id: 'example.note', displayName: `草稿示例 ${secret}`, revision: 1, ok: true },
    })
    const client = toClientModelEvent(event)
    expect(client).toMatchObject({
      type: 'author-tool',
      phase: 'finished',
      tool: 'create_draft',
      ok: true,
      pendingInstall: true,
      draft: { id: 'example.note', revision: 1, ok: true },
    })
    expect(JSON.stringify(client)).not.toContain(secret)
    expect(JSON.stringify(client)).not.toContain(source)
    expect(JSON.stringify(client)).toContain('[redacted]')
    expect(JSON.stringify(client)).not.toContain('source')
  })
})
