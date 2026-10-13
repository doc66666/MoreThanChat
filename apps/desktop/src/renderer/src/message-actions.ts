import type { Conversation } from '@more-than-chat/chat-core'

export function forwardTargets(conversations: Conversation[], serverId: string | undefined) {
  return serverId ? conversations.filter(c => c.serverId === serverId && c.transportId === 'builtin.central' && !c.unavailable && c.kind !== 'assistant') : []
}

/** The lock is acquired before React renders, including for same-tick clicks. */
export class MessageActionGate {
  private pending = new Set<string>()
  async run(key: string, action: () => Promise<void>): Promise<boolean> {
    if (this.pending.has(key)) return false
    this.pending.add(key)
    try { await action(); return true }
    finally { this.pending.delete(key) }
  }
}

/** Retrying a destination reuses its id; choosing another is a separate message. */
export class ForwardAttemptIds {
  private ids = new Map<string, string>()
  constructor(private createId: () => string) {}
  forTarget(target: string) {
    let id = this.ids.get(target)
    if (!id) { id = this.createId(); this.ids.set(target, id) }
    return id
  }
}
