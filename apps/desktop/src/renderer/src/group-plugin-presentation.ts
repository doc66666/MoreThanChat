import type { ServerSnapshot, UiSlot } from '@more-than-chat/central-protocol'
import type { PluginDraftSummary } from '@more-than-chat/protocol'

export const slotLabels: Record<UiSlot, string> = {
  'app.sidebar': '会话列表侧栏', 'app.rail': '左侧导航栏', 'chat.header': '聊天顶部',
  'chat.message.before': '每条消息之前', 'chat.message.after': '每条消息之后',
  'chat.details': '聊天详情侧栏（推荐）', 'chat.composer.before': '输入框上方',
  'chat.composer.after': '输入框下方', 'app.overlay': '应用浮层',
}

export function submissionIssue(draft: PluginDraftSummary, snapshot: ServerSnapshot | null, groupId: string): string | null {
  if (!draft.ok) return '草稿尚未通过校验，请先让 AI 修订并重新校验。'
  if (snapshot?.status !== 'connected' || !snapshot.serverId) return '请先在「服务器与好友」中连接中心服务器，再提交申请。'
  const groups = snapshot.directory?.groups ?? []
  if (!groups.length) return '你还没有加入群聊，请先创建或加入一个群聊。'
  if (!groups.some(group => group.id === groupId)) return '请选择要使用此插件的群聊。'
  if (snapshot.directory?.plugins.some(plugin => plugin.groupId === groupId && plugin.submittedBy === snapshot.userId && plugin.pack.artifact?.manifest.id === draft.id && plugin.status === 'pending')) return '此插件已有申请等待管理员审批，请先等待处理，避免重复提交。'
  return null
}
