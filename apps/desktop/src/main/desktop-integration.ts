import { app, Menu, nativeImage, Notification, Tray, type BrowserWindow } from 'electron'
import { ChatNotifications, unreadCount, type IncomingNotice, type NotificationCard } from './chat-notifications'
import { DesktopPreferenceStore } from './desktop-preferences'
import type { CentralClient } from './central-client'
import type { ChatStore } from './chat-store'

interface Ports {
  window(): BrowserWindow | null
  store(): ChatStore | null
  central(): CentralClient | null
  open(conversationId?: string): void
  hide(): void
}
export class DesktopIntegration {
  #tray: Tray | null = null
  #unread = 0
  #notificationError: string | null = null
  #test: Notification | null = null
  readonly preferences: DesktopPreferenceStore
  readonly notifications: ChatNotifications
  constructor(directory: string, private readonly ports: Ports) {
    this.preferences = new DesktopPreferenceStore(directory)
    this.notifications = new ChatNotifications({
      preferences: () => this.preferences.get(),
      foreground: () => this.foreground(),
      lookup: notice => {
        const central = ports.central(), store = ports.store()
        if (!central || !store || central.serverId !== notice.serverId) return null
        const message = store.message(notice.messageId)
        const conversation = store.conversation(notice.conversationId)
        if (!message || message.serverId !== notice.serverId || message.conversationId !== notice.conversationId || !conversation) return null
        return { ...notice, title: String(conversation.title), senderName: String(message.senderName), text: String(message.text),
          ...(message.attachment ? { attachment: message.attachment as {mime:string;name:string} } : {}),
          own: message.senderId === central.identity.userId, read: message.readAt !== undefined,
          retracted: Boolean(message.retractedAt), muted: Boolean(conversation.muted), unavailable: Boolean(conversation.unavailable) }
      },
      show: (card, click) => this.#show(card, click),
      openConversation: id => ports.open(id),
      attention: () => ports.window()?.flashFrame(true),
    })
  }
  foreground(): boolean { const window = this.ports.window(); return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused()) }
  get trayAvailable(): boolean { return Boolean(this.#tray && !this.#tray.isDestroyed()) }
  async initialize(): Promise<void> {
    await this.preferences.load()
    try {
      this.#tray = new Tray(trayImage(false))
      this.#tray.on('click', () => this.ports.open())
      this.#tray.on('double-click', () => this.ports.open())
      this.#updateTray()
    } catch { this.#dropTray() }
  }
  snapshot() { return { preferences: this.preferences.get(), trayAvailable: this.trayAvailable, notificationsSupported: Notification.isSupported(), error: this.preferences.error ?? this.#notificationError } }
  publish(): void { const window=this.ports.window();if(window&&!window.isDestroyed())window.webContents.send('app:desktop-changed', this.snapshot()) }
  async configure(value: unknown) {
    await this.preferences.update(value)
    this.notifications.clear(); this.#test?.close(); this.#test = null
    this.publish(); return this.snapshot()
  }
  incoming(notice: IncomingNotice): void { this.notifications.receive(notice) }
  update(value: unknown): void {
    const count = unreadCount(value), window = this.ports.window()
    if (window && !window.isDestroyed()) {
      window.setTitle(count ? `(${count} 条未读) MoreThanChat` : 'MoreThanChat')
      if (!count) window.flashFrame(false)
    }
    if (process.platform !== 'win32') { try { app.setBadgeCount(count) } catch { /* Unsupported desktop shell. */ } }
    if (count !== this.#unread) { this.#unread = count; this.#updateTray() }
    this.notifications.reconcile()
  }
  refresh(): void { this.update(this.ports.store()?.loadView()) }
  #dropTray(): void {
    const tray=this.#tray;this.#tray=null
    try { if(tray&&!tray.isDestroyed())tray.destroy() } catch { /* Shell already gone. */ }
  }
  #updateTray(): void {
    if (!this.trayAvailable) return
    try {
      this.#tray!.setImage(trayImage(this.#unread > 0))
      this.#tray!.setToolTip(this.#unread ? `MoreThanChat · ${this.#unread} 条未读` : 'MoreThanChat')
      this.#tray!.setContextMenu(Menu.buildFromTemplate([
        {label:'打开 MoreThanChat',click:()=>this.ports.open()},
        {label:this.#unread?`${this.#unread} 条未读`:'没有未读消息',enabled:false},
        {type:'separator'},
        {label:'收起到托盘',click:()=>this.ports.hide()},
        {label:'退出 MoreThanChat',click:()=>app.quit()},
      ]))
    } catch {
      // Never hide the only window if its recovery surface has failed.
      this.#dropTray()
      if(this.ports.window()&&!this.ports.window()!.isVisible())this.ports.open()
      this.publish()
    }
  }
  #show(card: NotificationCard, click: () => void): Notification | null {
    if (!Notification.isSupported()) return null
    try {
      const notification = new Notification({ title:card.title, body:card.body, silent:card.silent, icon:trayImage(false) })
      notification.on('click', click)
      notification.on('failed', () => { this.#notificationError = '系统未能显示通知。请检查系统通知权限；未读消息仍保存在客户端。'; this.publish() })
      notification.on('show', () => { if(this.#notificationError){this.#notificationError=null;this.publish()} })
      notification.show()
      return notification
    } catch {
      this.#notificationError = '系统通知暂不可用，消息接收不受影响。'; this.publish(); return null
    }
  }
  testNotification(): void {
    if (!this.preferences.get().notifications) throw new Error('请先开启新消息通知')
    if (!Notification.isSupported()) throw new Error('当前系统不支持桌面通知')
    this.#test?.close()
    this.#test = this.#show({title:'MoreThanChat',body:'这是一条测试通知。点击可回到聊天窗口。',silent:!this.preferences.get().sound,conversationId:''},()=>this.ports.open())
  }
  dispose(): void {
    this.notifications.clear(); this.#test?.close(); this.#test=null
    this.#dropTray()
  }
}

// A small code-native icon, with a distinct unread dot. No downloaded assets.
function trayImage(unread: boolean) {
  const size=32, pixels=Buffer.alloc(size*size*4)
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const cornerX=Math.max(5-x,0,x-26),cornerY=Math.max(5-y,0,y-26)
    if(cornerX*cornerX+cornerY*cornerY>25)continue
    let [r,g,b]=[192,104,71]
    if((x>=7&&x<=24&&y>=8&&y<=21)||(x>=9&&x<=14&&y>=21&&y<=25&&x+y<=35))[r,g,b]=[250,249,246]
    if((y===13||y===17)&&x>=11&&x<=21)[r,g,b]=[192,104,71]
    if(unread&&(x-25)**2+(y-7)**2<=30)[r,g,b]=[110,185,162]
    const offset=(y*size+x)*4;pixels[offset]=b;pixels[offset+1]=g;pixels[offset+2]=r;pixels[offset+3]=255
  }
  return nativeImage.createFromBitmap(pixels,{width:size,height:size})
}
