import * as React from 'react'
import { appApi } from './app-api'
import { chatSdk } from './chat-sdk'
import { useEffect, useState } from 'react'
import type { InstalledClientPackage } from '@more-than-chat/plugin-runtime'
import type { PluginDraftSummary } from '@more-than-chat/protocol'
import { pluginRuntime } from './plugin-host'
import { ClientPluginLoader, importClientModule } from './client-plugin-loader'
import { ClientPluginController } from './client-plugin-controller'
import type { ServerSnapshot } from '@more-than-chat/central-protocol'
import { ShareClientPlugin, SharedPluginChoices } from './SharedClientPlugins'
import { PluginExamples } from './PluginExamples'
import { prepareExample } from './bundled-examples'

let loader: ClientPluginLoader | undefined
export function getClientPluginLoader(): ClientPluginLoader {
  return loader ??= new ClientPluginLoader(pluginRuntime, Object.freeze({version: 1, React, chat:chatSdk, get app() {return appApi}}), importClientModule)
}
const changed = () => window.dispatchEvent(new Event('client-plugins-changed'))
const errorText = (error: unknown) => error instanceof Error ? error.message : '插件操作失败'
export function ManagePluginButton({request,label}: {request:import('@more-than-chat/protocol').PluginManagementRequest;label:string}) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  return <span><button className="secondary-button" data-plugin-manage disabled={busy} onClick={async()=>{
    setBusy(true);setNotice('')
    try {const result=await window.moreThanChat.managePlugins(request);setNotice(result.summary)}
    catch(error){setNotice(errorText(error))}finally{setBusy(false);window.dispatchEvent(new Event('local-plugins-managed'))}
  }}>{busy?'处理中…':label}</button>{notice&&<small role="status">{notice}</small>}</span>
}
let controller: ClientPluginController | undefined
export function getClientPluginController(): ClientPluginController {
  return controller ??= new ClientPluginController(getClientPluginLoader(), window.moreThanChat, changed)
}

export function InstallClientDraft({draft,snapshot}: {draft: PluginDraftSummary;snapshot:ServerSnapshot|null}) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  return <div>
    <button className="secondary-button" data-client-install disabled={busy || !draft.ok} onClick={async () => {
      setBusy(true)
      try {
        const pack = await window.moreThanChat.installClientDraft(draft.id, draft.revision)
        if (pack) {await getClientPluginController().apply(pack); setNotice('已安装并启用，新版本已生效。')}
      } catch (error) {setNotice(errorText(error))} finally {setBusy(false)}
    }}>{busy ? '正在应用…' : '安装并启用此版本'}</button>
    <p className="settings-note">插件可修改客户端界面，请使用可信来源。</p>
    {notice && <p role="status" className="settings-note">{notice}</p>}
    <ShareClientPlugin snapshot={snapshot} draft={draft}/>
  </div>
}

