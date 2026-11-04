import { appApi } from './app-api'
import { useRef, useState } from 'react'
import { ArrowUpRight, MessageCircleMore, Search, Server, UserPlus, Users, X } from 'lucide-react'
import type { Member, ServerSnapshot } from '@more-than-chat/central-protocol'
import { useDialogFocus } from './use-dialog-focus'
import { friendRequestIssue } from './network-form'
import { avatarTone } from './conversation-presentation'
import { matchesContact, nameInitials } from './user-directory'
import { PluginRequests, pendingPluginRequests } from './PluginRequests'

export function ContactsPanel({ snapshot, onClose, onProfile, onChat, onManage }: {
  snapshot: ServerSnapshot | null; onClose: () => void; onProfile: (member: Member) => void
  onChat: (id: string) => void; onManage: () => void
}) {
  const dialog = useDialogFocus(), running = useRef(false)
  const [tab, setTab] = useState<'friends' | 'groups' | 'requests'>('friends')
  const [query, setQuery] = useState(''), [onlineOnly, setOnlineOnly] = useState(false)
  const [adding, setAdding] = useState(false), [friendId, setFriendId] = useState('')
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const directory = snapshot?.directory, connected = snapshot?.status === 'connected'
  const requests = directory?.requests ?? [], outgoing = directory?.outgoingRequests ?? [], groupRequests = directory?.groupRequests ?? []
  const pending = requests.length + groupRequests.length + pendingPluginRequests(snapshot).length
  const friends = (directory?.friends ?? []).filter(user => (!onlineOnly || user.online) && matchesContact(query, user.displayName, user.id)).slice().sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName, 'zh-CN'))
  const groups = (directory?.groups ?? []).filter(group => matchesContact(query, group.name, group.id))
  const issue = friendRequestIssue(friendId, snapshot?.userId, directory)
  async function act(route: string, data: unknown, success: string) {
    if (running.current || !connected || !snapshot?.serverId) return false
    running.current = true; setBusy(true); setNotice(''); setError('')
    try { await appApi.serverAction(route, data, snapshot.serverId); setNotice(success); return true }
    catch (e) { setError(e instanceof Error ? e.message : '操作未完成，请重试'); return false }
    finally { running.current = false; setBusy(false) }
  }
  const avatar = (user: Member) => <span className="person-avatar" data-avatar-tone={user.avatarColor ?? avatarTone(user.id)}>{nameInitials(user.displayName)}</span>
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="plugin-drawer contacts-drawer" ref={dialog} role="dialog" aria-modal="true" aria-label="通讯录" tabIndex={-1} onMouseDown={e => e.stopPropagation()}>
      <div className="contacts-chrome">
        <div className="drawer-header"><div><p className="eyebrow">朋友与共同的空间</p><h2>通讯录</h2></div><button className="icon-button" aria-label="关闭通讯录" onClick={onClose}><X size={19}/></button></div>
        <div className="contacts-server"><span><i className="status-dot" data-connected={connected}/>{connected ? '已连接当前服务器' : '尚未连接服务器'}</span><button onClick={onManage}><Server size={14}/>连接设置<ArrowUpRight size={13}/></button></div>
        <label className="search-box contacts-search"><Search size={17}/><input aria-label="搜索好友或群聊" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索昵称、群名称或 ID"/>{query && <button className="search-clear" aria-label="清除通讯录搜索" onClick={() => setQuery('')}><X size={14}/></button>}</label>
        <div className="conversation-filters contacts-tabs" role="group" aria-label="通讯录分类">{([['friends','好友'],['groups','群聊'],['requests','申请']] as const).map(([id, label]) => <button key={id} data-contacts-tab={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}{id === 'requests' && pending > 0 && <b>{pending}</b>}</button>)}</div>
      </div>
      <div className="contacts-body">
        {(error || notice) && <p className={error ? 'settings-error' : 'network-notice'} role={error ? 'alert' : 'status'}>{error || notice}</p>}
        {!connected && <div className="contacts-empty"><Server size={30}/><h3>先连接，才能遇见彼此</h3><p>好友与群聊属于各自的中心服务器。连接后即可查看通讯录。</p><button className="primary-button" onClick={onManage}>设置服务器连接</button></div>}
        {connected && tab === 'friends' && <>
          <div className="contacts-toolbar"><label><input type="checkbox" data-contacts-online checked={onlineOnly} onChange={e => setOnlineOnly(e.target.checked)}/>只看在线</label><button className="secondary-button" data-add-contact onClick={() => setAdding(!adding)}><UserPlus size={15}/>添加好友</button></div>
          {adding && <form className="contacts-add" onSubmit={event => { event.preventDefault(); if (!issue) void act('friends/request', { userId: friendId.trim() }, '好友申请已发送，等待对方同意').then(ok => { if (ok) { setFriendId(''); setAdding(false); setTab('requests') } }) }}>
            <label className="settings-field"><span>好友的全局用户 ID</span><input data-contact-request-id maxLength={128} value={friendId} disabled={busy} onChange={e => setFriendId(e.target.value)} placeholder="粘贴 usr_ 开头的完整 ID"/></label>
            {friendId && issue && <p className="settings-note">{issue}</p>}
            <button className="primary-button" data-contact-request disabled={busy || !!issue}>发送好友申请</button>
          </form>}
          <p className="contacts-count">{friends.length} 位好友</p>
          {friends.map(user => <div className="person-row" key={user.id} data-contact-user={user.id}><button className="person-open" data-contact-profile={user.id} onClick={() => onProfile(user)}>{avatar(user)}<span><strong>{user.displayName}</strong><small>{user.bio || (user.online ? '在线' : '离线')}</small></span><i className="status-dot" data-connected={user.online}/></button><button className="icon-button" data-contact-chat={user.id} aria-label={`发消息给 ${user.displayName}`} title="发消息" onClick={() => onChat(user.id)}><MessageCircleMore size={18}/></button></div>)}
          {!friends.length && <div className="contacts-empty"><Users size={28}/><h3>{query || onlineOnly ? '没有匹配的好友' : '从第一位好友开始'}</h3><p>{query || onlineOnly ? '试试其他昵称，或清除筛选。' : '交换全局用户 ID，或者从群成员主页添加朋友。'}</p></div>}
        </>}
        {connected && tab === 'groups' && <><div className="contacts-toolbar"><span>{groups.length} 个群聊</span><button className="secondary-button" onClick={onManage}><Users size={15}/>创建 / 加入群聊</button></div>{groups.map(group => <button className="profile-group contact-group" key={group.id} data-contact-group={group.id} onClick={() => onChat(group.id)}><span className="person-avatar group" data-avatar-tone={avatarTone(group.id)}>{nameInitials(group.name)}</span><span><strong>{group.name}</strong><small>{group.members.length} 位成员 · {group.ownerId === snapshot?.userId ? '我是管理员' : '群成员'}</small></span><ArrowUpRight size={17}/></button>)}{!groups.length && <div className="contacts-empty"><Users size={28}/><h3>{query ? '没有匹配的群聊' : '还没有加入群聊'}</h3><p>创建一个群，或者用群 ID 申请加入。</p></div>}</>}
        {connected && tab === 'requests' && <>
          <PluginRequests snapshot={snapshot}/>
          <h3 className="contacts-section-title">收到的申请 <span>{pending}</span></h3>
          {requests.filter(user => matchesContact(query, user.displayName, user.id)).map(user => <div className="contact-request" key={user.id}><button className="person-open" onClick={() => onProfile(user)}>{avatar(user)}<span><strong>{user.displayName}</strong><small>申请成为好友</small></span></button><div><button className="secondary-button" data-contact-reject={user.id} disabled={busy} onClick={() => void act('friends/reject', { userId: user.id }, '已拒绝好友申请')}>拒绝</button><button className="primary-button" data-contact-accept={user.id} disabled={busy} onClick={() => void act('friends/accept', { userId: user.id }, '已成为好友，可以开始聊天')}>接受</button></div></div>)}
          {groupRequests.filter(request => matchesContact(query, request.user.displayName + ' ' + request.groupName, request.user.id)).map(request => <div className="contact-request" key={request.groupId + request.user.id}><button className="person-open" onClick={() => onProfile(request.user)}>{avatar(request.user)}<span><strong>{request.user.displayName}</strong><small>申请加入 {request.groupName}</small></span></button><div><button className="secondary-button" disabled={busy} onClick={() => void act('groups/reject', { groupId: request.groupId, userId: request.user.id }, '已拒绝入群申请')}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => void act('groups/accept', { groupId: request.groupId, userId: request.user.id }, '已批准加入群聊')}>批准</button></div></div>)}
          {!pending && <p className="settings-note">没有待处理的申请。</p>}
          <h3 className="contacts-section-title">发出的申请 <span>{outgoing.length}</span></h3>
          {outgoing.filter(user => matchesContact(query, user.displayName, user.id)).map(user => <div className="contact-request" key={user.id}><button className="person-open" onClick={() => onProfile(user)}>{avatar(user)}<span><strong>{user.displayName}</strong><small>等待对方同意</small></span></button><button className="secondary-button" data-contact-cancel={user.id} disabled={busy} onClick={() => void act('friends/cancel', { userId: user.id }, '已取消好友申请')}>取消申请</button></div>)}
          {!outgoing.length && <p className="settings-note">没有等待同意的好友申请。</p>}
        </>}
      </div>
    </aside>
  </div>
}
