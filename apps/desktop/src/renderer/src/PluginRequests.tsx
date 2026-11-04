import { useRef, useState } from 'react'
import {
  canReviewPlugin,
  pluginScopeMembers,
  type ServerSnapshot,
} from '@more-than-chat/central-protocol'
import { appApi } from './app-api'
import { slotLabels } from './group-plugin-presentation'

export function pendingPluginRequests(snapshot: ServerSnapshot | null) {
  const directory = snapshot?.directory
  return (
    directory?.plugins.filter(
      (plugin) => plugin.status === 'pending' && canReviewPlugin(directory, plugin),
    ) ?? []
  )
}
export function PluginRequests({ snapshot }: { snapshot: ServerSnapshot | null }) {
  const pending = pendingPluginRequests(snapshot),
    directory = snapshot?.directory
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    running = useRef(false)
  const connected = snapshot?.status === 'connected',
    disabled = busy || !connected
  async function action(route: string, data: unknown) {
    if (running.current || !connected || !snapshot?.serverId) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await appApi.serverAction(route, data, snapshot.serverId)
    } catch (error) {
      setError(error instanceof Error ? error.message : '审批未完成，请重试')
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      <h3>插件分享申请 · 好友同意／群管理员审批</h3>
      {pending.length === 0 && (
        <p className="settings-note">
          {connected
            ? '没有待审批申请。进入群聊可提交 AI 创作的插件或使用演示模板。'
            : '连接服务器后查看待审批的群插件申请。'}
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
            会话：
            {directory?.groups.find((group) => group.id === plugin.groupId)?.name ??
              (directory &&
                pluginScopeMembers(directory, plugin.groupId)
                  .filter((m) => m.id !== snapshot?.userId)
                  .map((m) => m.displayName)
                  .join('、'))}
          </p>
          <p>申请人：{plugin.submittedBy}</p>
          {plugin.pack.artifact && (
            <>
              <p>
                {plugin.pack.artifact.manifest.description} ·
                更新会重置共享状态，成员需重新确认载入。
              </p>
              <details>
                <summary>审阅完整插件包</summary>
                <pre>{JSON.stringify(plugin.pack, null, 2)}</pre>
              </details>
            </>
          )}
          {plugin.pack.kind === 'executable' ? (
            <>
              <p>
                可执行客户端插件，可改造整个界面、通过本会话同步；批准只是分发，双方／成员仍自行载入。
              </p>
              <details>
                <summary>查看完整插件代码</summary>
                <pre>{JSON.stringify(plugin.pack.client, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p>
              界面位置：{slotLabels[plugin.pack.slot]}；可向本群发送同步事件，无任意 URL
              或文件权限。
            </p>
          )}
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
              {plugin.groupId.startsWith('dm_') ? '同意分享并分发' : '批准并向本群分发'}
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
    </>
  )
}
