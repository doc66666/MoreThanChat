import { useSyncExternalStore } from 'react'
import type { AttachmentRef } from '@more-than-chat/central-protocol'

interface Draft { text: string; attachment: AttachmentRef | null }
const key = 'more-than-chat.chat-drafts'
const empty: Draft = { text: '', attachment: null }
const listeners = new Set<() => void>()
let snapshot: { drafts: Record<string, Draft>; error: boolean } = { drafts: {}, error: false }
try {
  const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, Draft>
  for (const [id, draft] of Object.entries(value))
    if (!['__proto__','constructor','prototype'].includes(id) && typeof draft?.text === 'string' && draft.text.length <= 100000)
      snapshot.drafts[id] = { text: draft.text, attachment: draft.attachment?.id?.match(/^[a-f0-9]{64}$/) ? draft.attachment : null }
} catch { snapshot.error = true }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function update(id: string, patch: Partial<Draft>) {
  if (!id) return
  const drafts = { ...snapshot.drafts, [id]: { ...(snapshot.drafts[id] ?? empty), ...patch } }
  if (!drafts[id]!.text && !drafts[id]!.attachment) delete drafts[id]
  let error = false
  try { localStorage.setItem(key, JSON.stringify(drafts)) } catch { error = true }
  snapshot = { drafts, error }
  for (const listener of listeners) listener()
}
export function useChatDraft(id: string) {
  const value = useSyncExternalStore(subscribe, () => snapshot)
  const draft = value.drafts[id] ?? empty
  return { ...draft, error: value.error, setText: (text: string | ((previous:string)=>string)) => update(id, { text: typeof text==='function' ? text(snapshot.drafts[id]?.text ?? '') : text }), setAttachment: (attachment: AttachmentRef | null) => update(id, { attachment }) }
}
