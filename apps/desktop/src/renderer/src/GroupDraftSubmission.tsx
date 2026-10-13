import { useState } from 'react'
import { UI_SLOTS, type ServerSnapshot, type UiSlot } from '@more-than-chat/central-protocol'
import type { PluginDraftSummary } from '@more-than-chat/protocol'

export function GroupDraftSubmission({draft,snapshot}:{draft:PluginDraftSummary;snapshot:ServerSnapshot|null}) {
  const [groupId,setGroupId]=useState(''),[slot,setSlot]=useState<UiSlot>('chat.details')
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const groups=snapshot?.directory?.groups??[],group=groups.find(g=>g.id===groupId)
  async function submit() {
    if(!snapshot?.serverId||!group)return
    setBusy(true)
    try {
      await window.moreThanChat.submitGroupDraft({serverId:snapshot.serverId,groupId,draftId:draft.id,revision:draft.revision,slot,confirmed:true})
      setMessage('申请已提交，等待群管理员审批；批准后每位成员仍需确认本机载入。');setConfirm(false)
    }catch(e){setMessage(e instanceof Error?e.message:'提交失败')}
    finally{setBusy(false)}
  }
  const previous=snapshot?.directory?.plugins.filter(p=>p.submittedBy===snapshot.userId&&p.pack.artifact?.manifest.id===draft.id)??[]
  return <div className="group-draft-submit">
    <p>群插件草稿 · 仅在本群使用 chat.network，不执行任意 JS。</p>
    <label>提交到群聊<select data-draft-group value={groupId} disabled={busy||confirm} onChange={e=>setGroupId(e.target.value)}><option value="">请选择群聊</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name} · {g.id.slice(-8)}</option>)}</select></label>
    <label>显示位置<select value={slot} disabled={busy||confirm} onChange={e=>setSlot(e.target.value as UiSlot)}>{UI_SLOTS.map(s=><option key={s}>{s}</option>)}</select></label>
    {confirm?<div className="draft-confirm"><p>确认将「{draft.displayName}」r{draft.revision} 提交到「{group?.name}」供管理员审阅？这不会自动载入。若是更新，批准后重置共享状态，成员需重新确认。</p><button disabled={busy} onClick={()=>setConfirm(false)}>取消</button><button data-confirm-submit-group-draft disabled={busy||!group||snapshot?.status!=='connected'} onClick={()=>void submit()}>确认提交申请</button></div>:<button data-submit-group-draft disabled={!draft.ok||!group||snapshot?.status!=='connected'||busy} onClick={()=>setConfirm(true)}>申请加入群聊</button>}
    {message&&<p role="status">{message}</p>}
    {previous.map(p=><p key={p.groupId+p.pack.version}>{groups.find(g=>g.id===p.groupId)?.name} · v{p.pack.version} · {{pending:'待管理员审批',approved:'已批准，成员自行载入',rejected:'已拒绝，可修订后再次申请',superseded:'已被新版替代'}[p.status]}</p>)}
  </div>
}
