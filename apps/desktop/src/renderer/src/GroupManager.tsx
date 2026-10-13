import { useEffect, useRef, useState } from 'react'
import type { Directory, Group } from '@more-than-chat/central-protocol'
export function GroupManager({group,directory,userId,connected}:{group:Group;directory:Directory;userId:string;connected:boolean}) {
  const [name,setName]=useState(group.name),[invite,setInvite]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [confirmation,setConfirmation]=useState<{route:string;data:unknown;label:string}|null>(null)
  const [notice,setNotice]=useState('')
  const inFlight=useRef(false),disabled=busy||!connected
  const available=directory.friends.filter(friend=>!group.members.some(m=>m.id===friend.id))
  const selectedInvite=available.some(friend=>friend.id===invite)?invite:''
  const owner=group.ownerId===userId
  useEffect(()=>setName(group.name),[group.name])
  useEffect(()=>setConfirmation(null),[group.ownerId])
  const action=async(route:string,data:unknown,success='操作已完成')=>{
    if(inFlight.current)return
    if(!connected){setError('请连接此群所在的服务器后再操作。');return}
    inFlight.current=true;setBusy(true);setError('');setNotice('')
    try{await window.moreThanChat.serverAction(route,data);setConfirmation(null);setNotice(success);if(route==='groups/invite')setInvite('')}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{inFlight.current=false;setBusy(false)}
  }
  const confirm=(route:string,label:string,memberId?:string)=>setConfirmation({route,data:{groupId:group.id,...(memberId?{userId:memberId}:{})},label})
  return <details className="group-manager" data-group-management>
    <summary>群成员与管理 · {group.members.length} 人</summary>
    <p className="identity-id">群 ID：<code>{group.id}</code></p>
    {!connected&&<p className="settings-note">当前离线，群成员信息可能不是最新。连接服务器后才能进行管理操作。</p>}
    {error&&<p className="settings-error" role="alert">{error}</p>}
    {(busy||notice)&&<p className="settings-note" role="status">{busy?'正在处理…':notice}</p>}
    {group.members.map(member=><div className="group-member" key={member.id} data-group-member={member.id}>
      <div><strong>{member.displayName}{member.id===userId?'（我）':''}</strong><small>{member.id===group.ownerId?'管理员':member.online?'在线':'离线'}</small></div>
      {owner&&member.id!==userId&&<div className="member-actions"><button disabled={disabled} data-transfer-owner={member.id} onClick={()=>confirm('groups/transfer','将管理员转让给 '+member.displayName,member.id)}>转让</button><button disabled={disabled} data-remove-member={member.id} onClick={()=>confirm('groups/kick','移出成员 '+member.displayName,member.id)}>移出</button></div>}
    </div>)}
    {owner&&<>
      <label className="settings-field"><span>群名称</span><input data-rename-group-field disabled={disabled} maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
      <button className="secondary-button" data-rename-group disabled={disabled||!name.trim()||name.trim()===group.name} onClick={()=>void action('groups/rename',{groupId:group.id,name:name.trim()},'群名称已更新')}>修改群名称</button>
      <label className="settings-field"><span>邀请好友</span><select data-invite-group disabled={disabled||group.members.length>=20} value={selectedInvite} onChange={e=>setInvite(e.target.value)}><option value="">选择本服好友</option>{available.map(friend=><option key={friend.id} value={friend.id}>{friend.displayName}</option>)}</select></label>
      <button className="secondary-button" data-invite-group-confirm disabled={disabled||!selectedInvite||group.members.length>=20} onClick={()=>void action('groups/invite',{groupId:group.id,userId:selectedInvite},'好友已加入群聊')}>邀请加入群聊</button>
      {(group.members.length>=20||!available.length)&&<p className="settings-note">{group.members.length>=20?'群成员已达 20 人上限。':'没有可邀请的本服好友，已有好友都在群内，或尚未添加好友。'}</p>}
    </>}
    <button className="secondary-button danger-text" disabled={disabled} data-leave-group={!owner?'true':undefined} data-dissolve-group={owner?'true':undefined} onClick={()=>confirm(owner?'groups/dissolve':'groups/leave',owner?'解散 '+group.name:'退出 '+group.name)}>{owner?'解散群聊':'退出群聊'}</button>
    {confirmation&&<div className="danger-confirm"><p>确认{confirmation.label}？</p><small>{confirmation.route==='groups/transfer'?'转让后你将失去群管理和插件审批权限。':confirmation.route==='groups/dissolve'?'解散后所有成员都无法继续在此群聊天。':'此操作会改变群成员关系。'}已接收的聊天记录会保留在各自设备上。</small><div><button className="secondary-button" disabled={busy} onClick={()=>setConfirmation(null)}>取消</button><button className="primary-button" data-confirm-group-action disabled={disabled} onClick={()=>void action(confirmation.route,confirmation.data)}>确认</button></div></div>}
  </details>
}
