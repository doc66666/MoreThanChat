import { useEffect, useState } from 'react'
import type { Directory, Group } from '@more-than-chat/central-protocol'
export function GroupManager({group,directory,userId}:{group:Group;directory:Directory;userId:string}) {
  const [name,setName]=useState(group.name),[invite,setInvite]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [confirmation,setConfirmation]=useState<{route:string;data:unknown;label:string}|null>(null)
  const owner=group.ownerId===userId
  useEffect(()=>setName(group.name),[group.name])
  const action=async(route:string,data:unknown)=>{
    setBusy(true);setError('')
    try{await window.moreThanChat.serverAction(route,data);setConfirmation(null)}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}
  }
  const confirm=(route:string,label:string,memberId?:string)=>setConfirmation({route,data:{groupId:group.id,...(memberId?{userId:memberId}:{})},label})
  return <details className="group-manager" data-group-management>
    <summary>群成员与管理 · {group.members.length} 人</summary>
    <p className="identity-id">群 ID：<code>{group.id}</code></p>
    {error&&<p className="settings-error">{error}</p>}
    {group.members.map(member=><div className="group-member" key={member.id} data-group-member={member.id}>
      <div><strong>{member.displayName}{member.id===userId?'（我）':''}</strong><small>{member.id===group.ownerId?'管理员':member.online?'在线':'离线'}</small></div>
      {owner&&member.id!==userId&&<div className="member-actions"><button disabled={busy} data-transfer-owner={member.id} onClick={()=>confirm('groups/transfer','将管理员转让给 '+member.displayName,member.id)}>转让</button><button disabled={busy} data-remove-member={member.id} onClick={()=>confirm('groups/kick','移出成员 '+member.displayName,member.id)}>移出</button></div>}
    </div>)}
    {owner&&<>
      <label className="settings-field"><span>群名称</span><input data-rename-group-field maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
      <button className="secondary-button" data-rename-group disabled={busy||!name.trim()||name===group.name} onClick={()=>void action('groups/rename',{groupId:group.id,name:name.trim()})}>修改群名称</button>
      <label className="settings-field"><span>邀请好友</span><select data-invite-group value={invite} onChange={e=>setInvite(e.target.value)}><option value="">选择本服好友</option>{directory.friends.filter(friend=>!group.members.some(m=>m.id===friend.id)).map(friend=><option key={friend.id} value={friend.id}>{friend.displayName}</option>)}</select></label>
      <button className="secondary-button" data-invite-group-confirm disabled={busy||!invite} onClick={()=>void action('groups/invite',{groupId:group.id,userId:invite})}>邀请加入群聊</button>
    </>}
    <button className="secondary-button danger-text" disabled={busy} data-leave-group={!owner?'true':undefined} data-dissolve-group={owner?'true':undefined} onClick={()=>confirm(owner?'groups/dissolve':'groups/leave',owner?'解散 '+group.name:'退出 '+group.name)}>{owner?'解散群聊':'退出群聊'}</button>
    {confirmation&&<div className="danger-confirm"><p>确认{confirmation.label}？</p><small>已接收的聊天记录会保留在各自设备上。</small><div><button className="secondary-button" disabled={busy} onClick={()=>setConfirmation(null)}>取消</button><button className="primary-button" data-confirm-group-action disabled={busy} onClick={()=>void action(confirmation.route,confirmation.data)}>确认</button></div></div>}
  </details>
}
