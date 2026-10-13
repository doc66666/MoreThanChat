export function insertAtSelection(text: string, insertion: string, start: number, end: number, limit = 100000) {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  if (text.length - (to - from) + insertion.length > limit) return { text, cursor: to }
  return { text: text.slice(0, from) + insertion + text.slice(to), cursor: from + insertion.length }
}

export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }) {
  // Some IMEs report composition as ended on the Enter that accepts a candidate.
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229
}
