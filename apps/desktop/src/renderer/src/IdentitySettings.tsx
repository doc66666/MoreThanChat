import { useRef, useState } from 'react'
import { backupPasswordIssue, refreshAfterCompletedAction } from './settings-actions'

export function IdentitySettings({connected}:{connected:boolean}) {
  const [mode,setMode]=useState<'backup'|'restore'|null>(null)
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('')
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('')
  const [profiles,setProfiles]=useState<Awaited<ReturnType<Window['moreThanChat']['getIdentityProfiles']>>|null>(null)
  const [devices,setDevices]=useState<Awaited<ReturnType<Window['moreThanChat']['getDevices']>>|null>(null)
  const running=useRef(false)
  const mismatch=mode==='backup'&&confirmation.length>0&&password!==confirmation
  async function run(work:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');setNotice('');try{await work()}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{running.current=false;setBusy(false)}}
  function changeMode(next:typeof mode){setMode(next);setPassword('');setConfirmation('');setError('');setNotice('')}
  return <section className="identity-settings" aria-label="身份与设备">
    <h3>身份与设备</h3>
    <p className="settings-note">备份你的身份，在其他电脑上继续使用同一个全局 ID。密码无法找回，请与备份分开保管。</p>
    <div className="network-buttons">
      <button className="secondary-button" disabled={busy} onClick={()=>changeMode('backup')}>备份身份</button>
      <button className="secondary-button" disabled={busy} onClick={()=>changeMode('restore')}>导入身份</button>
      <button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>setProfiles(await window.moreThanChat.getIdentityProfiles()))}>本机身份</button>
    </div>
    {mode&&<form onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault()}} onSubmit={e=>{e.preventDefault();void run(async()=>{
      const issue=backupPasswordIssue(password,mode==='backup'?confirmation:undefined)
      if(issue)throw new Error(issue)
      if(mode==='backup'){
        const saved=await window.moreThanChat.backupIdentity(password)
        changeMode(null);setNotice(saved?'加密身份备份已保存。它不包含聊天记录、插件或 API 密钥。':'已取消保存，当前身份不变。')
      }else{
        const result=await window.moreThanChat.restoreIdentity(password)
        changeMode(null)
        if(!result){setNotice('已取消导入，当前身份不变。');return}
        setNotice('身份已导入。选择下方身份即可重启切换，当前数据会保留。')
        const refreshed=await refreshAfterCompletedAction(()=>window.moreThanChat.getIdentityProfiles())
        if(refreshed.value)setProfiles(refreshed.value)
        if(refreshed.refreshFailed)setError('身份已导入，但列表刷新失败；无需重新导入，请点击「本机身份」重试。')
      }
    })}}>
      <label className="settings-field"><span>{mode==='backup'?'设置备份密码（至少 12 个字符）':'备份密码'}</span><input aria-label="备份密码" type="password" minLength={12} maxLength={256} required autoComplete={mode==='backup'?'new-password':'off'} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
      {mode==='backup'&&<label className="settings-field"><span>再次输入密码</span><input aria-label="确认备份密码" type="password" minLength={12} maxLength={256} required autoComplete="new-password" value={confirmation} aria-invalid={mismatch} onChange={e=>setConfirmation(e.target.value)} disabled={busy}/></label>}
      {mismatch&&<p className="settings-error" role="alert">两次输入的密码不一致。</p>}
      <p className="settings-note">只备份身份凭据。导入后使用独立空间，好友和群在连接原服务器后恢复；已送达旧设备的历史不会自动下载。</p>
      <div className="network-buttons"><button type="submit" className="primary-button" disabled={busy||!!backupPasswordIssue(password,mode==='backup'?confirmation:undefined)}>{busy?'处理中…':mode==='backup'?'加密并保存文件':'选择备份文件'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>changeMode(null)}>取消</button></div>
    </form>}
    {profiles?.profiles.map(p=><div className="contact-row" key={p.id}><span><small>{p.userId}</small></span><button disabled={busy||p.id===profiles.current} onClick={()=>void run(async()=>{
      const result=await window.moreThanChat.switchIdentity(p.id)
      setNotice(result==='cancelled'?'已取消切换，仍使用当前身份。':result==='unchanged'?'已在使用此身份。':'已请求切换，等待保存当前数据并重启。')
    })}>{p.id===profiles.current?'当前身份':'切换'}</button></div>)}
    <div className="network-buttons"><button className="secondary-button" disabled={busy||!connected} onClick={()=>void run(async()=>setDevices(await window.moreThanChat.getDevices()))}>查看本服设备</button></div>
    <p className="settings-note">已登记设备分别收取新消息，离线后会补投。移除设备会清除仅等待它接收的消息，但不会删除它已有的本地记录，也不会吊销身份密钥。</p>
    {!connected&&<p className="settings-note">连接原中心服务器后可查看和管理设备；身份备份不需要联网。</p>}
    {devices?.length===0&&<p className="settings-note">未查到已登记设备，可重新读取列表。</p>}
    {devices?.map(d=><div className="contact-row" key={d.id}><span>{d.name}{d.current?' · 此设备':''}<small>{d.id.slice(-8)} · 最近连接 {new Date(d.lastSeen).toLocaleString()}</small></span>{!d.current&&<button disabled={busy||!connected} onClick={()=>void run(async()=>{
      const result=await window.moreThanChat.removeDevice(d.id)
      if(result==='cancelled'){setNotice('已取消移除，设备保持不变。');return}
      setDevices(current=>current?.filter(device=>device.id!==d.id)??null);setNotice('设备已移除。其他设备的收件不受影响。')
      const refreshed=await refreshAfterCompletedAction(()=>window.moreThanChat.getDevices())
      if(refreshed.value)setDevices(refreshed.value)
      if(refreshed.refreshFailed)setError('设备已移除，但列表刷新失败，请点击「查看本服设备」重试。')
    })}>移除</button>}</div>)}
    {busy&&<p className="settings-note" role="status">正在处理身份或设备操作，请稍候…</p>}
    {notice&&<p className="settings-note" role="status">{notice}</p>}{error&&<p className="settings-error" role="alert">{error}</p>}
  </section>
}
