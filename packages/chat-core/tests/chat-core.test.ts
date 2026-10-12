import { describe, expect, it, vi } from 'vitest'
import {
  TransportRegistry,
  applyModelChatUpdate,
  authorToolLabel,
  createSeedState,
  formatRelativeTime,
  interruptStreamingMessages,
  normalizeState,
  mergeCentralProjection,
  redactMessageForRetraction,
  planAssistantRetry,
  toModelTranscript,
  type ChatMessage,
  type ChatState,
  type ChatTransportPlugin,
} from '../src/index.js'

describe('model chat updates', () => {
  it('redacts historical message windows and references without changing other servers or independent copies',()=>{
    const seed=createSeedState(),template=seed.messages[seed.activeConversationId]![0]!,id='canonical',notice={serverId:'server',messageId:id,clientMessageId:'pending',senderId:'sender',retractedAt:21,createdAt:20}
    const source={...template,id:'pending',clientMessageId:'pending',senderId:'sender',serverId:'server',text:'secret',attachment:{id:'a'.repeat(64),name:'file.txt',mime:'text/plain',size:2}}
    expect(redactMessageForRetraction(source,notice)).toMatchObject({id,text:'',retractedAt:21})
    expect(redactMessageForRetraction(source,notice)).not.toHaveProperty('attachment')
    const other={...source,serverId:'other'};expect(redactMessageForRetraction(other,notice)).toBe(other)
    const reference={messageId:id,senderId:'sender',senderName:'Sender',text:'secret',attachmentName:'file.txt'}
    const quoted={...source,id:'reply',clientMessageId:'reply',text:'reply',quote:reference}
    expect(redactMessageForRetraction(quoted,notice).quote).toEqual({messageId:id,senderId:'sender',senderName:'Sender',text:'引用的消息已撤回',retracted:true})
    const forwarded={...source,id:'forward',clientMessageId:'forward',forwarded:reference};expect(redactMessageForRetraction(forwarded,notice)).toBe(forwarded)
  })
  it('closes a removed relationship but still permits deliberate viewing of its local history',()=>{
    const state=createSeedState(),assistant=state.activeConversationId,id='server:friend'
    state.conversations.push({...state.conversations[0]!,id,kind:'direct',serverId:'server',transportId:'builtin.central'})
    state.activeConversationId=id;state.messages[id]=[]
    const projection={...state,conversations:state.conversations.map(c=>c.id===id?{...c,unavailable:true}:c)}
    const removed=mergeCentralProjection(state,projection)
    expect(removed.activeConversationId).toBe(assistant)
    const historyView={...removed,activeConversationId:id}
    expect(mergeCentralProjection(historyView,projection).activeConversationId).toBe(id)
    expect(removed.conversations.find(c=>c.id===id)).toBeDefined()
  })
  it('replaces bounded server windows without accumulating old pages or interrupting local AI state',()=>{
    const state=withAssistant('streaming','live AI reply'),id='server:friend'
    state.conversations.push({...state.conversations[0]!,id,kind:'direct',serverId:'server',transportId:'builtin.central'})
    const template={...state.messages['conversation-assistant']![0]!,conversationId:id,serverId:'server'}
    state.messages[id]=Array.from({length:100},(_,i)=>({...template,id:'old-'+i,clientMessageId:'old-'+i}))
    const projection:ChatState={...state,messages:{[id]:[{...template,id:'latest',clientMessageId:'latest'}]},history:{[id]:{before:100,after:100,hasOlder:true,hasNewer:false}}}
    const merged=mergeCentralProjection(state,projection)
    expect(merged.messages[id]!.map(m=>m.id)).toEqual(['latest'])
    expect(merged.messages['conversation-assistant']).toBe(state.messages['conversation-assistant'])
    expect(merged.messages['conversation-assistant']!.at(-1)!.status).toBe('streaming')
    expect(merged.activeConversationId).toBe(state.activeConversationId)
    expect(merged.history?.[id]?.before).toBe(100)
    expect(state.messages[id]).toHaveLength(100)
  })
  it('cancels only the selected conversation while another keeps streaming', () => {
    const state = withAssistant('streaming', 'partial')
    state.messages.other = [{ ...state.messages['conversation-assistant']!.at(-1)!, id: 'other-assistant', conversationId: 'other', status: 'streaming' }]
    const cancelled = interruptStreamingMessages(state, 'conversation-assistant')
    expect(cancelled.messages['conversation-assistant']!.at(-1)!.status).toBe('cancelled')
    expect(cancelled.messages.other![0]!.status).toBe('streaming')
    expect(state.messages['conversation-assistant']!.at(-1)!.status).toBe('streaming')
  })
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
    expect(transcript.some(message => message.content === '先前取消的回复')).toBe(false)
    expect(JSON.stringify(transcript)).not.toContain(secret)
    expect(transcript.some(message => message.content === '')).toBe(false)
  })

  it('keeps author-tool progress on the message and out of the model transcript', () => {
    const secret = 'sk-test-more-than-chat-secret'
    const source = 'globalThis.__mtcAuthorToolRan = true'
    const streaming = withAssistant('streaming', '')
    const noted = applyModelChatUpdate(streaming, {
      type: 'author-tool',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      note: {
        phase: 'finished',
        tool: 'create_draft',
        ok: true,
        summary: `校验通过。这份草稿尚未安装。${secret}`,
        pendingInstall: true,
        draft: { id: 'example.note', displayName: '草稿示例', revision: 1, ok: true },
      },
    })
    const failed = applyModelChatUpdate(noted, {
      type: 'author-tool',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      note: {
        phase: 'finished',
        tool: 'install_draft',
        ok: false,
        summary: '安装需要用户在界面确认。模型不能安装插件，源码也不会执行。',
        pendingInstall: false,
        draft: null,
      },
    })
    const done = applyModelChatUpdate(failed, {
      type: 'completed',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      text: '草稿已创建',
    })
    const message = done.messages['conversation-assistant']?.at(-1)
    expect(message).toMatchObject({ status: 'sent', text: '草稿已创建' })
    expect(message?.authorNotes).toHaveLength(2)
    expect(authorToolLabel(message!.authorNotes![0]!)).toBe('待安装草稿：草稿示例（example.note）。校验通过。这份草稿尚未安装。[redacted]')
    expect(authorToolLabel(message!.authorNotes![1]!)).toContain('模型不能安装插件')
    const transcript = toModelTranscript(done.messages['conversation-assistant'] ?? [])
    expect(transcript.some(item => item.content === '草稿已创建')).toBe(true)
    expect(JSON.stringify(transcript)).not.toContain('尚未安装')
    expect(JSON.stringify(transcript)).not.toContain('模型不能安装插件')
    expect(JSON.stringify(transcript)).not.toContain(secret)
    expect(JSON.stringify(transcript)).not.toContain(source)
    expect(JSON.stringify(message)).not.toContain(source)
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
  it('restores interrupted outgoing messages as failed instead of forever sending', () => {
    const state = createSeedState()
    const item = state.messages['conversation-assistant']![0]!
    item.status = 'sending'
    expect(normalizeState(state).messages['conversation-assistant']![0]!.status).toBe('failed')
  })
  it('retries the original question exactly once and rejects old or busy turns', () => {
    const user: ChatMessage = { ...assistantMessage('test', 'sent', 'original question'), id: 'user', role: 'self' }
    const failed: ChatMessage = { ...assistantMessage('test', 'failed', 'partial answer'), replyToId: 'user' }
    expect(planAssistantRetry([user, failed], failed.id)?.transcript).toEqual([{ role: 'user', content: 'original question' }])
    const next: ChatMessage = { ...failed, id: 'retry', retryOfId: failed.id, status: 'streaming' }
    expect(planAssistantRetry([user, failed, next], failed.id)).toBeNull()
    expect(planAssistantRetry([user, { ...failed, supersededById: next.id }], failed.id)).toBeNull()
    expect(planAssistantRetry([user, failed, { ...user, id: 'later' }], failed.id)).toBeNull()
    expect(planAssistantRetry([user, { ...failed, supersededById: next.id }, { ...next, status: 'cancelled' }], next.id)?.transcript).toEqual([{ role: 'user', content: 'original question' }])
  })
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

function withAssistant(status: ChatMessage['status'], text: string): ChatState {
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
