import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
type Result = Awaited<ReturnType<Window['moreThanChat']['searchChatMessages']>>[number]
export function MessageSearch({conversationId,title,onClose,onSelect}:{conversationId:string;title:string;onClose:()=>void;onSelect:(result:Result)=>void}) {
  const [query,setQuery]=useState(''),[all,setAll]=useState(false),[results,setResults]=useState<Result[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{
    let cancelled=false
    const timer=setTimeout(()=>{
      if(!query.trim()){setResults([]);return}
      setBusy(true);setError('')
      void window.moreThanChat.searchChatMessages(query,all?undefined:conversationId).then(value=>{if(!cancelled)setResults(value)}).catch(e=>{if(!cancelled)setError(e.message)}).finally(()=>{if(!cancelled)setBusy(false)})
    },180)
    return()=>{cancelled=true;clearTimeout(timer)}
  },[query,all,conversationId])
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="plugin-drawer search-drawer" onMouseDown={e=>e.stopPropagation()}>
    <div className="drawer-header"><h2>查找聊天记录</h2><button className="icon-button" onClick={onClose} aria-label="关闭搜索"><X size={18}/></button></div>
    <label className="search-box"><Search size={17}/><input data-message-search autoFocus maxLength={200} value={query} onChange={e=>setQuery(e.target.value)} placeholder="输入关键词"/></label>
    <label className="group-member-option"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>搜索全部会话</label>
    <p className="settings-note">{all?'本机保存的全部聊天记录':title} · 最多显示 50 条结果</p>
    {error&&<p className="settings-error">{error}</p>}
    {busy?<p className="settings-note">正在查找…</p>:results.map(row=><button className="search-result" data-search-result={row.messageId} key={row.messageId} onClick={()=>onSelect(row)}><span><strong>{row.senderName}</strong><time>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></span><p>{row.text.length>200?row.text.slice(0,200)+'…':row.text}</p></button>)}
    {!busy&&query.trim()&&!results.length&&!error&&<p className="empty-search">没有找到相关消息</p>}
  </aside></div>
}
