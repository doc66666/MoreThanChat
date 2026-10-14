import { useEffect, useRef, useState } from 'react'
import { MAX_GROUP_MEMBERS, validGroupId } from '@more-than-chat/central-protocol'
import { slotLabels } from './group-plugin-presentation'
import { friendRequestIssue, selectedCurrentFriends } from './network-form'
import { useDialogFocus } from './use-dialog-focus'
import { IdentitySettings } from './IdentitySettings'
import { GeneratedGroupPlugin, GroupPluginGate } from './GeneratedGroupPlugin'
import type {
  GroupPlugin,
  ServerSnapshot,
} from '@more-than-chat/central-protocol'
export function NetworkPanel({
  snapshot,
  onClose,
  onOpenChat,
}: {
  snapshot: ServerSnapshot | null
  onClose: () => void
  onOpenChat: (targetId: string) => void
}) {
  const [address, setAddress] = useState(
      snapshot?.address ?? 'http://localhost:8787',
    ),
    [name, setName] = useState(snapshot?.displayName ?? '我'),
    [friendId, setFriendId] = useState(''),
    [groupName, setGroupName] = useState(''),
    [members, setMembers] = useState<string[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false)
  const inFlight=useRef(false)
  const dialog=useDialogFocus()
  const [notice,setNotice]=useState('')
  const connected=snapshot?.status==='connected',disabled=busy||!connected
  const run = async (fn: () => Promise<unknown>,success='操作已完成') => {
    if(inFlight.current)return false
    inFlight.current=true
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      await fn()
      setNotice(success)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
      return false
    } finally {
      inFlight.current=false
      setBusy(false)
    }
  }
  const action = (route: string, data: unknown,success?:string) => {
    if(!connected){setError('请先连接中心服务器，再进行此操作。');return Promise.resolve(false)}
    return run(() => window.moreThanChat.serverAction(route, data),success)
  }
  const directory = snapshot?.directory
  const [joinId, setJoinId] = useState('')
  const [removeFriend,setRemoveFriend]=useState<{id:string;displayName:string}|null>(null)
  const friendIssue=friendRequestIssue(friendId,snapshot?.userId,directory)
  const selectedMembers=selectedCurrentFriends(members,directory)
  const formServer=useRef(snapshot?.serverId??null)
  useEffect(()=>{
    const id=snapshot?.serverId
    if(!id)return
    // Automatic reconnect temporarily clears serverId; keep unfinished forms in that case.
    if(formServer.current&&formServer.current!==id){setMembers([]);setGroupName('');setFriendId('');setJoinId('');setRemoveFriend(null);setNotice('');setError(null)}
    formServer.current=id
  },[snapshot?.serverId])
  const pending =
    directory?.plugins.filter(
      (plugin) =>
        plugin.status === 'pending' &&
        directory.groups.find((group) => group.id === plugin.groupId)
          ?.ownerId === snapshot?.userId,
    ) ?? []
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="plugin-drawer network-drawer"
        ref={dialog} tabIndex={-1}
        role="dialog" aria-modal="true" aria-label="中心服务器与联系人"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h2>中心服务器与联系人</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭服务器与联系人">
            ×
          </button>
        </div>
        <p className="settings-note">
          好友、群聊及插件同步只在同一服务器内进行。私服须先加入白名单。
        </p>
        <label className="settings-field">
          <span>服务器地址</span>
          <input
            data-server-field="address"
            disabled={busy}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://你的服务器"
          />
        </label>
        <label className="settings-field">
          <span>显示名称</span>
          <input
            data-server-field="name"
            maxLength={80}
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="identity-id">
          全局用户 ID：
          <code data-user-id>{snapshot?.userId ?? '身份初始化中'}</code>
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={!snapshot||busy}
          onClick={() => void run(() => window.moreThanChat.copyGlobalUserId(),'全局用户 ID 已复制')}
        >
          复制自己的全局 ID
        </button>
        <div className="network-buttons">
          <button
            className="primary-button"
            data-connect-server
            disabled={busy || !snapshot || !address.trim() || snapshot.status==='connecting'}
            onClick={() =>
              void run(() => window.moreThanChat.connectServer(address, name),'连接成功，可以添加本服好友或加入群聊')
            }
          >
            {snapshot?.status==='connecting'?'正在连接…':'Ping 并认证连接'}
          </button>
          <button
            className="secondary-button"
            disabled={busy || snapshot?.status==='disconnected' || !snapshot}
            onClick={() =>
              void run(() => window.moreThanChat.disconnectServer(),'已断开连接；本机聊天记录仍保留')
            }
            data-disconnect-server
          >
            断开
          </button>
        </div>
        <p className="settings-note" data-server-status={snapshot?.status}>
          {snapshot?.status === 'connected'
            ? `已连接 · ${snapshot.mode === 'private' ? '私服白名单' : '公共黑名单'} · ${snapshot.serverId}`
            : snapshot?.status==='connecting'?'正在检查地址并认证…':(snapshot?.error ?? '尚未连接')}
        </p>
        {(error||busy||notice)&&<div className="network-feedback">
          {error && <p className="settings-error" role="alert">{error}</p>}
          {busy&&<p className="settings-note" role="status">正在处理，请稍候…</p>}
          {notice&&<p className="network-notice" role="status">{notice}</p>}
        </div>}
        {!connected&&<p className="settings-note">连接服务器后才能处理好友、群聊和插件申请。离线时可以查看本机已保存的聊天记录。</p>}
        <IdentitySettings key={snapshot?.serverId??'offline'} connected={snapshot?.status==='connected'} />
        <h3>添加本服好友</h3>
        <input
          data-friend-id
          aria-label="好友的全局用户 ID"
          maxLength={128}
          disabled={busy}
          value={friendId}
          onChange={(e) => setFriendId(e.target.value)}
          placeholder="粘贴对方全局用户 ID"
        />
        <button
          className="secondary-button"
          data-request-friend
          disabled={disabled || !!friendIssue}
          onClick={() =>
            void action('friends/request', { userId: friendId.trim() },'好友申请已发送，等待对方接受').then(ok=>{if(ok)setFriendId('')})
          }
        >
          提交好友申请
        </button>
        {friendIssue&&<p className="settings-note">{friendIssue}</p>}
        {(directory?.requests ?? []).map((user) => (
          <div className="contact-row" key={user.id}>
            <span>
              {user.displayName}
              <small>{user.id}</small>
            </span>
            <button
              data-accept-friend={user.id}
              disabled={disabled}
              onClick={() => void action('friends/accept', { userId: user.id })}
            >
              接受
            </button>
            <button data-reject-friend={user.id} disabled={disabled} onClick={()=>void action('friends/reject',{userId:user.id})}>拒绝</button>
          </div>
        ))}
        {(directory?.outgoingRequests??[]).map(user=><div className="contact-row" key={'request:'+user.id}><span>{user.displayName}<small>等待对方接受好友申请</small></span><button disabled={disabled} data-cancel-friend={user.id} onClick={()=>void action('friends/cancel',{userId:user.id})}>取消申请</button></div>)}
        <h3>好友</h3>
        {connected&&!directory?.friends.length&&<p className="settings-note">还没有好友。复制自己的 ID 发给对方，或在上方添加本服好友。</p>}
        {(directory?.friends ?? []).map((user) => (
          <div
            className="contact-row"
            key={user.id}
          >
            <button className="contact-open" data-friend={user.id}
            onClick={() => {
              onOpenChat(user.id)
              onClose()
            }}
          >
            <span>
              {user.displayName}
              <small>{user.online ? '在线' : '离线 · 消息由服务器暂存'}</small>
            </span>
            <code>{user.id.slice(-8)}</code>
            </button><button className="contact-remove" disabled={disabled} aria-label={`删除好友 ${user.displayName}`} title="删除好友" data-remove-friend={user.id} onClick={()=>setRemoveFriend(user)}>×</button>
          </div>
        ))}
        {removeFriend&&<div className="danger-confirm"><p>删除好友 {removeFriend.displayName}？本机聊天记录会保留。</p><div><button className="secondary-button" disabled={busy} onClick={()=>setRemoveFriend(null)}>取消</button><button className="primary-button" disabled={disabled} data-confirm-remove-friend onClick={()=>void action('friends/remove',{userId:removeFriend.id}).then(ok=>{if(ok)setRemoveFriend(null)})}>删除好友</button></div></div>}
        <h3>创建群聊</h3>
        <input
          data-group-name
          aria-label="新群名称"
          maxLength={80}
          disabled={busy}
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="群名称"
        />
        {(directory?.friends ?? []).map((user) => (
          <label className="group-member-option" key={user.id}>
            <input
              type="checkbox"
              checked={selectedMembers.includes(user.id)}
              disabled={disabled||(!selectedMembers.includes(user.id)&&selectedMembers.length>=MAX_GROUP_MEMBERS-1)}
              onChange={(e) =>
                setMembers((value) =>
                  e.target.checked
                    ? [...value, user.id]
                    : value.filter((id) => id !== user.id),
                )
              }
            />
            {user.displayName}
          </label>
        ))}
        <button
          className="secondary-button"
          data-create-group
          disabled={disabled || !groupName.trim() || !selectedMembers.length || selectedMembers.length>=MAX_GROUP_MEMBERS}
          onClick={() =>
            void action('groups', { name: groupName.trim(), memberIds: selectedMembers },'群聊已创建，可在下方打开').then(ok=>{if(ok){setGroupName('');setMembers([])}})
          }
        >
          创建群
        </button>
        <p className="settings-note">已选 {selectedMembers.length} 位好友；至少选 1 位，最多 {MAX_GROUP_MEMBERS-1} 位，加上你共 {MAX_GROUP_MEMBERS} 人。</p>
        <h3>本服群聊</h3>
        {(directory?.groups ?? []).map((group) => (
          <button
            className="contact-row"
            key={group.id}
            data-group={group.id}
            onClick={() => {
              onOpenChat(group.id)
              onClose()
            }}
          >
            <span>
              {group.name}
              <small>{group.id}</small>
            </span>
            <span>{group.members.length} 人</span>
          </button>
        ))}
        <input
          aria-label="要加入的群 ID"
          maxLength={80}
          disabled={busy}
          value={joinId}
          onChange={(e) => setJoinId(e.target.value)}
          placeholder="粘贴本服群的全局 ID"
        />
        <button
          className="secondary-button"
          disabled={disabled || !validGroupId(joinId.trim())}
          onClick={() => void action('groups/join', { groupId: joinId.trim() },'入群申请已发送，等待管理员审批').then(ok=>{if(ok)setJoinId('')})}
        >
          查找群并申请加入
        </button>
        {joinId&&!validGroupId(joinId.trim())&&<p className="settings-note">请粘贴完整的 grp_ 开头的群 ID。</p>}
        {(directory?.groupRequests ?? []).map((request) => (
          <div className="contact-row" key={request.groupId + request.user.id}>
            <span>
              {request.user.displayName} 申请加入 {request.groupName}
            </span>
            <button
              disabled={disabled}
              onClick={() =>
                void action('groups/accept', {
                  groupId: request.groupId,
                  userId: request.user.id,
                })
              }
            >
              批准入群
            </button>
            <button disabled={disabled} onClick={()=>void action('groups/reject',{groupId:request.groupId,userId:request.user.id})}>拒绝</button>
          </div>
        ))}
        <h3>群插件申请 · 管理员审批</h3>
        {pending.length === 0 && (
          <p className="settings-note">
            {connected?'没有待审批申请。进入群聊可提交 AI 创作的插件或使用演示模板。':'连接服务器后查看待审批的群插件申请。'}
          </p>
        )}
        {pending.map((plugin) => (
          <section
            className="draft-card"
            data-group-plugin-review={plugin.pack.id}
            key={plugin.groupId + plugin.pack.id + plugin.pack.version}
          >
            <strong>
              {plugin.pack.displayName} · v{plugin.pack.version}
            </strong>
            <small>{plugin.digest}</small>
            <p>群聊：{directory?.groups.find(group=>group.id===plugin.groupId)?.name??plugin.groupId}</p>
            <p>申请人：{plugin.submittedBy}</p>
            {plugin.pack.artifact&&<><p>{plugin.pack.artifact.manifest.description} · 更新会重置共享状态，成员需重新确认载入。</p><details><summary>审阅完整插件包</summary><pre>{JSON.stringify(plugin.pack,null,2)}</pre></details></>}
            <p>
              界面位置：{slotLabels[plugin.pack.slot]}；可向本群发送同步事件，无任意 URL
              或文件权限。
            </p>
            <div className="draft-actions">
              <button
                data-approve-group-plugin
                disabled={disabled}
                onClick={() =>
                  void action('plugins/review', {
                    groupId: plugin.groupId,
                    pluginId: plugin.pack.id,
                    version: plugin.pack.version,
                    digest: plugin.digest,
                    approve: true,
                  })
                }
              >
                批准并向本群分发
              </button>
              <button
                disabled={disabled}
                onClick={() =>
                  void action('plugins/review', {
                    groupId: plugin.groupId,
                    pluginId: plugin.pack.id,
                    version: plugin.pack.version,
                    digest: plugin.digest,
                    approve: false,
                  })
                }
              >
                拒绝
              </button>
            </div>
          </section>
        ))}
      </aside>
    </div>
  )
}

