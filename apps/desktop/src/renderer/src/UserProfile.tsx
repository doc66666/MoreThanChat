import { appApi } from './app-api'
import { useEffect, useRef, useState } from 'react'
import { Copy, MessageCircleMore, PencilLine, Users, X } from 'lucide-react'
import { MAX_PROFILE_BIO, type Member, type ServerSnapshot } from '@more-than-chat/central-protocol'
import { useDialogFocus } from './use-dialog-focus'
import { avatarTone } from './conversation-presentation'
import { directoryMembers, memberRelationship, nameInitials, sharedGroups } from './user-directory'

export interface ProfileTarget { serverId: string | null; user: Member }
export function UserProfile({ target, snapshot, onClose, onChat, onSettings }: {
  target: ProfileTarget; snapshot: ServerSnapshot | null; onClose: () => void
  onChat: (targetId: string) => void; onSettings: () => void
}) {
  const dialog = useDialogFocus()
  const current = snapshot?.serverId === target.serverId
  const directory = current ? snapshot?.directory : null
  const member = directoryMembers(directory).get(target.user.id) ?? target.user
  const self = member.id === snapshot?.userId
  const connected = current && snapshot?.status === 'connected' && !!target.serverId
  const relation = memberRelationship(directory, member.id)
  const groups = sharedGroups(directory, member.id)
  const [editing, setEditing] = useState(false), [name, setName] = useState(member.displayName)
  const [bio, setBio] = useState(member.bio ?? ''), [color, setColor] = useState<number | null>(member.avatarColor ?? null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState(false)
  const running = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!editing) { setName(member.displayName); setBio(member.bio ?? ''); setColor(member.avatarColor ?? null) }
  }, [member.displayName, member.bio, member.avatarColor, editing])
  async function run(action: () => Promise<unknown>, success: string) {
    if (running.current) return false
    running.current = true; setBusy(true); setError(''); setNotice('')
    try { await action(); if (mounted.current) setNotice(success); return true }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '操作未完成，请重试'); return false }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  const act = (route: string, success: string) => run(() => appApi.serverAction(route, { userId: member.id }, target.serverId!), success)
  function close() { if (!running.current) onClose() }
  return <div className="drawer-backdrop profile-backdrop" onMouseDown={close} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (editing && !running.current) setEditing(false); else close() }
  }}>
    <aside className="plugin-drawer user-profile" role="dialog" aria-modal="true" aria-label={self ? '我的主页' : `${member.displayName}的主页`} ref={dialog} tabIndex={-1} onMouseDown={event => event.stopPropagation()} data-user-profile={member.id}>
      <div className="profile-cover" data-avatar-tone={editing ? color ?? avatarTone(member.id) : member.avatarColor ?? avatarTone(member.id)}>
        <span>{self ? '我的主页' : '个人主页'}</span>
        <button className="icon-button" aria-label="关闭个人主页" onClick={close} disabled={busy}><X size={19}/></button>
      </div>
      <div className="profile-body">
        <div className="profile-hero">
          <span className="person-avatar profile-large" data-avatar-tone={editing ? color ?? avatarTone(member.id) : member.avatarColor ?? avatarTone(member.id)}>{nameInitials(editing ? name : member.displayName)}</span>
          <div><h2>{editing ? name || '你的昵称' : member.displayName}</h2><p><span className="status-dot" data-connected={connected && member.online}/>{!connected ? '当前未连接此服务器' : member.online ? '在线' : '离线'} · {self ? '你自己' : relation === 'friend' ? '你的好友' : '本服用户'}</p></div>
        </div>
        {!editing && <p className={`profile-bio ${member.bio ? '' : 'muted'}`}>{member.bio || (self ? '写一句签名，让朋友更了解你。' : '还没有填写个人签名。')}</p>}
        {(notice || error) && <p className={error ? 'settings-error' : 'network-notice'} role={error ? 'alert' : 'status'}>{error || notice}</p>}
        {self && editing ? <form className="profile-editor" onSubmit={event => {
          event.preventDefault()
          if (!connected || !name.trim()) return
          void run(() => appApi.updateUserProfile(target.serverId!, { displayName: name.trim(), bio, avatarColor: color }), '个人资料已保存，同服好友和群成员会同步看到').then(ok => { if (ok && mounted.current) setEditing(false) })
        }}>
          <label className="settings-field"><span>昵称</span><input data-profile-name maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} autoComplete="off" required/></label>
          <label className="settings-field"><span>个人签名 <small>{bio.length}/{MAX_PROFILE_BIO}</small></span><textarea data-profile-bio maxLength={MAX_PROFILE_BIO} value={bio} rows={3} disabled={busy} onChange={event => setBio(event.target.value)} placeholder="最近在做什么，或者你喜欢的一句话"/></label>
          <fieldset className="profile-colors" disabled={busy}><legend>头像配色</legend>{[0,1,2,3,4].map((tone, i) => <button type="button" key={tone} data-avatar-tone={tone} data-profile-color={tone} aria-pressed={color === tone} aria-label={['朱砂','雾蓝','暖棕','灰紫','麦金'][i]} onClick={() => setColor(tone)}><span/></button>)}<button type="button" className="profile-color-auto" aria-pressed={color === null} onClick={() => setColor(null)}>自动</button></fieldset>
          <p className="settings-note">资料保存在当前中心服务器。切换到其他服务器后，可以使用另一套资料。</p>
          <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(false)}>取消</button><button className="primary-button" data-save-profile disabled={busy || !connected || !name.trim()}>{busy ? '保存中…' : '保存资料'}</button></div>
        </form> : <div className="profile-actions">
          {self ? <button className="primary-button" data-edit-profile disabled={!connected || !snapshot?.profileSupported} onClick={() => { setEditing(true); setNotice(''); setError('') }}><PencilLine size={16}/>编辑资料</button>
            : relation === 'friend' ? <button className="primary-button" data-profile-chat onClick={() => onChat(member.id)} disabled={!current}><MessageCircleMore size={17}/>发消息</button>
            : relation === 'incoming' ? <><button className="primary-button" data-profile-accept disabled={!connected || busy} onClick={() => void act('friends/accept', '已成为好友，可以开始聊天')}>接受好友申请</button><button className="secondary-button" disabled={!connected || busy} onClick={() => void act('friends/reject', '已拒绝申请')}>拒绝</button></>
            : relation === 'outgoing' ? <button className="secondary-button" data-profile-cancel disabled={!connected || busy} onClick={() => void act('friends/cancel', '已取消好友申请')}>等待同意 · 取消申请</button>
            : <button className="primary-button" data-profile-add disabled={!connected || busy} onClick={() => void act('friends/request', '好友申请已发出，等待对方同意')}>添加好友</button>}
          {self && <button className="secondary-button" onClick={onSettings}>身份与服务器设置</button>}
        </div>}
        {self && connected && !snapshot?.profileSupported && <p className="settings-note">此服务器尚未支持主页编辑；昵称仍可在“身份与服务器设置”中修改。</p>}
        <section className="profile-section"><h3>全局用户 ID</h3><div className="profile-id"><code>{member.id}</code><button className="icon-button" data-profile-copy aria-label="复制用户 ID" title="复制用户 ID" disabled={busy} onClick={() => void run(() => appApi.copyUserId(member.id), '用户 ID 已复制')}><Copy size={17}/></button></div></section>
        <section className="profile-section"><h3>{self ? '加入的群聊' : '共同群聊'}<span>{groups.length}</span></h3>{groups.length ? groups.map(group => <button key={group.id} className="profile-group" data-profile-group={group.id} onClick={() => onChat(group.id)}><Users size={20}/><span>{group.name}<small>{group.members.length} 位成员</small></span><span>进入 →</span></button>) : <p className="settings-note">{self ? '加入群聊后会在这里显示。' : '目前没有共同群聊。'}</p>}</section>
        {!self && relation === 'friend' && <div className="profile-remove">
          {!removing ? <button className="text-danger-button" disabled={!connected || busy} onClick={() => setRemoving(true)}>删除好友</button> : <div className="danger-confirm"><p>删除好友 {member.displayName}？本机聊天记录会保留。</p><div><button className="secondary-button" disabled={busy} onClick={() => setRemoving(false)}>取消</button><button className="primary-button" data-profile-remove disabled={!connected || busy} onClick={() => void act('friends/remove', '已删除好友，本机历史记录保留').then(ok => { if (ok && mounted.current) setRemoving(false) })}>删除好友</button></div></div>}
        </div>}
      </div>
    </aside>
  </div>
}
