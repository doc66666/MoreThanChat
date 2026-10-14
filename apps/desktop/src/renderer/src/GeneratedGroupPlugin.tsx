import { useEffect, useRef, useState, type ReactNode } from 'react'
import { evaluate, type GroupPlugin, type ProgramContext, type Value } from '@more-than-chat/central-protocol'
import { chatNetworkService } from './plugin-host'

type Props={plugin:GroupPlugin;userId:string;members:string[];onError:(message:string)=>void}
export function GroupPluginGate({plugin,children,onError}:{plugin:GroupPlugin;children:ReactNode;onError:(s:string)=>void}) {
  const [consent,setConsent]=useState<'pending'|'loaded'|'declined'|null>(null)
  const [busy,setBusy]=useState(false)
  const [problem,setProblem]=useState('')
  const inFlight=useRef(false),request=useRef(0)
  const input={groupId:plugin.groupId,pluginId:plugin.pack.id,digest:plugin.digest}
  useEffect(()=>{
    let alive=true
    const refresh=()=>{
      if(inFlight.current)return
      const id=++request.current
      void window.moreThanChat.groupPluginConsent(input).then(value=>{if(alive&&id===request.current){setConsent(value);setProblem('')}}).catch(e=>{if(alive&&id===request.current){setConsent(null);setProblem(e instanceof Error?e.message:'本机授权检查失败')}})
    }
    refresh()
    const stop=window.moreThanChat.onGroupPluginConsentChanged(refresh)
    return()=>{alive=false;++request.current;stop()}
  },[plugin.groupId,plugin.pack.id,plugin.digest])
  async function choose(decision:'loaded'|'declined') {
    if(inFlight.current)return
    inFlight.current=true;setBusy(true)
    const id=++request.current
    try { const value=await window.moreThanChat.groupPluginConsent({...input,decision});if(id===request.current){setConsent(value);setProblem('')} }
    catch(e){if(id===request.current){const message=e instanceof Error?e.message:'本机授权保存失败';setProblem(message);onError(message)}}
    finally{inFlight.current=false;if(id===request.current)setBusy(false)}
  }
  return <section className="group-plugin-gate" aria-busy={busy} data-group-plugin-gate={plugin.pack.id} data-consent={consent??'checking'}>
    {problem&&<p className="inline-problem" role="alert">{problem}</p>}
    {consent==='loaded' ? <><button className="secondary-button" disabled={busy} data-disable-group-plugin onClick={()=>void choose('declined')}>停用本机插件</button>{children}</> : <>
      <strong>{plugin.pack.displayName} · v{plugin.pack.version}</strong>
      <p>{consent==='declined'?'本机未载入，不参与此插件；随时可以重新载入。':consent===null?(problem?'暂时无法验证本机选择，请检查服务器连接后重试。':'正在检查本机选择…'):'分享已获批准。是否在此设备载入？'}</p>
      <p>{plugin.pack.kind==='executable'?'可执行客户端代码，可修改整个界面并同步本会话。仅载入可信来源；数据保存由插件实现。':'权限：本会话状态同步；无外部网络、文件或系统访问。新版会重置共享状态。'}</p>
      <details><summary>查看完整插件包和摘要</summary><code>{plugin.digest}</code><pre>{JSON.stringify(plugin.pack,null,2)}</pre></details>
      <button className="primary-button" disabled={busy||(consent===null&&!problem)} data-enable-group-plugin onClick={()=>void choose('loaded')}>{busy?'正在保存本机选择…':problem?'重新校验并确认载入':'确认载入本机'}</button>
      <button className="secondary-button" disabled={busy||consent===null} onClick={()=>void choose('declined')}>暂不载入</button>
    </>}
  </section>
}

export function GeneratedGroupPlugin({plugin,userId,members,onError}:Props) {
  const [busy,setBusy]=useState(false)
  const [problem,setProblem]=useState('')
  const inFlight=useRef(false)
  const program=plugin.pack.artifact!.program
  const context:ProgramContext={state:plugin.state as Record<string,Value>,actor:userId,members,event:{}}
  async function send(action:string,input:Record<string,Value>) {
    if(inFlight.current)return
    inFlight.current=true;setBusy(true);setProblem('')
    try { await chatNetworkService.forPlugin(plugin.pack.id).send(plugin.groupId,'state',{action,input},{digest:plugin.digest,expectedRevision:plugin.revision}) }
    catch(e){const message=e instanceof Error?e.message:'同步失败，请等待最新状态后重试';setProblem(message);onError(message)}
    finally{inFlight.current=false;setBusy(false)}
  }
  // All view expressions share a render budget. A bad plugin cannot break the chat shell.
  try {
    const budget={n:10000}, run=(e:Value,ctx=context)=>evaluate(e,ctx,budget)
    const label=(v:Value)=>v===null?'·':typeof v==='string'||typeof v==='number'||typeof v==='boolean'?String(v).slice(0,1000):JSON.stringify(v).slice(0,1000)
    const texts=program.view.texts.map(e=>label(run(e)))
    const buttons=program.view.buttons.map(b=>({...b,allowed:run(b.enabled)===true}))
    const grids=program.view.grids.map(g=>{
      const cells=run(g.cells)
      if(!Array.isArray(cells)||cells.length>64)throw new Error('插件网格不是受限数组')
      return {...g,items:cells.map((item,index)=>{const ctx={...context,item,index};return {label:label(run(g.label,ctx)),allowed:run(g.enabled,ctx)===true}})}
    })
    return <section className="group-plugin-widget" aria-busy={busy} data-generated-plugin={plugin.pack.id}>
      <h3>{plugin.pack.displayName} <small>v{plugin.pack.version} · r{plugin.revision}</small></h3>
      {texts.map((t,i)=><p key={i}>{t}</p>)}
      {busy&&<p role="status">正在同步到群聊…</p>}
      {problem&&<p className="inline-problem" role="alert">{problem}。请查看最新状态后重试。</p>}
      <div className="draft-actions">{buttons.map((b,i)=><button key={i} disabled={busy||!b.allowed} onClick={()=>void send(b.action,{})}>{b.label}</button>)}</div>
      {grids.map((g,i)=><div key={i} className="game-board" style={{gridTemplateColumns:`repeat(${g.columns}, minmax(0, 1fr))`}}>{g.items.map((cell,index)=><button key={index} aria-label={`第 ${Math.floor(index/g.columns)+1} 行，第 ${index%g.columns+1} 列：${cell.label}`} data-game-cell={index} disabled={busy||!cell.allowed} onClick={()=>void send(g.action,{cell:index})}>{cell.label}</button>)}</div>)}
    </section>
  } catch { return <p role="alert">插件界面无法安全计算，已停止渲染。可以停用或联系作者修订；聊天不受影响。</p> }
}
