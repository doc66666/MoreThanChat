import { useSyncExternalStore } from 'react'
import type { AttachmentRef } from '@more-than-chat/central-protocol'

interface Draft { text: string; attachment: AttachmentRef | null;quoteMessageId:string|null }
const key = 'more-than-chat.chat-drafts'
const empty: Draft = { text: '', attachment: null,quoteMessageId:null }
const listeners = new Set<() => void>()
let snapshot: { drafts: Record<string, Draft>; error: boolean } = { drafts: {}, error: false }
try {
  const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, Draft>
  for (const [id, draft] of Object.entries(value))
    if (!['__proto__','constructor','prototype'].includes(id) && typeof draft?.text === 'string' && draft.text.length <= 100000)
      snapshot.drafts[id] = { text: draft.text, attachment: draft.attachment?.id?.match(/^[a-f0-9]{64}$/) ? draft.attachment : null,quoteMessageId:typeof draft.quoteMessageId==='string'&&/^[a-f0-9-]{36}$/.test(draft.quoteMessageId)?draft.quoteMessageId:null }
} catch { snapshot.error = true }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function update(id: string, patch: Partial<Draft>) {
  if (!id) return
  const drafts = { ...snapshot.drafts, [id]: { ...(snapshot.drafts[id] ?? empty), ...patch } }
  if (!drafts[id]!.text && !drafts[id]!.attachment && !drafts[id]!.quoteMessageId) delete drafts[id]
  let error = false
  try { localStorage.setItem(key, JSON.stringify(drafts)) } catch { error = true }
  snapshot = { drafts, error }
  for (const listener of listeners) listener()
}
// A slow send must not erase text or attachments edited while it was in flight.
export function consumeDraft(current: Draft, sent: Draft): Draft {
  return {
    text: current.text === sent.text ? '' : current.text,
    attachment: current.attachment?.id === sent.attachment?.id ? null : current.attachment,
    quoteMessageId: current.quoteMessageId === sent.quoteMessageId ? null : current.quoteMessageId,
  }
}
export function useChatDraft(id: string) {
  const value = useSyncExternalStore(subscribe, () => snapshot)
  const draft = value.drafts[id] ?? empty
  return { ...draft, error: value.error, consume: (attachment = draft.attachment) => update(id, consumeDraft(snapshot.drafts[id] ?? empty, { ...draft, attachment })), setText: (text: string | ((previous:string)=>string)) => update(id, { text: typeof text==='function' ? text(snapshot.drafts[id]?.text ?? '') : text }), setAttachment: (attachment: AttachmentRef | null) => update(id, { attachment }),setQuoteMessageId:(quoteMessageId:string|null)=>update(id,{quoteMessageId}) }
}
export function clearRetractedDraftQuotes(serverId:string,messageId:string):void {
  for(const [id,draft] of Object.entries(snapshot.drafts))if(id.startsWith(serverId+':')&&draft.quoteMessageId===messageId)update(id,{quoteMessageId:null})
}
