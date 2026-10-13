import { useEffect, useRef, useState } from 'react'
import { Download, LockKeyhole, Upload } from 'lucide-react'
import type { HistoryTransferStatus } from './global'
import { useLiveSnapshot } from './use-live-snapshot'
import { backupPasswordIssue } from './settings-actions'

type Mode = 'export' | 'import'

export function HistorySettings() {
  const [mode,setMode]=useState<Mode|null>(null)
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('')
  const snapshot=useLiveSnapshot<HistoryTransferStatus>(()=>window.moreThanChat.getHistoryTransferStatus(),listener=>window.moreThanChat.onHistoryTransferStatus(listener))
  const status=snapshot.value
  const [working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const running=useRef(false),mounted=useRef(true)
  const busy=working||snapshot.loading||!!snapshot.error||status===null||status.busy
  const mismatch=mode==='export'&&confirmation.length>0&&password!==confirmation

  useEffect(()=>{
    mounted.current=true
    return()=>{mounted.current=false}
  },[])

  function changeMode(next:Mode|null) {
    if(busy||running.current)return
    setMode(next);setPassword('');setConfirmation('');setError('');setNotice('')
  }

  async function confirm() {
    if(busy||running.current||!mode)return
    setError('');setNotice('')
    const issue=backupPasswordIssue(password,mode==='export'?confirmation:undefined)
    if(issue){setError(issue);return}
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
    {mode&&<HistoryPasswordForm mode={mode} password={password} confirmation={confirmation} busy={busy} onPassword={value=>{setPassword(value);setError('')}} onConfirmation={value=>{setConfirmation(value);setError('')}} onConfirm={()=>void confirm()} onCancel={()=>changeMode(null)}/>}
    {(working||status?.busy)&&<p className="history-transfer-progress" role="status" aria-live="polite">{status?.stage||'正在准备聊天记录…'}<small>请勿退出应用。大文件可能需要一些时间。</small></p>}
    {snapshot.loading&&<p className="settings-note" role="status">正在读取备份状态…</p>}
    {snapshot.error&&<div className="settings-recovery"><p className="settings-error" role="alert">备份状态读取失败：{snapshot.error}</p><button type="button" className="secondary-button" disabled={working||snapshot.loading} onClick={()=>void snapshot.refresh()}>重新读取备份状态</button></div>}
    {(mismatch||error)&&<p className="settings-error" role="alert">{mismatch?'两次输入的密码不一致。':error}</p>}
    {notice&&<p className="history-transfer-result" role="status">{notice}</p>}
    <p className="settings-note history-transfer-help">换电脑时，请先导入原身份并切换到它，再恢复记录。备份密码不能重置；中心服务器已清除、且任何本机或备份中都不存在的内容无法找回。</p>
  </section>
}

export function HistoryPasswordForm({mode,password,confirmation,busy,onPassword,onConfirmation,onConfirm,onCancel}:{mode:Mode;password:string;confirmation:string;busy:boolean;onPassword:(value:string)=>void;onConfirmation:(value:string)=>void;onConfirm:()=>void;onCancel:()=>void}) {
  const mismatch=mode==='export'&&confirmation.length>0&&password!==confirmation
  return <form className="history-transfer-panel" aria-label={mode==='export'?'设置聊天备份密码':'解锁聊天备份'} onSubmit={event=>{event.preventDefault();onConfirm()}} onKeyDown={event=>{
    if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault()
  }}>
    <h4><LockKeyhole size={15}/>{mode==='export'?'设置备份密码':'输入备份密码'}</h4>
    <label className="settings-field"><span>密码（12–256 个字符）</span><input data-history-password type="password" maxLength={256} autoComplete={mode==='export'?'new-password':'off'} value={password} disabled={busy} aria-invalid={mismatch} onChange={event=>onPassword(event.target.value)}/></label>
    {mode==='export'&&<label className="settings-field"><span>再次输入密码</span><input data-history-confirm-password type="password" maxLength={256} autoComplete="new-password" value={confirmation} disabled={busy} aria-invalid={mismatch} onChange={event=>onConfirmation(event.target.value)}/></label>}
    <p className="settings-note">{mode==='export'?'密码不能重置。若本机引用的附件缺失或损坏，备份会中止，原数据不受影响。':'选择文件后会先验证身份和内容，再请你确认合并。已有数据保留，不新增关系、不重发旧消息。'}</p>
    <div className="history-transfer-actions">
      <button type="submit" className="primary-button" data-history-action="confirm" disabled={busy||!!backupPasswordIssue(password,mode==='export'?confirmation:undefined)}>{mode==='export'?'加密并保存文件':'选择备份文件'}</button>
      <button type="button" className="secondary-button" data-history-action="cancel" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </form>
}
