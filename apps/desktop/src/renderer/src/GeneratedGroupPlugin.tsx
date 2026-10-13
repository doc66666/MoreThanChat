import { useEffect, useState, type ReactNode } from 'react'
import { evaluate, type GroupPlugin, type ProgramContext, type Value } from '@more-than-chat/central-protocol'
import { chatNetworkService } from './plugin-host'

type Props={plugin:GroupPlugin;userId:string;members:string[];onError:(message:string)=>void}
export function GroupPluginGate({plugin,children,onError}:{plugin:GroupPlugin;children:ReactNode;onError:(s:string)=>void}) {
  const [consent,setConsent]=useState<'pending'|'loaded'|'declined'|null>(null)
  const [busy,setBusy]=useState(false)
  const [problem,setProblem]=useState('')
  const input={groupId:plugin.groupId,pluginId:plugin.pack.id,digest:plugin.digest}
  useEffect(()=>{
    let alive=true
    const refresh=()=>{void window.moreThanChat.groupPluginConsent(input).then(value=>{if(alive)setConsent(value)}).catch(e=>{if(alive){setConsent(null);setProblem(String(e.message))}})}
    refresh()
    const stop=window.moreThanChat.onGroupPluginConsentChanged(refresh)
    return()=>{alive=false;stop()}
  },[plugin.groupId,plugin.pack.id,plugin.digest])
  async function choose(decision:'loaded'|'declined') {
    setBusy(true)
    try { setConsent(await window.moreThanChat.groupPluginConsent({...input,decision}));setProblem('') }
    catch(e){onError(e instanceof Error?e.message:'本机授权保存失败')}
    finally{setBusy(false)}
  }
  return <section className="group-plugin-gate" data-group-plugin-gate={plugin.pack.id} data-consent={consent??'checking'}>
    {consent==='loaded' ? <><button className="secondary-button" disabled={busy} data-disable-group-plugin onClick={()=>void choose('declined')}>停用本机插件</button>{children}</> : <>
      <strong>{plugin.pack.displayName} · v{plugin.pack.version}</strong>
      <p>{consent==='declined'?'本机未载入，不参与此插件。':consent===null?'正在检查本机授权…':'管理员已批准。是否在此设备载入？'}</p>
      <p>权限：本群状态同步；无外部网络、文件或系统访问。更新需重新确认；新版会重置共享状态。</p>
      <details><summary>查看完整插件包和摘要</summary><code>{plugin.digest}</code><pre>{JSON.stringify(plugin.pack,null,2)}</pre></details>
      {problem&&<p role="alert">{problem}</p>}
      <button className="primary-button" disabled={busy||(consent===null&&!problem)} data-enable-group-plugin onClick={()=>void choose('loaded')}>{problem?'重新校验并确认载入':'确认载入本机'}</button>
      <button className="secondary-button" disabled={busy||consent===null} onClick={()=>void choose('declined')}>暂不载入</button>
    </>}
  </section>
}

export function GeneratedGroupPlugin({plugin,userId,members,onError}:Props) {
  const [busy,setBusy]=useState(false)
  const program=plugin.pack.artifact!.program
  const context:ProgramContext={state:plugin.state as Record<string,Value>,actor:userId,members,event:{}}
  async function send(action:string,input:Record<string,Value>) {
    if(busy)return
    setBusy(true)
    try { await chatNetworkService.forPlugin(plugin.pack.id).send(plugin.groupId,'state',{action,input},{digest:plugin.digest,expectedRevision:plugin.revision}) }
    catch(e){onError(e instanceof Error?e.message:'同步失败，请等待最新状态后重试')}
    finally{setBusy(false)}
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
    return <section className="group-plugin-widget" data-generated-plugin={plugin.pack.id}>
      <h3>{plugin.pack.displayName} <small>v{plugin.pack.version} · r{plugin.revision}</small></h3>
      {texts.map((t,i)=><p key={i}>{t}</p>)}
      <div className="draft-actions">{buttons.map((b,i)=><button key={i} disabled={busy||!b.allowed} onClick={()=>void send(b.action,{})}>{b.label}</button>)}</div>
      {grids.map((g,i)=><div key={i} className="game-board" style={{gridTemplateColumns:`repeat(${g.columns}, minmax(0, 1fr))`}}>{g.items.map((cell,index)=><button key={index} data-game-cell={index} disabled={busy||!cell.allowed} onClick={()=>void send(g.action,{cell:index})}>{cell.label}</button>)}</div>)}
    </section>
  } catch { return <p role="alert">插件界面无法安全计算，已停止渲染。可以停用或联系作者修订；聊天不受影响。</p> }
}
