import { validUid, type Directory } from '@more-than-chat/central-protocol'

export function friendRequestIssue(input: string, userId: string | undefined, directory: Directory | null | undefined): string | null {
  const id = input.trim()
  if (!id) return '粘贴好友的完整用户 ID 后提交。'
  if (!validUid(id)) return '用户 ID 格式不正确，请复制完整的 usr_ 开头的 ID。'
  if (id === userId) return '不能添加自己为好友。'
  if (directory?.friends.some(friend => friend.id === id)) return '你们已经是好友，可以直接打开会话。'
  if (directory?.outgoingRequests?.some(friend => friend.id === id)) return '好友申请已发出，请等待对方接受。'
  if (directory?.requests.some(friend => friend.id === id)) return '对方已经发来申请，请在下方直接接受。'
  return null
}

export function selectedCurrentFriends(selected: string[], directory: Directory | null | undefined): string[] {
  const current = new Set(directory?.friends.map(friend => friend.id) ?? [])
  return [...new Set(selected)].filter(id => current.has(id))
}
