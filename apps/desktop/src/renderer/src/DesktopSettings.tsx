import { useEffect, useState } from 'react'
import { Bell, BellOff, PanelBottomClose } from 'lucide-react'
import type { DesktopSettings as Settings, DesktopPreferences } from './global'

export function DesktopSettings() {
  const [settings,setSettings]=useState<Settings|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  useEffect(()=>{
    let live=true,changed=false
    const stop=window.moreThanChat.onDesktopSettings(value=>{changed=true;if(live)setSettings(value)})
    void window.moreThanChat.getDesktopSettings().then(value=>{if(live&&!changed)setSettings(value)}).catch(()=>{if(live)setError('通知设置暂不可用')})
    return()=>{live=false;stop()}
  },[])
  async function run(work:()=>Promise<unknown>){setBusy(true);setError('');setNotice('');try{await work()}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}}
  const change=(key:keyof DesktopPreferences,value:boolean)=>run(async()=>setSettings(await window.moreThanChat.configureDesktop({[key]:value})))
  return <section className="desktop-settings" aria-labelledby="desktop-settings-heading">
    <div className="settings-section-heading"><h3 id="desktop-settings-heading">通知与后台</h3><span>按你的节奏接收消息</span></div>
    {!settings?<p className="settings-note">{error||'正在读取设置…'}</p>:<>
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
        <button className="secondary-button" type="button" data-quit-app disabled={busy} onClick={()=>void run(()=>window.moreThanChat.quitApp())}>退出应用</button>
      </div>
      {(error||settings.error)&&<p className="settings-error" role="alert">{error||settings.error}</p>}
      {notice&&<p className="settings-note" role="status">{notice}</p>}
    </>}
  </section>
}
