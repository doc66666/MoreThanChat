import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@more-than-chat/chat-core'

export function useChatReading(conversationId: string | undefined, messages: readonly ChatMessage[], searchOpen: boolean) {
  const scrollRef = useRef<HTMLElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const previous = useRef({ conversationId, signature: '' })
  const [atBottom, setAtBottom] = useState(true)
  const [focused,setFocused]=useState(false)
  useEffect(()=>{
    let changed=false,live=true
    const stop=window.moreThanChat.onWindowFocusChanged?.(value=>{changed=true;if(live)setFocused(value)})
    void window.moreThanChat.getWindowFocus?.().then(value=>{if(live&&!changed)setFocused(value)}).catch(()=>undefined)
    return()=>{live=false;stop?.()}
  },[])
  const notify = useCallback(() => {
    const id = conversationId && stick.current && !searchOpen && focused && document.visibilityState === 'visible' ? conversationId : null
    void window.moreThanChat.setReadingConversation?.(id).catch(() => undefined)
  }, [conversationId, searchOpen, focused])
  useEffect(() => {
    window.addEventListener('focus', notify)
    window.addEventListener('blur', notify)
    document.addEventListener('visibilitychange', notify)
    notify()
    return () => { window.removeEventListener('focus', notify); window.removeEventListener('blur', notify); document.removeEventListener('visibilitychange', notify) }
  }, [notify])
  const last = messages.at(-1)
  const signature = last ? last.id + ':' + last.text + ':' + messages.length : ''
  useEffect(() => {
    const changed = previous.current.conversationId !== conversationId
    if (changed) { stick.current = true; setAtBottom(true) }
    if (changed || previous.current.signature !== signature) {
      if (stick.current || last?.role === 'self') endRef.current?.scrollIntoView({ behavior: changed ? 'instant' : 'smooth' })
      previous.current = { conversationId, signature }
    }
    notify()
  }, [conversationId, signature, last?.role, notify])
  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    const value = node.scrollHeight - node.scrollTop - node.clientHeight < 90
    stick.current = value
    setAtBottom(value)
    notify()
  }
  const jumpToLatest = () => { stick.current = true;setAtBottom(true);endRef.current?.scrollIntoView({behavior:'smooth'});notify() }
  const pauseReading = () => { stick.current=false;setAtBottom(false);notify() }
  return { scrollRef,endRef,atBottom,onScroll,jumpToLatest,pauseReading }
}
