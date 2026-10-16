import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@more-than-chat/chat-core'

export function isReadingBottom(node:Pick<HTMLElement,'scrollHeight'|'scrollTop'|'clientHeight'>):boolean {
  return node.clientHeight>0 && node.scrollHeight-node.scrollTop-node.clientHeight<=32
}
/** A root plugin may wrap defaultView rather than replace it. Test the actual
 * reading surface, including popup occlusion, not the existence of a plugin. */
export function isReadingVisible(node:HTMLElement):boolean {
  if(!node.isConnected||!node.getClientRects().length||node.clientHeight<=0)return false
  const box=node.getBoundingClientRect()
  if(box.bottom>window.innerHeight+1||box.bottom<=0||box.top>=window.innerHeight)return false
  const left=Math.max(0,box.left),right=Math.min(window.innerWidth,box.right)
  if(right<=left)return false
  const target=document.elementFromPoint((left+right)/2,box.bottom-Math.min(24,box.height/2))
  return target!==null&&node.contains(target)
}
export function useChatReading(conversationId:string|undefined,messages:readonly ChatMessage[],blocked:boolean,unread=0,positionBlocked=false) {
  const scrollRef=useRef<HTMLElement>(null),contentRef=useRef<HTMLDivElement>(null),endRef=useRef<HTMLDivElement>(null)
  const [scrollNode,setScrollNode]=useState<HTMLElement|null>(null),[contentNode,setContentNode]=useState<HTMLDivElement|null>(null)
  const bindScroll=useCallback((node:HTMLElement|null)=>{scrollRef.current=node;setScrollNode(node)},[])
  const bindContent=useCallback((node:HTMLDivElement|null)=>{contentRef.current=node;setContentNode(node)},[])
  const stick=useRef(true),previous=useRef<string|undefined>(undefined)
  const [atBottom,setAtBottom]=useState(true),[focused,setFocused]=useState(false)
  const last=messages.at(-1),signature=last?`${last.id}:${last.text}:${messages.length}`:''
  useEffect(()=>{
    let live=true,changed=false
    const stop=window.moreThanChat.onWindowFocusChanged?.(value=>{changed=true;if(live)setFocused(value)})
    void window.moreThanChat.getWindowFocus?.().then(value=>{if(live&&!changed)setFocused(value)}).catch(()=>undefined)
    return()=>{live=false;stop?.();void window.moreThanChat.setReadingConversation?.(null).catch(()=>undefined)}
  },[])
  const notify=useCallback(()=>{
    const node=scrollRef.current
    const id=conversationId&&node&&stick.current&&isReadingBottom(node)&&isReadingVisible(node)&&!blocked&&focused&&document.visibilityState==='visible'?conversationId:null
    void window.moreThanChat.setReadingConversation?.(id).catch(()=>undefined)
  },[conversationId,blocked,focused])
  const latest=useRef({positionBlocked,notify})
  latest.current={positionBlocked,notify}
  const settle=useCallback(()=>{
    const node=scrollRef.current
    if(!node){setAtBottom(false);latest.current.notify();return}
    // Receipt suppression (settings, popup, background window) must never disable
    // navigation. Only an explicit historic page/highlight pauses positioning.
    if(stick.current&&!latest.current.positionBlocked)node.scrollTop=node.scrollHeight
    setAtBottom(isReadingBottom(node))
    latest.current.notify()
  },[])
  // Position the real scroll container before paint; animated intermediate positions
  // must not revoke stickiness while incoming messages increase the content height.
  useLayoutEffect(()=>{
    const changed=previous.current!==conversationId
    if(changed)stick.current=true
    // A self message can originate from an assistant, plugin or another device.
    // Only explicit local send/navigation gestures may resume bottom-following.
    previous.current=conversationId
    settle()
  },[conversationId,signature,blocked,positionBlocked,focused,unread,scrollNode,settle])
  useLayoutEffect(()=>{
    const node=scrollRef.current,content=contentRef.current
    if(!node||!content)return
    const observer=new ResizeObserver(settle)
    observer.observe(node);observer.observe(content)
    settle()
    return()=>observer.disconnect()
  },[scrollNode,contentNode,settle])
  useEffect(()=>{
    let frame:number|undefined
    const schedule=()=>{if(frame===undefined)frame=requestAnimationFrame(()=>{frame=undefined;notify()})}
    // Plugin overlays can open without changing App state or container size.
    const observer=new MutationObserver(schedule)
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden']})
    document.addEventListener('visibilitychange',notify)
    window.addEventListener('resize',schedule)
    return()=>{observer.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',notify);window.removeEventListener('resize',schedule)}
  },[notify])
  const onScroll=()=>{
    const node=scrollRef.current;if(!node)return
    const bottom=isReadingBottom(node)
    stick.current=bottom;setAtBottom(bottom);notify()
  }
  const jumpToLatest=()=>{stick.current=true;settle()}
  const pauseReading=()=>{stick.current=false;setAtBottom(false);notify()}
  return {scrollRef,contentRef,bindScroll,bindContent,endRef,atBottom,onScroll,jumpToLatest,pauseReading}
}
