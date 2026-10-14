import * as React from 'react'
import { useEffect, useState } from 'react'
import type { InstalledClientPackage } from '@more-than-chat/plugin-runtime'
import type { PluginDraftSummary } from '@more-than-chat/protocol'
import { pluginRuntime } from './plugin-host'
import { ClientPluginLoader, importClientModule } from './client-plugin-loader'

let loader: ClientPluginLoader | undefined
export function getClientPluginLoader(): ClientPluginLoader {
  return loader ??= new ClientPluginLoader(pluginRuntime, Object.freeze({version: 1, React, get app() {return window.moreThanChat}}), importClientModule)
}
const changed = () => window.dispatchEvent(new Event('client-plugins-changed'))
const errorText = (error: unknown) => error instanceof Error ? error.message : '插件操作失败'

export function InstallClientDraft({draft}: {draft: PluginDraftSummary}) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  return <div>
    <button className="secondary-button" disabled={busy || !draft.ok} onClick={async () => {
      setBusy(true)
      try {
        const pack = await window.moreThanChat.installClientDraft(draft.id, draft.revision)
        setNotice(pack ? '已安装到用户目录，尚未执行。请在“可执行界面”中确认运行。' : '已取消，未安装此修订')
        if (pack) changed()
      } catch (error) {setNotice(errorText(error))} finally {setBusy(false)}
    }}>{busy ? '请完成系统确认' : '安装此界面版本'}</button>
    {notice && <p role="status" className="settings-note">{notice}</p>}
  </div>
}

export function ClientPlugins() {
  const clientPluginLoader = getClientPluginLoader()
  const [packages, setPackages] = useState<InstalledClientPackage[]>([])
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [, refresh] = useState(0)
  useEffect(() => {
    let alive = true
    const reload = () => {void window.moreThanChat.getClientPlugins().then(list => {if (alive) setPackages(list)}).catch(error => {if (alive) setNotice(errorText(error))})}
    reload(); window.addEventListener('client-plugins-changed', reload)
    const off = pluginRuntime.subscribe(() => refresh(value => value + 1))
    return () => {alive = false; window.removeEventListener('client-plugins-changed', reload); off()}
  }, [])
  async function run(work: () => Promise<void>) {
    setBusy(true); setNotice('')
    try {await work()} catch (error) {setNotice(errorText(error))} finally {setBusy(false)}
  }
  return <section className="draft-section" data-client-plugins>
    <h3>可执行界面</h3>
    <p className="settings-note">可信 JavaScript 可重塑整个桌面，不受九个位置限制。每次启动默认停用；Ctrl+Shift+F12 可恢复默认界面。停用只能清理插件正确登记的副作用，完整恢复请使用快捷键。</p>
    <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
      const pack = await window.moreThanChat.importClientPlugin()
      if (pack) {changed(); setNotice('已安装，尚未运行。更新不会自动执行新代码。')}
    })}>从文件导入界面插件</button>
    {packages.map(pack => {
      const current = clientPluginLoader.current(pack.manifest.id)
      const snapshot = pluginRuntime.list().find(p => p.manifest.id === pack.manifest.id)
      const active = snapshot?.status === 'active'
      const update = current && current.digest !== pack.digest
      return <div className="draft-card" key={pack.manifest.id} data-client-plugin={pack.manifest.id}>
        <strong>{pack.manifest.displayName}</strong>
        <small>{pack.manifest.id} · 已安装 {pack.manifest.version} · {active ? `运行中 ${current?.manifest.version}` : snapshot?.status === 'failed' ? '运行失败' : '未运行'}</small>
        <small>SHA-256 {pack.digest.slice(0, 16)}… · 完整客户端信任</small>
        {snapshot?.error && <p role="alert">{snapshot.error}</p>}
        <div className="draft-actions">
          {(!active || update) && <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
            const approved = await window.moreThanChat.authorizeClientPlugin(pack.manifest.id, pack.digest)
            if (!approved) {setNotice('已取消，未运行新代码'); return}
            await clientPluginLoader.enable(approved)
            setNotice('已运行；如界面异常，按 Ctrl+Shift+F12 恢复。')
          })}>{update ? '确认热更新' : '确认运行'}</button>}
          {current && <button className="secondary-button" disabled={busy || !active && snapshot?.status !== 'failed'} onClick={() => void run(async () => {
            await clientPluginLoader.disable(pack.manifest.id); setNotice('已停用，并清理登记的界面、事件与定时器。')
          })}>停用界面插件</button>}
        </div>
      </div>
    })}
    {notice && <p role="status" className="settings-note">{notice}</p>}
  </section>
}
