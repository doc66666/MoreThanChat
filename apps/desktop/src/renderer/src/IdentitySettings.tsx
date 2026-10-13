import { useState } from 'react'

export function IdentitySettings({connected}:{connected:boolean}) {
  const [mode,setMode]=useState<'backup'|'restore'|null>(null)
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('')
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('')
  const [profiles,setProfiles]=useState<Awaited<ReturnType<Window['moreThanChat']['getIdentityProfiles']>>|null>(null)
  const [devices,setDevices]=useState<Awaited<ReturnType<Window['moreThanChat']['getDevices']>>|null>(null)
  async function run(work:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await work()}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}}
  function changeMode(next:typeof mode){setMode(next);setPassword('');setConfirmation('');setError('');setNotice('')}
  return <section className="identity-settings" aria-label="身份与设备">
    <h3>身份与设备</h3>
    <p className="settings-note">备份你的身份，在其他电脑上继续使用同一个全局 ID。密码无法找回，请与备份分开保管。</p>
    <div className="network-buttons">
      <button className="secondary-button" disabled={busy} onClick={()=>changeMode('backup')}>备份身份</button>
      <button className="secondary-button" disabled={busy} onClick={()=>changeMode('restore')}>导入身份</button>
      <button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>setProfiles(await window.moreThanChat.getIdentityProfiles()))}>本机身份</button>
    </div>
    {mode&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{
      if(mode==='backup'){
        if(password!==confirmation)throw new Error('两次输入的密码不一致')
        if(await window.moreThanChat.backupIdentity(password)){changeMode(null);setNotice('加密身份备份已保存。它不包含聊天记录、插件或 API 密钥。')}
      }else{
        const result=await window.moreThanChat.restoreIdentity(password)
        if(result){changeMode(null);setProfiles(await window.moreThanChat.getIdentityProfiles());setNotice('身份已导入。选择下方身份即可重启切换，当前数据会保留。')}
      }
    })}}>
      <label className="settings-field"><span>{mode==='backup'?'设置备份密码（至少 12 个字符）':'备份密码'}</span><input aria-label="备份密码" type="password" minLength={12} maxLength={256} required autoComplete={mode==='backup'?'new-password':'off'} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
      {mode==='backup'&&<label className="settings-field"><span>再次输入密码</span><input aria-label="确认备份密码" type="password" minLength={12} maxLength={256} required autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} disabled={busy}/></label>}
      <p className="settings-note">只备份身份凭据。导入后使用独立空间，好友和群在连接原服务器后恢复；已送达旧设备的历史不会自动下载。</p>
      <div className="network-buttons"><button type="submit" className="primary-button" disabled={busy}>{busy?'处理中…':mode==='backup'?'加密并保存文件':'选择备份文件'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>changeMode(null)}>取消</button></div>
    </form>}
    {profiles?.profiles.map(p=><div className="contact-row" key={p.id}><span><small>{p.userId}</small></span><button disabled={busy||p.id===profiles.current} onClick={()=>void run(()=>window.moreThanChat.switchIdentity(p.id))}>{p.id===profiles.current?'当前身份':'切换'}</button></div>)}
    <div className="network-buttons"><button className="secondary-button" disabled={busy||!connected} onClick={()=>void run(async()=>setDevices(await window.moreThanChat.getDevices()))}>查看本服设备</button></div>
    <p className="settings-note">已登记设备分别收取新消息，离线后会补投。移除不用的设备可释放等待它接收的暂存消息。</p>
    {devices?.map(d=><div className="contact-row" key={d.id}><span>{d.name}{d.current?' · 此设备':''}<small>{d.id.slice(-8)} · 最近连接 {new Date(d.lastSeen).toLocaleString()}</small></span>{!d.current&&<button disabled={busy||!connected} onClick={()=>void run(async()=>{await window.moreThanChat.removeDevice(d.id);setDevices(await window.moreThanChat.getDevices())})}>移除</button>}</div>)}
    {notice&&<p className="settings-note" role="status">{notice}</p>}{error&&<p className="settings-error" role="alert">{error}</p>}
  </section>
}
