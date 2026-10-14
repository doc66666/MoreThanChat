import * as React from 'react'
import { useEffect, useState } from 'react'
import { directPluginScope, type ServerSnapshot } from '@more-than-chat/central-protocol'
import type { PluginDraftSummary } from '@more-than-chat/protocol'
import type { InstalledClientPackage } from '@more-than-chat/plugin-runtime'
import { pluginRuntime } from './plugin-host'
import { importClientModule } from './client-plugin-loader'
import { SharedClientPlugins } from './shared-client-plugins'
import { GroupPluginGate } from './GeneratedGroupPlugin'

let manager:SharedClientPlugins|undefined
function sharedManager(){return manager??=new SharedClientPlugins(pluginRuntime,window.moreThanChat,{version:1,React,app:window.moreThanChat},importClientModule,()=>window.dispatchEvent(new Event('shared-plugins-changed')))}
export function useSharedClientPlugins(snapshot:ServerSnapshot|null,scope:string|null) {
  const [revision,refresh]=useState(0)
  useEffect(()=>window.moreThanChat.onGroupPluginConsentChanged(()=>refresh(n=>n+1)),[])
  useEffect(()=>{
    void sharedManager().update(snapshot,scope).catch(console.error)
    return()=>{void sharedManager().update(null,null).catch(console.error)}
  },[snapshot,scope,revision])
}
export function SharedPluginChoices({snapshot,scope,onError}:{snapshot:ServerSnapshot|null;scope?:string|null;onError:(text:string)=>void}) {
  const [,refresh]=useState(0)
  useEffect(()=>{const listener=()=>refresh(n=>n+1);window.addEventListener('shared-plugins-changed',listener);return()=>window.removeEventListener('shared-plugins-changed',listener)},[])
  const plugins=snapshot?.directory?.plugins.filter(p=>p.status==='approved'&&p.pack.kind==='executable'&&(!scope||p.groupId===scope))??[]
  if(!plugins.length)return null
  return <section data-shared-plugins><h3>会话共享插件</h3><p className="settings-note">各设备自主载入。打开所属会话时运行，切换会话时清理；插件可使用整个客户端界面。</p>
    {plugins.map(plugin=><GroupPluginGate key={`${snapshot?.serverId}:${plugin.groupId}:${plugin.pack.id}:${plugin.digest}`} plugin={plugin} onError={onError}><p>{plugin.pack.displayName} · 已载入本机，打开所属会话即可使用。</p></GroupPluginGate>)}
    {[...(manager?.errors.values()??[])].map((error,index)=><p key={index} role="alert">{error}</p>)}
  </section>
}
export function ShareClientPlugin({snapshot,draft,pack}:{snapshot:ServerSnapshot|null;draft?:PluginDraftSummary;pack?:InstalledClientPackage}) {
  const [scope,setScope]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const directory=snapshot?.directory
  const options=[...(directory?.groups.map(g=>({id:g.id,name:'群聊 · '+g.name}))??[]),...(directory?.friends.map(f=>({id:directPluginScope(snapshot!.userId,f.id),name:'好友 · '+f.displayName}))??[])]
  const sourceId=draft?.id??pack?.manifest.id
  const history=directory?.plugins.filter(p=>p.submittedBy===snapshot?.userId&&p.pack.client?.manifest.id===sourceId)??[]
  return <details className="group-draft-submit" data-share-client={sourceId}><summary>分享到好友／群聊</summary>
    <p className="settings-note">分享同一份可执行代码：好友同意或群管理员批准后分发，每个人自己选择载入。界面位置由插件决定。</p>
    <select aria-label="插件分享目标" data-share-target value={scope} disabled={busy} onChange={event=>{setScope(event.target.value);setNotice('')}}><option value="">选择好友或群聊</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
    <button className="secondary-button" data-share-submit disabled={busy||snapshot?.status!=='connected'||!options.some(o=>o.id===scope)||!!draft&&!draft.ok} onClick={async()=>{
      if(!snapshot?.serverId)return
      setBusy(true);setNotice('')
      try {
        const source=draft?{draftId:draft.id,revision:draft.revision}:{pluginId:pack!.manifest.id,digest:pack!.digest}
        await window.moreThanChat.shareClientPlugin({serverId:snapshot.serverId,groupId:scope,...source})
        setNotice(scope.startsWith('dm_')?'已申请分享，等待对方同意。':'已提交，等待群管理员批准。')
      }catch(error){setNotice(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
    }}>{busy?'正在提交…':'申请分享此版本'}</button>
    {notice&&<p role="status">{notice}</p>}
    {history.map(p=><p key={`${p.groupId}:${p.pack.version}`}>{options.find(o=>o.id===p.groupId)?.name} · v{p.pack.version} · {{pending:'等待审批',approved:'已批准，成员自主载入',rejected:'已拒绝',superseded:'已被新版替代'}[p.status]}</p>)}
  </details>
}
