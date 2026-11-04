import { describe, expect, it } from 'vitest'
import { createSeedState, type ChatMessage, type Conversation } from '@more-than-chat/chat-core'
import { avatarTone, conversationPreview, visibleConversations } from '../src/renderer/src/conversation-presentation'

const base = createSeedState().conversations[0]!
const conversation = (id: string, changes: Partial<Conversation> = {}): Conversation => ({
  ...base, id, title: id, pinned: false, unread: 0, updatedAt: 0, ...changes,
})
const message = (changes: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message', clientMessageId: 'message', conversationId: 'room', senderId: 'peer',
  senderName: 'Peer', senderAvatar: 'P', role: 'peer', type: 'text', text: '',
  createdAt: 1, status: 'sent', ...changes,
})

describe('conversation sidebar presentation', () => {
  const conversations = [
    conversation('AI', {kind:'assistant', pinned:true}),
    conversation('Design', {kind:'group', unread:2, updatedAt:3}),
    conversation('Friend', {kind:'direct', updatedAt:2}),
    conversation('Left group', {kind:'group', serverId:'server', unavailable:true, unread:5}),
  ]
  it('keeps pinned ordering and does not mutate the stored conversations', () => {
    expect(visibleConversations(conversations, '', 'all').map(c => c.id)).toEqual(['AI', 'Design', 'Friend'])
    expect(conversations.map(c => c.id)).toEqual(['AI', 'Design', 'Friend', 'Left group'])
  })
  it('combines the query with each filter and excludes unavailable server relations', () => {
    expect(visibleConversations(conversations, ' design ', 'unread').map(c => c.id)).toEqual(['Design'])
    expect(visibleConversations(conversations, '', 'direct').map(c => c.id)).toEqual(['Friend'])
    expect(visibleConversations(conversations, '', 'group').map(c => c.id)).toEqual(['Design'])
    expect(visibleConversations(conversations, 'friend', 'unread')).toEqual([])
  })
  it('reflects read acknowledgements without altering conversation state', () => {
    const read = conversations.map(c => ({...c, unread:0}))
    expect(visibleConversations(read, '', 'unread')).toEqual([])
    expect(conversations[1]!.unread).toBe(2)
  })
  it('describes attachments by type and never reveals a retracted preview', () => {
    const image = message({attachment:{id:'file', mime:'image/png', name:'设计.png', size:10}})
    expect(conversationPreview(image)).toBe('[图片] 设计.png')
    expect(conversationPreview({...image, text:'这是新版'})).toBe('[图片] 这是新版')
    expect(conversationPreview({...image, retractedAt:2})).toBe('一条消息已撤回')
    expect(conversationPreview(message({attachment:{id:'v', mime:'audio/webm', name:'语音', durationMs:1000, size:1}}))).toBe('[语音] 语音')
    expect(conversationPreview(message({attachment:{id:'f', mime:'application/pdf', name:'文档.pdf', size:10}}))).toBe('[文件] 文档.pdf')
  })
  it('handles a new conversation and a streaming placeholder', () => {
    expect(conversationPreview()).toBe('从一句问候开始')
    expect(conversationPreview(message({status:'streaming'}))).toBe('正在回复…')
    expect(conversationPreview(message({text:'hello'}))).toBe('hello')
  })
  it('uses a deterministic bounded avatar palette including unicode IDs', () => {
    for (const id of ['abc', '群聊', '🙂', '', 'a'.repeat(1000)]) {
      expect(avatarTone(id)).toBe(avatarTone(id))
      expect(avatarTone(id)).toBeGreaterThanOrEqual(0)
      expect(avatarTone(id)).toBeLessThan(5)
    }
  })
})
