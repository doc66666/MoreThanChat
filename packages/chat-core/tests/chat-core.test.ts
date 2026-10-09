import { describe, expect, it, vi } from 'vitest'
import {
  TransportRegistry,
  applyModelChatUpdate,
  createSeedState,
  formatRelativeTime,
  interruptStreamingMessages,
  normalizeState,
  toModelTranscript,
  type ChatMessage,
  type ChatTransportPlugin,
} from '../src/index.js'

describe('model chat updates', () => {
  it('appends deltas and only marks a reply complete after the completed event', () => {
    const state = withAssistant('streaming', '')
    const delta = applyModelChatUpdate(state, {
      type: 'delta',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      textDelta: '你好',
    })
    expect(delta.messages['conversation-assistant']?.at(-1)).toMatchObject({ text: '你好', status: 'streaming' })
    const done = applyModelChatUpdate(delta, {
      type: 'completed',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      text: '你好',
    })
    expect(done.messages['conversation-assistant']?.at(-1)?.status).toBe('sent')
  })

  it('does not let a late completion overwrite a cancellation or failure', () => {
    const streaming = withAssistant('streaming', '部分')
    const cancelled = applyModelChatUpdate(streaming, {
      type: 'cancelled',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      partialText: '部分文本',
    })
    const late = applyModelChatUpdate(cancelled, {
      type: 'completed',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      text: '部分文本，但是完整了',
    })
    expect(late.messages['conversation-assistant']?.at(-1)).toMatchObject({ status: 'cancelled', text: '部分文本' })

    const failed = applyModelChatUpdate(streaming, {
      type: 'failed',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      partialText: '部分',
    })
    const ignored = applyModelChatUpdate(failed, {
      type: 'delta',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      textDelta: '更多',
    })
    expect(ignored.messages['conversation-assistant']?.at(-1)).toMatchObject({ status: 'failed', text: '部分' })
  })

  it('interrupts every streaming reply when the host drops', () => {
    const state = withAssistant('streaming', '一半')
    const interrupted = interruptStreamingMessages(state)
    expect(interrupted.messages['conversation-assistant']?.at(-1)?.status).toBe('cancelled')
    expect(interruptStreamingMessages(interrupted)).toBe(interrupted)
  })

  it('builds a transcript without in-flight or failed text and without credential fields', () => {
    const secret = 'sk-should-not-be-added'
    const state = withAssistant('cancelled', '先前取消的回复')
    const messages = state.messages['conversation-assistant'] ?? []
    const transcript = toModelTranscript(messages, '新的问题')
    expect(transcript.at(-1)).toEqual({ role: 'user', content: '新的问题' })
    expect(transcript.some(message => message.content === '先前取消的回复')).toBe(true)
    expect(JSON.stringify(transcript)).not.toContain(secret)
    expect(transcript.some(message => message.content === '')).toBe(false)
  })
})

describe('TransportRegistry', () => {
  const plugin: ChatTransportPlugin = {
    id: 'test.transport',
    version: '1.0.0',
    displayName: 'Test',
    create: () => ({
      id: 'test.transport',
      displayName: 'Test',
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
    }),
  }

  it('registers and disposes a transport contribution', () => {
    const registry = new TransportRegistry()
    const dispose = registry.register(plugin)
    expect(registry.get(plugin.id)).toBe(plugin)
    dispose()
    expect(registry.get(plugin.id)).toBeUndefined()
  })

  it('rejects duplicate ids', () => {
    const registry = new TransportRegistry()
    registry.register(plugin)
    expect(() => registry.register(plugin)).toThrow(/already registered/)
  })
})

describe('chat state', () => {
  it('falls back to a usable seed when persisted data is invalid', () => {
    const state = normalizeState({ version: 99 })
    expect(state.conversations.length).toBeGreaterThan(0)
    expect(state.messages[state.activeConversationId]?.length).toBeGreaterThan(0)
  })

  it('keeps a valid version-one snapshot', () => {
    const state = createSeedState(1_700_000_000_000)
    expect(normalizeState(state)).toEqual(state)
  })

  it('restores an interrupted assistant reply as cancelled instead of completed', () => {
    const state = createSeedState(1_700_000_000_000)
    const conversationId = 'conversation-assistant'
    const partial = assistantMessage(conversationId, 'streaming', '还没写完')
    state.messages[conversationId] = [...(state.messages[conversationId] ?? []), partial]
    const restored = normalizeState(state)
    expect(restored.messages[conversationId]?.at(-1)).toMatchObject({ status: 'cancelled', text: '还没写完' })
    expect(restored.messages[conversationId]?.at(-1)?.status).not.toBe('sent')
  })

  it('formats a same-day timestamp as a clock time', () => {
    const now = new Date(2026, 8, 3, 10, 30).getTime()
    const value = formatRelativeTime(new Date(2026, 8, 3, 9, 15).getTime(), now)
    expect(value).toMatch(/09:15/)
  })
})

function assistantMessage(conversationId: string, status: ChatMessage['status'], text: string): ChatMessage {
  return {
    id: 'assistant-1',
    clientMessageId: 'assistant-1',
    conversationId,
    senderId: 'more-ai',
    senderName: 'More AI',
    senderAvatar: 'AI',
    role: 'peer',
    type: 'text',
    text,
    createdAt: 20,
    status,
  }
}

function withAssistant(status: ChatMessage['status'], text: string) {
  const state = createSeedState(1_700_000_000_000)
  const conversationId = 'conversation-assistant'
  return {
    ...state,
    messages: {
      ...state.messages,
      [conversationId]: [...(state.messages[conversationId] ?? []), assistantMessage(conversationId, status, text)],
    },
  }
}
