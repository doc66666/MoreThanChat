import type { DesktopPreferences } from './desktop-preferences'

export interface IncomingNotice { serverId: string; conversationId: string; messageId: string }
export interface NotificationMessage extends IncomingNotice {
  title: string; senderName: string; text: string; attachment?: { mime: string; name: string }
  own: boolean; read: boolean; retracted: boolean; muted: boolean; unavailable: boolean
}
export interface NotificationCard { title: string; body: string; silent: boolean; conversationId: string }
interface Ports {
  preferences(): DesktopPreferences
  foreground(): boolean
  lookup(notice: IncomingNotice): NotificationMessage | null
  show(card: NotificationCard, onClick: () => void): { close(): void } | null
  openConversation(id: string): void
  attention(): void
}
const clean = (value: string, limit: number) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)

// This controller only receives newly persisted messages, never historical snapshots.
// Timers coalesce bursts; every decision is revalidated against Main's current store.
export class ChatNotifications {
  #pending = new Map<string, { messages: Map<string, IncomingNotice>; timer: ReturnType<typeof setTimeout> }>()
  #visible = new Map<string, { messages: IncomingNotice[]; handle: { close(): void } }>()
  #lastShown = new Map<string, number>()
  constructor(private readonly ports: Ports) {}
  #eligible(notice: IncomingNotice): NotificationMessage | null {
    if (!this.ports.preferences().notifications || this.ports.foreground()) return null
    const message = this.ports.lookup(notice)
    return message && !message.own && !message.read && !message.retracted && !message.muted && !message.unavailable ? message : null
  }
  receive(notice: IncomingNotice): void {
    if (!this.#eligible(notice)) return
    const existing = this.#pending.get(notice.conversationId)
    if (existing) {
      existing.messages.set(notice.messageId, notice)
      if(existing.messages.size>100)existing.messages.delete(existing.messages.keys().next().value!)
      return
    }
    if (this.#pending.size >= 20) this.#cancel(this.#pending.keys().next().value!)
    const delay = Math.max(700, (this.#lastShown.get(notice.conversationId) ?? 0) + 4000 - Date.now())
    this.#pending.set(notice.conversationId, { messages: new Map([[notice.messageId, notice]]), timer: setTimeout(() => this.#deliver(notice.conversationId), delay) })
  }
  #cancel(id: string): void {
    const pending = this.#pending.get(id)
    if (pending) clearTimeout(pending.timer)
    this.#pending.delete(id)
  }
  #close(id: string): void {
    const entry = this.#visible.get(id)
    this.#visible.delete(id)
    try { entry?.handle.close() } catch {}
  }
  #deliver(id: string): void {
    const pending = this.#pending.get(id)
    this.#pending.delete(id)
    if (!pending) return
    const messages = [...pending.messages.values()].map(notice => this.#eligible(notice)).filter((m): m is NotificationMessage => Boolean(m))
    if (!messages.length) return
    const latest = messages.at(-1)!, preferences = this.ports.preferences()
    const attachment = latest.attachment ? (latest.attachment.mime.startsWith('audio/') ? '[语音]' : latest.attachment.mime.startsWith('image/') ? '[图片]' : '[文件] ' + latest.attachment.name) : ''
    const preview = clean(latest.text || attachment || '新消息', 160)
    const card: NotificationCard = {
      title: preferences.preview ? clean(latest.title, 80) || 'MoreThanChat' : 'MoreThanChat',
      body: preferences.preview ? clean(latest.senderName, 40) + '：' + preview + (messages.length > 1 ? `（${messages.length} 条新消息）` : '') : `你有 ${messages.length} 条新消息`,
      silent: !preferences.sound, conversationId: id,
    }
    this.#close(id)
    if (this.#visible.size >= 5) this.#close(this.#visible.keys().next().value!)
    const references=messages.map(({serverId,conversationId,messageId})=>({serverId,conversationId,messageId}))
    const latestReference=references.at(-1)!
    try {
      this.ports.attention()
      const handle = this.ports.show(card, () => {
        // A removed relationship or changed server cannot reopen stale destinations.
        if (this.#visible.get(id)?.handle !== handle) return
        const current = this.ports.lookup(latestReference)
        this.#close(id)
        if (current && !current.unavailable) this.ports.openConversation(id)
      })
      if (handle) this.#visible.set(id, { messages:references, handle })
      this.#lastShown.delete(id); this.#lastShown.set(id, Date.now())
      if (this.#lastShown.size > 100) this.#lastShown.delete(this.#lastShown.keys().next().value!)
    } catch { /* OS notification failures never interrupt durable delivery or ACK. */ }
  }
  reconcile(): void {
    for (const [id, entry] of this.#pending) if (![...entry.messages.values()].some(n => this.#eligible(n))) this.#cancel(id)
    for (const [id, entry] of this.#visible) {
      // Close the entire preview if any represented message was withdrawn/read/muted.
      if (entry.messages.some(n => !this.#eligible(n))) this.#close(id)
    }
  }
  clear(): void {
    for (const id of this.#pending.keys()) this.#cancel(id)
    for (const id of this.#visible.keys()) this.#close(id)
    this.#lastShown.clear()
  }
}

export function unreadCount(value: unknown): number {
  const state = value as { conversations?: { unread?: number; muted?: boolean; unavailable?: boolean }[] } | null
  return (state?.conversations ?? []).reduce((sum, c) => sum + (c.muted || c.unavailable ? 0 : Math.max(0, Number(c.unread) || 0)), 0)
}
