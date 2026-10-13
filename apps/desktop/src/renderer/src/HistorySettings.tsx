import { useEffect, useRef, useState } from 'react'
import { Download, LockKeyhole, Upload } from 'lucide-react'
import type { HistoryTransferStatus } from './global'

type Mode = 'export' | 'import'

export function HistorySettings() {
  const [mode,setMode]=useState<Mode|null>(null)
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('')
  const [status,setStatus]=useState<HistoryTransferStatus|null>(null)
  const [working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const running=useRef(false),mounted=useRef(true)
  const busy=working||status===null||status.busy
  const mismatch=mode==='export'&&confirmation.length>0&&password!==confirmation

  useEffect(()=>{
    mounted.current=true
    let changed=false
    const stop=window.moreThanChat.onHistoryTransferStatus(value=>{
      changed=true
      if(mounted.current)setStatus(value)
    })
    void window.moreThanChat.getHistoryTransferStatus().then(value=>{
      if(mounted.current&&!changed)setStatus(value)
    }).catch(()=>{
      if(mounted.current)setError('暂时无法读取备份状态，请关闭设置后重试。')
    })
    return()=>{mounted.current=false;stop()}
  },[])

  function changeMode(next:Mode|null) {
    if(busy||running.current)return
    setMode(next);setPassword('');setConfirmation('');setError('');setNotice('')
  }

  async function confirm() {
    if(busy||running.current||!mode)return
    setError('');setNotice('')
    if(password.length<12||password.length>256||!password.trim()){
      setError('备份密码需要 12–256 个字符。');return
    }
    if(mode==='export'&&password!==confirmation){setError('两次输入的密码不一致。');return}
    running.current=true;setWorking(true)
    try {
      const result=mode==='export'
        ? await window.moreThanChat.exportChatHistory(password)
        : await window.moreThanChat.importChatHistory(password)
      if(!mounted.current)return
      setPassword('');setConfirmation('');setMode(null)
      if(!result){setNotice('已取消操作，当前聊天记录保持不变。');return}
      if('messagesAdded' in result){
        setNotice(`恢复完成：新增 ${result.conversationsAdded} 个历史会话、${result.messagesAdded} 条消息，跳过 ${result.messagesSkipped} 条已有消息，应用 ${result.retractionsApplied} 条撤回记录，恢复 ${result.attachments} 个附件。当前数据已保留，不会新增好友或群关系，也不会重发旧消息。`)
      }else{
        setNotice(`加密备份已保存：${result.conversations} 个会话、${result.messages} 条消息、${result.attachments} 个附件。请将密码与备份文件分开妥善保管。`)
      }
      if(result.cleanupWarning)setNotice(previous=>previous+' 注意：操作已成功，但本身份目录内部分临时数据未能清理；请妥善保护本机数据目录。')
    } catch(caught) {
      if(mounted.current)setError(caught instanceof Error?caught.message:'聊天记录操作未完成，请稍后重试。')
    } finally {
      running.current=false
      if(mounted.current)setWorking(false)
    }
  }

  return <section className="history-settings" data-history-transfer aria-labelledby="history-settings-heading" aria-busy={working||status?.busy||false}>
    <div className="settings-section-heading"><h3 id="history-settings-heading">聊天记录与迁移</h3><span>加密保存，仅在本机恢复</span></div>
    <p className="settings-note">备份本身份在这台电脑上的全部聊天记录和附件，不包含身份私钥、API 密钥、插件或草稿。</p>
    <div className="history-transfer-actions">
      <button type="button" className="secondary-button" data-history-action="export" disabled={busy} onClick={()=>changeMode('export')}><Download size={14}/>备份聊天记录</button>
      <button type="button" className="secondary-button" data-history-action="import" disabled={busy} onClick={()=>changeMode('import')}><Upload size={14}/>恢复聊天记录</button>
    </div>
    {mode&&<div className="history-transfer-panel" role="group" aria-label={mode==='export'?'设置聊天备份密码':'解锁聊天备份'} onKeyDown={event=>{
      if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();void confirm()}
    }}>
      <h4><LockKeyhole size={15}/>{mode==='export'?'设置备份密码':'输入备份密码'}</h4>
      <label className="settings-field"><span>密码（12–256 个字符）</span><input data-history-password type="password" maxLength={256} autoComplete={mode==='export'?'new-password':'off'} value={password} disabled={busy} aria-invalid={Boolean(mismatch)} onChange={event=>{setPassword(event.target.value);setError('')}}/></label>
      {mode==='export'&&<label className="settings-field"><span>再次输入密码</span><input data-history-confirm-password type="password" maxLength={256} autoComplete="new-password" value={confirmation} disabled={busy} aria-invalid={mismatch} onChange={event=>{setConfirmation(event.target.value);setError('')}}/></label>}
      <p className="settings-note">{mode==='export'?'密码不能重置。若本机引用的附件缺失或损坏，备份会中止，原数据不受影响。':'选择文件后会先验证身份和内容，再请你确认合并。已有数据保留，不新增关系、不重发旧消息。'}</p>
      <div className="history-transfer-actions">
        <button type="button" className="primary-button" data-history-action="confirm" disabled={busy||mismatch} onClick={()=>void confirm()}>{mode==='export'?'加密并保存文件':'选择备份文件'}</button>
        <button type="button" className="secondary-button" data-history-action="cancel" disabled={busy} onClick={()=>changeMode(null)}>取消</button>
      </div>
    </div>}
    {(working||status?.busy)&&<p className="history-transfer-progress" role="status" aria-live="polite">{status?.stage||'正在准备聊天记录…'}<small>请勿退出应用。大文件可能需要一些时间。</small></p>}
    {!status&&!error&&<p className="settings-note" role="status">正在读取备份状态…</p>}
    {(mismatch||error)&&<p className="settings-error" role="alert">{mismatch?'两次输入的密码不一致。':error}</p>}
    {notice&&<p className="history-transfer-result" role="status">{notice}</p>}
    <p className="settings-note history-transfer-help">换电脑时，请先导入原身份并切换到它，再恢复记录。备份密码不能重置；中心服务器已清除、且任何本机或备份中都不存在的内容无法找回。</p>
  </section>
}
