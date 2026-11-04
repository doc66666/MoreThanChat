import type { ChatMessage, Conversation } from '@more-than-chat/chat-core'

export type ConversationFilter = 'all' | 'unread' | 'direct' | 'group'

export function visibleConversations(conversations: Conversation[], query: string, filter: ConversationFilter) {
  const needle = query.trim().toLocaleLowerCase()
  return conversations.filter(item => (!item.serverId || !item.unavailable)
    && (!needle || item.title.toLocaleLowerCase().includes(needle))
    && (filter === 'all' || (filter === 'unread' ? item.unread > 0 : item.kind === filter)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

export function conversationPreview(message?: ChatMessage): string {
  if (!message) return '从一句问候开始'
  if (message.retractedAt) return '一条消息已撤回'
  if (message.attachment) {
    const attachment = message.attachment
    const type = attachment.durationMs ? '语音' : attachment.mime.startsWith('image/') ? '图片' : '文件'
    return `[${type}] ${message.text || attachment.name}`
  }
  return message.text || (message.status === 'streaming' ? '正在回复…' : '还没有消息')
}

export function avatarTone(id: string): number {
  return [...id].reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) >>> 0, 0) % 5
}
