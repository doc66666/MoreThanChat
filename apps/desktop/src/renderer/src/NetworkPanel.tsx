import { useState } from 'react'
import { IdentitySettings } from './IdentitySettings'
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
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
      return false
    } finally {
      setBusy(false)
    }
  }
  const action = (route: string, data: unknown) =>
    run(() => window.moreThanChat.serverAction(route, data))
  const directory = snapshot?.directory
  const [joinId, setJoinId] = useState('')
  const [removeFriend,setRemoveFriend]=useState<{id:string;displayName:string}|null>(null)
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
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h2>中心服务器与联系人</h2>
          <button className="icon-button" onClick={onClose}>
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
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://你的服务器"
          />
        </label>
        <label className="settings-field">
          <span>显示名称</span>
          <input
            data-server-field="name"
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
          disabled={!snapshot}
          onClick={() => void run(() => window.moreThanChat.copyGlobalUserId())}
        >
          复制自己的全局 ID
        </button>
        <div className="network-buttons">
          <button
            className="primary-button"
            data-connect-server
            disabled={busy || !snapshot}
            onClick={() =>
              void run(() => window.moreThanChat.connectServer(address, name))
            }
          >
            Ping 并认证连接
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              void run(() => window.moreThanChat.disconnectServer())
            }
            data-disconnect-server
          >
            断开
          </button>
        </div>
        <p className="settings-note" data-server-status={snapshot?.status}>
          {snapshot?.status === 'connected'
            ? `已连接 · ${snapshot.mode === 'private' ? '私服白名单' : '公共黑名单'} · ${snapshot.serverId}`
            : (snapshot?.error ?? '尚未连接')}
        </p>
        {error && <p className="settings-error">{error}</p>}
        <IdentitySettings key={snapshot?.serverId??'offline'} connected={snapshot?.status==='connected'} />
        <h3>添加本服好友</h3>
        <input
          data-friend-id
          value={friendId}
          onChange={(e) => setFriendId(e.target.value)}
          placeholder="粘贴对方全局用户 ID"
        />
        <button
          className="secondary-button"
          data-request-friend
          disabled={busy || snapshot?.status !== 'connected'}
          onClick={() =>
            void action('friends/request', { userId: friendId.trim() })
          }
        >
          提交好友申请
        </button>
        {(directory?.requests ?? []).map((user) => (
          <div className="contact-row" key={user.id}>
            <span>
              {user.displayName}
              <small>{user.id}</small>
            </span>
            <button
              data-accept-friend={user.id}
              disabled={busy}
              onClick={() => void action('friends/accept', { userId: user.id })}
            >
              接受
            </button>
            <button data-reject-friend={user.id} disabled={busy} onClick={()=>void action('friends/reject',{userId:user.id})}>拒绝</button>
          </div>
        ))}
        {(directory?.outgoingRequests??[]).map(user=><div className="contact-row" key={'request:'+user.id}><span>{user.displayName}<small>等待对方接受好友申请</small></span><button disabled={busy} data-cancel-friend={user.id} onClick={()=>void action('friends/cancel',{userId:user.id})}>取消申请</button></div>)}
        <h3>好友</h3>
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
            </button><button className="contact-remove" title="删除好友" data-remove-friend={user.id} onClick={()=>setRemoveFriend(user)}>×</button>
          </div>
        ))}
        {removeFriend&&<div className="danger-confirm"><p>删除好友 {removeFriend.displayName}？本机聊天记录会保留。</p><div><button className="secondary-button" onClick={()=>setRemoveFriend(null)}>取消</button><button className="primary-button" disabled={busy} data-confirm-remove-friend onClick={()=>void action('friends/remove',{userId:removeFriend.id}).then(ok=>{if(ok)setRemoveFriend(null)})}>删除好友</button></div></div>}
        <h3>创建群聊</h3>
        <input
          data-group-name
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="群名称"
        />
        {(directory?.friends ?? []).map((user) => (
          <label className="group-member-option" key={user.id}>
            <input
              type="checkbox"
              checked={members.includes(user.id)}
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
          disabled={busy || !groupName.trim() || !members.length}
          onClick={() =>
            void action('groups', { name: groupName, memberIds: members })
          }
        >
          创建群
        </button>
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
          value={joinId}
          onChange={(e) => setJoinId(e.target.value)}
          placeholder="粘贴本服群的全局 ID"
        />
        <button
          className="secondary-button"
          disabled={busy || snapshot?.status !== 'connected'}
          onClick={() => void action('groups/join', { groupId: joinId.trim() })}
        >
          查找群并申请加入
        </button>
        {(directory?.groupRequests ?? []).map((request) => (
          <div className="contact-row" key={request.groupId + request.user.id}>
            <span>
              {request.user.displayName} 申请加入 {request.groupName}
            </span>
            <button
              onClick={() =>
                void action('groups/accept', {
                  groupId: request.groupId,
                  userId: request.user.id,
                })
              }
            >
              批准入群
            </button>
            <button disabled={busy} onClick={()=>void action('groups/reject',{groupId:request.groupId,userId:request.user.id})}>拒绝</button>
          </div>
        ))}
        <h3>群插件申请 · 管理员审批</h3>
        {pending.length === 0 && (
          <p className="settings-note">
            没有待审批申请。进入群聊可提交接龙、小游戏或同步通道插件。
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
            <p>
              界面位置：{plugin.pack.slot}；可向本群发送同步事件，无任意 URL
              或文件权限。
            </p>
            <div className="draft-actions">
              <button
                data-approve-group-plugin
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

export function GroupPluginView({
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
  const disabledKey =
    'group-plugin-disabled:' + plugin.groupId + ':' + plugin.pack.id
  const [disabled, setDisabled] = useState(() => {
    try {
      return localStorage.getItem(disabledKey) === 'true'
    } catch {
      return false
    }
  })
  const toggle = (value: boolean) => {
    setDisabled(value)
    try {
      localStorage.setItem(disabledKey, String(value))
    } catch {}
  }
  if (disabled)
    return (
      <section
        className="group-plugin-widget"
        data-group-plugin={plugin.pack.id}
      >
        <strong>{plugin.pack.displayName} · 本机已停用</strong>
        <button data-enable-group-plugin onClick={() => toggle(false)}>
          启用本机界面
        </button>
      </section>
    )
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
      <button data-disable-group-plugin onClick={() => toggle(true)}>
        停用本机界面
      </button>
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
