import { useRef, useState } from 'react'
import { Bell, BellOff, PanelBottomClose } from 'lucide-react'
import type { DesktopSettings as Settings, DesktopPreferences } from './global'
import { useLiveSnapshot } from './use-live-snapshot'

export function DesktopSettings() {
  const snapshot=useLiveSnapshot<Settings>(()=>window.moreThanChat.getDesktopSettings(),listener=>window.moreThanChat.onDesktopSettings(listener))
  const settings=snapshot.value
  const [working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [confirmQuit,setConfirmQuit]=useState(false),running=useRef(false)
  const busy=working||snapshot.loading
  async function run(work:()=>Promise<unknown>){if(running.current)return;running.current=true;setWorking(true);setError('');setNotice('');try{await work()}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{running.current=false;setWorking(false)}}
  const change=(key:keyof DesktopPreferences,value:boolean)=>run(async()=>{
    await window.moreThanChat.configureDesktop({[key]:value})
    // Re-read authoritative state; a late command response must not replace a newer push.
    await snapshot.refresh()
  })
  return <section className="desktop-settings" aria-labelledby="desktop-settings-heading">
    <div className="settings-section-heading"><h3 id="desktop-settings-heading">通知与后台</h3><span>按你的节奏接收消息</span></div>
    {snapshot.error&&<div className="settings-recovery"><p className="settings-error" role="alert">通知设置读取失败：{snapshot.error}</p><button type="button" className="secondary-button" disabled={busy} onClick={()=>void snapshot.refresh()}>重新读取通知设置</button></div>}
    {!settings?(snapshot.loading&&<p className="settings-note" role="status">正在读取设置…</p>):<>
      {([
        ['notifications','新消息通知','窗口不在前台时提醒；免打扰会话不弹通知。',false],
        ['preview','显示消息预览','在系统通知中显示会话名称和消息内容。',!settings.preferences.notifications],
        ['sound','通知声音','使用系统通知声音，遵循系统勿扰设置。',!settings.preferences.notifications],
        ['closeToTray','关闭窗口后继续接收','收进系统托盘；彻底退出请使用托盘菜单或下方退出按钮。',!settings.trayAvailable],
      ] as const).map(([key,label,detail,disabled])=><label className="desktop-option" key={key}><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" data-desktop-option={key} checked={settings.preferences[key]} disabled={busy||disabled} onChange={e=>void change(key,e.target.checked)}/></label>)}
      {!settings.notificationsSupported&&<p className="settings-note"><BellOff size={14}/> 当前系统不支持桌面通知，仍可通过未读数查看新消息。</p>}
      {!settings.trayAvailable&&<p className="settings-note">系统托盘不可用，关闭窗口仍会退出。</p>}
      <div className="desktop-actions">
        <button className="secondary-button" type="button" disabled={busy||!settings.notificationsSupported||!settings.preferences.notifications} onClick={()=>void run(async()=>{await window.moreThanChat.testNotification();setNotice('已请求系统通知。未出现时，请检查系统通知权限或勿扰设置。')})}><Bell size={14}/>测试通知</button>
        <button className="secondary-button" type="button" data-hide-to-tray disabled={busy||!settings.trayAvailable} onClick={()=>void run(()=>window.moreThanChat.hideToTray())}><PanelBottomClose size={14}/>收起到托盘</button>
        <button className="secondary-button" type="button" data-quit-app disabled={busy} onClick={()=>setConfirmQuit(true)}>退出应用</button>
      </div>
      {confirmQuit&&<div className="danger-confirm" role="group" aria-label="确认退出应用"><p>退出后，这台设备将停止收取消息。</p><small>已加入本机发送队列的消息会保留，下次启动并连接原服务器后继续发送。若只想隐藏窗口，可收起到托盘。</small><div><button type="button" className="secondary-button" disabled={busy} onClick={()=>setConfirmQuit(false)}>继续使用</button><button type="button" className="primary-button" data-confirm-quit-app disabled={busy} onClick={()=>void run(async()=>{await window.moreThanChat.quitApp();setConfirmQuit(false)})}>确认退出</button></div></div>}
      {(error||settings.error)&&<p className="settings-error" role="alert">{error||settings.error}</p>}
      {notice&&<p className="settings-note" role="status">{notice}</p>}
    </>}
  </section>
}