export function ClientPlugins({snapshot:serverSnapshot}:{snapshot:ServerSnapshot|null}) {
  const clientPluginLoader = getClientPluginLoader()
  const clientPluginController = getClientPluginController()
  const [packages, setPackages] = useState<InstalledClientPackage[]>([])
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [, refresh] = useState(0)
  useEffect(() => {
    let alive = true, request = 0
    const reload = () => {
      const current = ++request
      if (alive) refresh(value => value + 1)
      void window.moreThanChat.getClientPlugins().then(list => {
        if (alive && request === current) setPackages(list)
      }).catch(error => {if (alive && request === current) setNotice(errorText(error))})
    }
    reload(); window.addEventListener('client-plugins-changed', reload)
    const off = pluginRuntime.subscribe(() => refresh(value => value + 1))
    return () => {alive = false; window.removeEventListener('client-plugins-changed', reload); off()}
  }, [])
  async function run(work: () => Promise<void>) {
    setBusy(true); setNotice('')
    try {await work()} catch (error) {setNotice(errorText(error))} finally {setBusy(false)}
  }
  return <section className="draft-section" data-client-plugins>
    <PluginExamples packages={packages} busy={busy} onInstall={example=>void run(async()=>{
      // A catalog is a starter, never an automatic overwrite of a user's edited copy.
      if((await window.moreThanChat.getClientPlugins()).some(p=>p.manifest.id===example.id))throw new Error('此插件已经安装，请在下方管理。')
      await clientPluginController.apply(await prepareExample(example))
      setNotice(example.name+'已启用。关闭插件面板，在聊天顶部打开。')
    })} onCopy={example=>void run(async()=>{
      const source=(await window.moreThanChat.getClientPlugins()).find(p=>p.manifest.id===example.id)??example.pack
      const manifest={...source.manifest,id:example.id+'.copy-'+crypto.randomUUID().slice(0,8),version:'1.0.0',displayName:example.name+' · 我的版本'}
      const result=await window.moreThanChat.createPluginDraft({manifestJson:JSON.stringify(manifest),source:JSON.stringify(source.program)})
      if(!result.persisted)throw new Error(result.summary)
      window.dispatchEvent(new Event('local-plugins-managed'))
      setNotice('已复制为草稿 '+manifest.id+'。可以告诉内置 AI：读取这份草稿，按我的要求修改。原插件不受影响。')
    })}/>
    {notice && <p role="status" className="settings-note" data-client-plugin-notice>{notice}</p>}
    <h3>可执行界面</h3>
    <p className="settings-note">插件可修改整个客户端界面，请使用可信来源。启用状态会保留，同 ID 新版本直接热更新。</p>
    <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
      const pack = await window.moreThanChat.importClientPlugin()
      if (pack) {await clientPluginController.apply(pack); setNotice('已安装并启用，新版本已生效。')}
    })}>导入并启用界面插件</button>
    {packages.map(pack => {
      const current = clientPluginLoader.current(pack.manifest.id)
      const snapshot = pluginRuntime.list().find(p => p.manifest.id === pack.manifest.id)
      const active = snapshot?.status === 'active'
      const update = current && current.digest !== pack.digest
      return <div className="draft-card" key={pack.manifest.id} data-client-plugin={pack.manifest.id}>
        <strong>{pack.manifest.displayName}</strong>
        <small>{pack.manifest.id} · 已安装 {pack.manifest.version} · {active ? `运行中 ${current?.manifest.version}` : snapshot?.status === 'failed' ? '运行失败' : '未运行'}</small>
        {clientPluginController.errors.has(pack.manifest.id) && <p role="alert">{clientPluginController.errors.get(pack.manifest.id)}</p>}
        {snapshot?.error && <p role="alert">{snapshot.error}</p>}
        <div className="draft-actions">
          {(!active || update) && <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
            await clientPluginController.enableInstalled(pack)
            setNotice('已启用。')
          })}>{update ? '应用更新' : '启用'}</button>}
          {(current || pack.enabled) && <button className="secondary-button" disabled={busy || !active && !pack.enabled && snapshot?.status !== 'failed'} onClick={() => void run(async () => {
            await clientPluginController.disable(pack); setNotice('已停用。')
          })}>停用界面插件</button>}
          <button className="secondary-button" data-client-uninstall disabled={busy} onClick={()=>void run(async()=>{
            await clientPluginController.uninstall(pack.manifest.id,pack.manifest.version);setNotice('已卸载本机插件，草稿与群内分享保留。')
          })}>卸载</button>
        </div>
        <ShareClientPlugin snapshot={serverSnapshot} pack={pack}/>
      </div>
    })}
    <p className="settings-note">界面异常时可按 Ctrl+Shift+F12 停用界面插件并重新打开聊天。已保存数据不变，未发送输入可能丢失。</p>
    <SharedPluginChoices snapshot={serverSnapshot} onError={setNotice}/>
  </section>
}