export function GroupPluginView(props:{plugin:GroupPlugin;userId:string;members:string[];onError:(s:string)=>void}) {
  return <GroupPluginGate plugin={props.plugin} onError={props.onError}>{props.plugin.pack.kind==='declarative'?<GeneratedGroupPlugin {...props}/>:<BundledGroupPluginView {...props}/>}</GroupPluginGate>
}

function BundledGroupPluginView({
  plugin,
  userId,
  onError,
}: {
  plugin: GroupPlugin
  userId: string
  onError: (message: string) => void
}) {
  const [entry, setEntry] = useState(''),
    [busy, setBusy] = useState(false)
  const send = async (payload: unknown) => {
    setBusy(true)
    try {
      await window.moreThanChat.serverAction('plugins/event', {
        groupId: plugin.groupId,
        pluginId: plugin.pack.id,
        channel: 'state',
        payload,
        expectedRevision: plugin.revision,
      })
    } catch (e) {
      onError(e instanceof Error ? e.message : '同步失败')
    } finally {
      setBusy(false)
    }
  }
  const entries = (plugin.state.entries ?? []) as {
      userId: string
      name: string
      text: string
    }[],
    board = (plugin.state.board ?? []) as (string | null)[],
    players = (plugin.state.players ?? []) as string[]
  return (
    <section className="group-plugin-widget" data-group-plugin={plugin.pack.id}>
      <h3>
        {plugin.pack.displayName}{' '}
        <small>
          v{plugin.pack.version} · r{plugin.revision}
        </small>
      </h3>
      {plugin.pack.kind === 'chain' ? (
        <>
          <ol>
            {entries.map((item) => (
              <li key={item.userId}>
                {item.name}：{item.text}
              </li>
            ))}
          </ol>
          <input
            value={entry}
            maxLength={120}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="填写接龙内容"
            data-chain-entry
          />
          <button
            data-chain-join
            disabled={
              busy ||
              !entry.trim() ||
              entries.some((item) => item.userId === userId)
            }
            onClick={() => void send({ text: entry })}
          >
            参与接龙
          </button>
        </>
      ) : plugin.pack.kind === 'tic-tac-toe' ? (
        <>
          <p>
            {plugin.state.winner
              ? plugin.state.winner === 'draw'
                ? '平局'
                : '本局已结束'
              : players[Number(plugin.state.turn)] === userId
                ? '轮到你落子'
                : '等待另一位玩家'}
          </p>
          <div className="game-board">
            {board.map((mark, index) => (
              <button
                data-game-cell={index}
                disabled={
                  busy ||
                  Boolean(mark) ||
                  Boolean(plugin.state.winner) ||
                  players[Number(plugin.state.turn)] !== userId
                }
                key={index}
                onClick={() => void send({ cell: index })}
              >
                {mark ?? '·'}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p>同步通道已获得批准，插件可通过 chat.network 发送群内事件。</p>
      )}
    </section>
  )
}
