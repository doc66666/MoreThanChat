import type { Directory, Member } from '@more-than-chat/central-protocol'

export function directoryMembers(directory: Directory | null | undefined): Map<string, Member> {
  const members = new Map<string, Member>()
  if (!directory) return members
  for (const group of directory.groups) for (const member of group.members) members.set(member.id, member)
  for (const request of directory.groupRequests ?? []) members.set(request.user.id, request.user)
  for (const member of [...directory.requests, ...(directory.outgoingRequests ?? []), ...directory.friends, directory.self]) members.set(member.id, member)
  return members
}

export function memberRelationship(directory: Directory | null | undefined, userId: string) {
  if (directory?.self.id === userId) return 'self'
  if (directory?.friends.some(member => member.id === userId)) return 'friend'
  if (directory?.requests.some(member => member.id === userId)) return 'incoming'
  if (directory?.outgoingRequests?.some(member => member.id === userId)) return 'outgoing'
  return 'none'
}

export function sharedGroups(directory: Directory | null | undefined, userId: string) {
  return directory?.groups.filter(group => group.members.some(member => member.id === userId)) ?? []
}

export function matchesContact(query: string, name: string, id: string) {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || name.toLocaleLowerCase().includes(needle) || id.toLocaleLowerCase().includes(needle)
}

export function nameInitials(name: string) { return Array.from(name.trim()).slice(0, 2).join('') || '?' }
