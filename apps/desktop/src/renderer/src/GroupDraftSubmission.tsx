import { useRef, useState } from 'react'
import { UI_SLOTS, type ServerSnapshot, type UiSlot } from '@more-than-chat/central-protocol'
import type { PluginDraftSummary } from '@more-than-chat/protocol'
import { slotLabels, submissionIssue } from './group-plugin-presentation'

export function GroupDraftSubmission({draft,snapshot}:{draft:PluginDraftSummary;snapshot:ServerSnapshot|null}) {
  const [groupId,setGroupId]=useState(''),[slot,setSlot]=useState<UiSlot>('chat.details')
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false)
  const [result,setResult]=useState<{error:boolean;text:string}|null>(null)
  const [submitted,setSubmitted]=useState<string[]>([])
  const inFlight=useRef(false)
  const groups=snapshot?.directory?.groups??[],group=groups.find(g=>g.id===groupId)
  const issue=submissionIssue(draft,snapshot,groupId)??(submitted.includes(groupId)?'此版本已提交到该群，无需重复申请；请在下方查看审批状态。':null)
  async function submit() {
    if(inFlight.current||issue||!snapshot?.serverId||!group)return
    inFlight.current=true;setBusy(true);setResult(null)
    try {
      await window.moreThanChat.submitGroupDraft({serverId:snapshot.serverId,groupId,draftId:draft.id,revision:draft.revision,slot,confirmed:true})
      setSubmitted(current=>[...current,groupId])
      setResult({error:false,text:'申请已提交。管理员批准后，每位成员仍需自行确认本机载入。'});setConfirm(false)
    }catch(e){setResult({error:true,text:e instanceof Error?e.message:'提交失败，请重试。'})}
    finally{inFlight.current=false;setBusy(false)}
  }
  const previous=(snapshot?.directory?.plugins.filter(p=>p.submittedBy===snapshot.userId&&p.pack.artifact?.manifest.id===draft.id)??[]).sort((a,b)=>b.pack.version-a.pack.version)
  return <div className="group-draft-submit" aria-busy={busy}>
    <ol className="plugin-workflow" aria-label="群插件使用流程"><li>提交申请</li><li>管理员审批</li><li>成员自主载入</li></ol>
    <p>群插件只通过 chat.network 同步本群状态，不执行任意 JavaScript。提交不会自动安装到成员设备。</p>
    <label>提交到群聊<select data-draft-group value={groupId} disabled={busy||confirm} onChange={e=>{setGroupId(e.target.value);setResult(null)}}><option value="">请选择群聊</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name} · {g.id.slice(-8)}</option>)}</select></label>
    <label>显示位置<select data-draft-slot value={slot} disabled={busy||confirm} onChange={e=>setSlot(e.target.value as UiSlot)}>{UI_SLOTS.map(s=><option key={s} value={s}>{slotLabels[s]}</option>)}</select></label>
    <p>不仅限于侧边栏：可选择上方列出的各个界面位置。插件只在所属群打开时显示，不能覆盖内核和授权控件。</p>
    {slot==='app.rail'&&<p>导航栏显示可展开的群插件入口，完整面板在旁边打开，不挤占导航按钮。</p>}
    {slot==='app.overlay'&&<p>浮层可以收起；收起只隐藏面板，不等于停用或退出对局。</p>}
    {(slot==='chat.message.before'||slot==='chat.message.after')&&<p>此位置会在每条消息旁重复显示。小游戏和接龙建议放在「聊天详情侧栏」。</p>}
    {issue&&<p className="settings-note" role="status">{issue}</p>}
    {confirm?<div className="draft-confirm"><p>将「{draft.displayName}」草稿 r{draft.revision} 提交到「{group?.name??'该群已不可用'}」的「{slotLabels[slot]}」？</p><p>若是更新，批准后会重置共享状态，成员需重新确认载入。</p><div className="draft-actions"><button disabled={busy} onClick={()=>{setConfirm(false);setResult(null)}}>返回修改</button><button className="primary-button" data-confirm-submit-group-draft disabled={busy||!!issue} onClick={()=>void submit()}>{busy?'正在提交…':'确认提交申请'}</button></div></div>:<button className="primary-button" data-submit-group-draft disabled={!!issue||busy} onClick={()=>{setResult(null);setConfirm(true)}}>申请加入群聊</button>}
    {result&&<p className={result.error?'inline-problem':'inline-success'} role={result.error?'alert':'status'}>{result.text}</p>}
    {previous.length>0&&<details className="plugin-submission-history"><summary>申请记录（{previous.length}）</summary>{previous.map(p=><p key={`${p.groupId}:${p.pack.id}:${p.pack.version}`}>{groups.find(g=>g.id===p.groupId)?.name??'已离开的群'} · v{p.pack.version} · {{pending:'待管理员审批',approved:'已批准，成员自行载入',rejected:'已拒绝，可修订后再次申请',superseded:'已被新版替代'}[p.status]}</p>)}</details>}
  </div>
}
