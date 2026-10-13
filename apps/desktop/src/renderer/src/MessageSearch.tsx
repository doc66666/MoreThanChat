import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { MessageSearchController, type SearchState } from './message-search-controller'
import { useDialogFocus } from './use-dialog-focus'
type Result = Awaited<ReturnType<Window['moreThanChat']['searchChatMessages']>>[number]
export function MessageSearch({conversationId,title,conversationTitles={},onClose,onSelect}:{conversationId:string;title:string;conversationTitles?:Record<string,string>;onClose:()=>void;onSelect:(result:Result)=>void}) {
  const [query,setQuery]=useState(''),[all,setAll]=useState(false)
  const [state,setState]=useState<SearchState<Result>>({status:'idle',results:[],error:''})
  const controller=useRef<MessageSearchController<Result>|null>(null)
  if(!controller.current)controller.current=new MessageSearchController((query,id)=>window.moreThanChat.searchChatMessages(query,id),setState)
  const input=useRef<HTMLInputElement>(null)
  const dialog=useDialogFocus()
  useEffect(()=>{
    controller.current!.run(query,all?undefined:conversationId)
    return()=>controller.current!.cancel()
  },[query,all,conversationId])
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside ref={dialog} tabIndex={-1} className="plugin-drawer search-drawer" role="dialog" aria-modal="true" aria-label="查找聊天记录" onMouseDown={e=>e.stopPropagation()}>
    <div className="drawer-header"><h2>查找聊天记录</h2><button className="icon-button" onClick={onClose} aria-label="关闭搜索"><X size={18}/></button></div>
    <div className="search-box"><Search size={17}/><input ref={input} data-message-search data-dialog-initial-focus aria-label="聊天记录关键词" autoFocus maxLength={200} value={query} onChange={e=>setQuery(e.target.value)} placeholder="输入关键词"/>{query&&<button className="icon-button" aria-label="清空搜索" onClick={()=>{setQuery('');input.current?.focus()}}><X size={15}/></button>}</div>
    <label className="group-member-option"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>搜索全部会话</label>
    <p className="settings-note">{all?'本机保存的全部聊天记录':title} · 最多显示 50 条结果</p>
    {state.status==='error'&&<div className="search-error" role="alert"><p className="settings-error">{state.error}</p><button className="secondary-button" onClick={()=>controller.current!.run(query,all?undefined:conversationId,0)}>重试搜索</button></div>}
    <p className="settings-note" role="status">{state.status==='loading'?'正在查找…':state.status==='ready'?`找到 ${state.results.length===50?'至少 ':''}${state.results.length} 条消息${state.results.length===50?'，可增加关键词缩小范围':''}`:state.status==='idle'?'输入关键词查找本机记录；清空关键词不会删除消息。':''}</p>
    {state.results.map(row=><button className="search-result" data-search-result={row.messageId} key={row.messageId} onClick={()=>onSelect(row)}>{all&&<small className="search-result-conversation">{conversationTitles[row.conversationId]??'保留在本机的历史会话'}</small>}<span><strong>{row.senderName}</strong><time>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></span><p>{row.text}</p><small className="search-result-hint">打开所在会话并定位</small></button>)}
    {state.status==='ready'&&!state.results.length&&<p className="empty-search">没有找到相关消息，试试更短的关键词或搜索全部会话。</p>}
  </aside></div>
}
