import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  safeStorage,
  clipboard,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { EncryptedCredentialStore } from './credential-store'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createElectronHostProcessFactory } from './electron-host-process'
import { resolveHostEntry } from './host-entry'
import { HostSupervisor } from './host-supervisor'
import { toClientModelEvent } from './model-client-event'
import { ChatStore } from './chat-store'
import { CentralClient } from './central-client'
import { ClientIdentity } from './identity-store'
import { activeProfile, profilePath, listProfiles, restoreProfile, selectProfile } from './identity-profiles'
import { AttachmentStore } from './attachments'
import { createHostRequest, parseHostMessage, parsePluginManagementRequest, type PluginManagementRequest, type PluginManagementResult } from '@more-than-chat/protocol'
import { DesktopIntegration } from './desktop-integration'
import { exportHistory, restoreHistory } from './history-transfer'
import { createHash } from 'node:crypto'
import { parseGroupArtifact, parseGroupPluginPack, pluginScopeMembers, UI_SLOTS, type UiSlot } from '@more-than-chat/central-protocol'
import { GroupPluginConsentStore } from './group-plugin-consent'
import { ClientPluginStore, clientPackageDigest } from './client-plugins'
import { parseExecutableClientPackage } from '@more-than-chat/plugin-runtime'

let chatStore: ChatStore | null = null
let mainWindow: BrowserWindow | null = null
let hostSupervisor: HostSupervisor | null = null
let hostStatusCleanup: (() => void) | null = null
let hostEventCleanup: (() => void) | null = null
let quitAfterHostStops = false
let quitRequested = false
let centralClient: CentralClient | null = null
let attachmentStore: AttachmentStore | null = null
let centralCleanup: (() => void)[] = []
let pendingProfile: string | null = null
let identityBusy = false
let desktop: DesktopIntegration | null = null
let hideRequested = false
let pendingNavigation: {id:string;conversationId:string} | null = null
let openingWindow: Promise<void> | null = null
let desktopReady = false
let pendingShow = false
let windowClosing = false
let historyTransferStatus = {busy:false,stage:''}
function setHistoryTransferStatus(busy:boolean,stage:string):void {
  historyTransferStatus={busy,stage}
  if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('history:status-changed',historyTransferStatus)
}
async function flushHistorySource():Promise<void> {
  const window=mainWindow
  if(!window||window.isDestroyed())throw new Error('聊天窗口尚未就绪')
  await new Promise<void>((resolve,reject)=>{
    const token=crypto.randomUUID(),timer=setTimeout(()=>{cleanup();reject(new Error('聊天保存尚未完成，请稍后重试'))},10000)
    const cleanup=()=>{clearTimeout(timer);ipcMain.removeListener('chat:state:flushed',acknowledged)}
    const acknowledged=(event:IpcMainEvent,reply:unknown)=>{
      const result=reply as {token?:unknown;ok?:unknown}|null
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||result?.token!==token)return
      cleanup();if(result.ok===true)resolve();else reject(new Error('本机保存失败，历史操作已取消，原数据保留'))
    }
    ipcMain.on('chat:state:flushed',acknowledged)
    window.webContents.send('chat:state:flush',token)
  })
  if(chatStore?.hasActiveLocalTurns())throw new Error('请先等待当前 AI 回复结束或停止生成，再备份/恢复聊天记录')
}
function openChatWindow(conversationId?: string): void {
  if(quitRequested||quitAfterHostStops)return
  // A second launch can arrive while identity/store/IPC initialization is still pending.
  if(!desktopReady){pendingShow=true;return}
  if(conversationId){
    const conversation=chatStore?.conversation(conversationId)
    if(!conversation||conversation.unavailable)return
    pendingNavigation={id:crypto.randomUUID(),conversationId}
    centralClient?.setReadingConversation(null)
  }
  if(!mainWindow||mainWindow.isDestroyed()){
    openingWindow ??= createWindow().finally(()=>{openingWindow=null})
    void openingWindow.catch(()=>dialog.showErrorBox('无法打开窗口','本机数据已保留，请退出后重新启动。'))
    return
  }
  if(pendingNavigation)mainWindow.webContents.send('app:open-conversation',pendingNavigation)
  if(mainWindow.isMinimized())mainWindow.restore()
  mainWindow.show();mainWindow.focus()
}
function hideChatWindow(): void {
  if(!desktop?.trayAvailable)throw new Error('系统托盘不可用，窗口保持打开')
  if(mainWindow&&!mainWindow.isDestroyed()){hideRequested=true;mainWindow.close()}
}

const systemCipher = {
  available: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' ||
      safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (value: string) => safeStorage.encryptString(value),
  decrypt: (value: Buffer) => safeStorage.decryptString(value),
}

if (process.env.MTC_SCREENSHOT_PATH || process.env.MTC_QA_MODE === '1') {
  app.setPath(
    'userData',
    process.env.MTC_QA_USER_DATA_DIR ||
      path.join(app.getPath('temp'), 'MoreThanChat-QA'),
  )
}

if (!app.requestSingleInstanceLock()) app.exit(0)
if(process.platform==='win32')app.setAppUserModelId('dev.morethanchat.desktop')
const profileRoot = app.getPath('userData')
let currentProfile = 'default'
try {
  currentProfile = activeProfile(profileRoot)
} catch {
  dialog.showErrorBox('身份空间无法打开', '选中的身份数据缺失或配置损坏。原数据已保留，请检查身份目录。')
  app.exit(1)
}
const dataDirectory = profilePath(profileRoot, currentProfile)
const groupConsent = new GroupPluginConsentStore(dataDirectory)
const clientPlugins = new ClientPluginStore(dataDirectory)
let clientPluginBusy = false
let recoveryPending = false
async function recoverClientInterface(): Promise<void> {
  if (recoveryPending || quitRequested || !mainWindow || mainWindow.isDestroyed()) return
  recoveryPending = true
  const window = mainWindow
  try {
    await clientPlugins.disableAll()
    await groupConsent.disableExecutable()
    centralClient?.setReadingConversation(null)
    // A fresh WebContents avoids the crash/reload race. Keep the old window until
    // its replacement loads; never leave the application without a live window.
    await createWindow(window)
    if (!window.isDestroyed()) window.destroy()
  } finally { recoveryPending = false }
}
function requestInterfaceRecovery(): void {
  void recoverClientInterface().catch(error => {
    console.error('[renderer] Interface restart failed:', error)
    dialog.showErrorBox('界面重新打开失败', '聊天数据未删除。请退出后重新启动应用。')
  })
}
app.on('second-instance', () => openChatWindow())

async function manageClientPlugins(request: PluginManagementRequest): Promise<PluginManagementResult> {
  if (request.target !== 'client') throw new Error('仅允许本机界面插件管理')
  if (request.action === 'list') return {summary:'本机可执行界面插件列表。',plugins:(await clientPlugins.list()).map(p=>({id:p.manifest.id,version:p.manifest.version,displayName:p.manifest.displayName,target:'client',enabled:p.enabled===true,removable:true}))}
  if (request.action !== 'uninstall') throw new Error('无效管理操作')
  const window=mainWindow
  if (!window || window.isDestroyed()) throw new Error('请先打开客户端窗口再卸载')
  await new Promise<void>((resolve,reject)=>{
    const token=crypto.randomUUID()
    const cleanup=()=>{clearTimeout(timer);ipcMain.removeListener('client-plugins:removed',ack)}
    const ack=(event:IpcMainEvent,result:unknown)=>{
      const value=result as {token?:unknown;ok?:unknown;error?:unknown}|null
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||value?.token!==token)return
      cleanup(); if(value.ok===true)resolve(); else reject(new Error(typeof value.error==='string'?value.error.slice(0,200):'卸载未完成，请检查插件列表'))
    }
    const timer=setTimeout(()=>{cleanup();reject(new Error('卸载响应超时，请检查插件列表；不会自动重复操作'))},10000)
    ipcMain.on('client-plugins:removed',ack)
    window.webContents.send('client-plugins:remove-request',{token,id:request.id,version:request.version})
  })
  return {summary:'本机界面插件已卸载并清理运行贡献。草稿和群内分发不受影响。',plugins:[]}
}

function registerIpc(): void {
  const clientTask = async <T,>(work: () => Promise<T>): Promise<T> => {
    if (clientPluginBusy || identityBusy || windowClosing || quitRequested || recoveryPending) throw new Error('已有插件或窗口操作正在进行')
    clientPluginBusy = true
    try { return await work() } finally { clientPluginBusy = false }
  }
  ipcMain.handle('client-plugins:list', event => {assertTrustedIpc(event); return clientPlugins.list()})
  ipcMain.handle('client-plugins:remove', (event, value:unknown) => {
    assertTrustedIpc(event)
    const request=parsePluginManagementRequest(value)
    if(request.action!=='uninstall'||request.target!=='client')throw new Error('无效卸载请求')
    return clientTask(()=>clientPlugins.remove(request.id,request.version))
  })
  ipcMain.handle('host:plugins:manage', (event,value:unknown) => {
    assertTrustedIpc(event)
    if(!hostSupervisor)throw new Error('PC Host 尚未就绪')
    return hostSupervisor.managePlugins(parsePluginManagementRequest(value))
  })
  ipcMain.handle('client-plugins:import', event => {
    assertTrustedIpc(event)
    return clientTask(async () => {
      const result = await dialog.showOpenDialog(mainWindow!, {title: '导入可执行界面插件包', properties: ['openFile'], filters: [{name: 'MoreThanChat 界面插件', extensions: ['mtcplugin', 'json']}]})
      if (result.canceled || !result.filePaths[0]) return null
      const pack = await clientPlugins.readFile(result.filePaths[0])
      return {...pack, digest: clientPackageDigest(pack)}
    })
  })
  ipcMain.handle('client-plugins:install-draft', (event, payload) => {
    assertTrustedIpc(event)
    return clientTask(async () => {
      if (!hostSupervisor) throw new Error('PC Host 尚未就绪')
      const request = parseHostMessage(createHostRequest('pluginDrafts.exportClient', 'ipc', payload))
      if (request.kind !== 'request' || request.method !== 'pluginDrafts.exportClient') throw new Error('无效草稿')
      const draft = await hostSupervisor.exportClientDraft(request.payload.draftId, request.payload.revision)
      const pack = parseExecutableClientPackage({manifest: JSON.parse(draft.manifestJson), program: JSON.parse(draft.source)})
      return {...pack, digest: clientPackageDigest(pack)}
    })
  })
  ipcMain.handle('client-plugins:save', (event, value: unknown, enabled: unknown) => {
    assertTrustedIpc(event)
    return clientTask(async () => {
      if (!value || typeof value !== 'object' || typeof enabled !== 'boolean') throw new Error('插件状态无效')
      const v = value as Record<string, unknown>
      const pack = parseExecutableClientPackage({manifest: v.manifest, program: v.program})
      if (v.digest !== clientPackageDigest(pack)) throw new Error('插件内容与摘要不匹配')
      return clientPlugins.save(pack, enabled)
    })
  })
  ipcMain.handle('client-plugins:recover', event => {
    assertTrustedIpc(event)
    // Acknowledge before replacing the caller's WebContents.
    setImmediate(requestInterfaceRecovery)
  })
  const historyTask=async<T,>(password:unknown,work:(password:string)=>Promise<T>):Promise<T>=>{
    if(typeof password!=='string'||password.length<12||password.length>256||!password.trim())throw new Error('备份密码需要 12–256 个字符')
    if(historyTransferStatus.busy||identityBusy||quitRequested||windowClosing)throw new Error('已有历史、身份或窗口关闭操作正在进行，请稍后重试')
    if(!chatStore||!centralClient||!attachmentStore||!mainWindow)throw new Error('本机身份与聊天存储尚未就绪')
    setHistoryTransferStatus(true,'保存当前聊天…')
    try{await flushHistorySource();return await work(password)}finally{setHistoryTransferStatus(false,'')}
  }
  const historyContext=()=>({directory:dataDirectory,store:chatStore!,identity:centralClient!.identity,attachments:attachmentStore!,progress:(stage:string)=>setHistoryTransferStatus(true,stage),beforeCommit:flushHistorySource})
  ipcMain.handle('history:status',event=>{assertTrustedIpc(event);return historyTransferStatus})
  ipcMain.handle('history:export',async(event,password:unknown)=>{
    assertTrustedIpc(event)
    return historyTask(password,async password=>{
      const chosen=await dialog.showSaveDialog(mainWindow!,{title:'保存加密聊天记录备份',defaultPath:`MoreThanChat-history-${centralClient!.identity.userId.slice(-8)}-${new Date().toISOString().slice(0,10)}.mtchistory`,filters:[{name:'加密聊天记录',extensions:['mtchistory']}]})
      if(chosen.canceled||!chosen.filePath)return null
      return exportHistory(historyContext(),chosen.filePath,password)
    })
  })
  ipcMain.handle('history:import',async(event,password:unknown)=>{
    assertTrustedIpc(event)
    return historyTask(password,async password=>{
      const chosen=await dialog.showOpenDialog(mainWindow!,{title:'选择本身份的聊天记录备份',properties:['openFile'],filters:[{name:'加密聊天记录',extensions:['mtchistory']}]})
      if(chosen.canceled||!chosen.filePaths[0])return null
      const result=await restoreHistory(historyContext(),chosen.filePaths[0],password,async info=>{
        const choice=await dialog.showMessageBox(mainWindow!,{type:'question',message:'合并这些聊天记录？',detail:`备份时间：${new Date(info.createdAt).toLocaleString()}\n${info.conversations} 个会话，${info.messages} 条消息，${info.attachments} 个附件。\n\n现有记录优先，撤回状态优先，不新增好友或群，不自动重发旧消息。身份、API 密钥、插件和当前设备设置保持不变。`,buttons:['取消','合并历史记录'],defaultId:0,cancelId:0})
        return choice.response===1
      })
      if(result){
        const state=chatStore!.loadView()
        desktop?.update(state)
        mainWindow!.webContents.send('central:chat',{...state,historyImported:true})
      }
      return result
    })
  })
  ipcMain.handle('app:desktop-settings',event=>{assertTrustedIpc(event);return desktop?.snapshot()})
  ipcMain.handle('app:desktop-configure',(event,value:unknown)=>{assertTrustedIpc(event);if(!desktop)throw new Error('设置尚未就绪');return desktop.configure(value)})
  ipcMain.handle('app:notification-test',event=>{assertTrustedIpc(event);desktop?.testNotification()})
  ipcMain.handle('app:hide-to-tray',event=>{assertTrustedIpc(event);hideChatWindow()})
  ipcMain.handle('app:quit',event=>{assertTrustedIpc(event);app.quit()})
  ipcMain.handle('app:pending-navigation',event=>{assertTrustedIpc(event);return pendingNavigation})
  ipcMain.handle('app:navigation-applied',(event,id:unknown)=>{assertTrustedIpc(event);if(typeof id==='string'&&pendingNavigation?.id===id)pendingNavigation=null})
  ipcMain.handle('identity:profiles', async event => {
    assertTrustedIpc(event)
    return { current: currentProfile, profiles: await listProfiles(profileRoot, systemCipher) }
  })
  const identityTask = async <T,>(fn:()=>Promise<T>):Promise<T> => {
    if(identityBusy||historyTransferStatus.busy)throw new Error('身份或历史操作正在进行')
    identityBusy=true
    try{return await fn()}finally{identityBusy=false}
  }
  ipcMain.handle('identity:backup', async (event,password:unknown) => {
    assertTrustedIpc(event)
    return identityTask(async()=>{
      if(!centralClient||!mainWindow||typeof password!=='string')throw new Error('身份尚未就绪')
      const backup=await centralClient.identity.backup(password)
      const chosen=await dialog.showSaveDialog(mainWindow,{title:'保存加密身份备份',defaultPath:'MoreThanChat-'+centralClient.identity.userId.slice(-8)+'.mtcidentity',filters:[{name:'加密身份备份',extensions:['mtcidentity']}]})
      if(chosen.canceled||!chosen.filePath)return false
      try{await writeFile(chosen.filePath,backup,{flag:'wx',mode:0o600})}
      catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('该文件已存在，请换一个备份文件名');throw new Error('备份未能保存，请检查目录权限与磁盘空间')}
      return true
    })
  })
  ipcMain.handle('identity:restore', async (event,password:unknown) => {
    assertTrustedIpc(event)
    return identityTask(async()=>{
      if(!mainWindow||typeof password!=='string')throw new Error('无效身份操作')
      const chosen=await dialog.showOpenDialog(mainWindow,{title:'导入加密身份备份',properties:['openFile'],filters:[{name:'加密身份备份',extensions:['mtcidentity']}]})
      if(chosen.canceled||!chosen.filePaths[0])return null
      if((await stat(chosen.filePaths[0])).size>8192)throw new Error('备份文件过大')
      const id=await restoreProfile(profileRoot,await readFile(chosen.filePaths[0],'utf8'),password,systemCipher)
      return {id}
    })
  })
  ipcMain.handle('identity:switch', async (event,id:unknown) => {
    assertTrustedIpc(event)
    return identityTask(async()=>{
      if(typeof id!=='string'||!mainWindow||!(await listProfiles(profileRoot,systemCipher)).some(p=>p.id===id))throw new Error('身份空间不存在')
      if(id===currentProfile)return 'unchanged'
      const result=await dialog.showMessageBox(mainWindow,{type:'question',message:'重启并切换身份？',detail:'当前身份的消息、插件与设置会留在原空间，可随时切回。新导入身份不包含旧设备的本地聊天历史或 API 密钥。',buttons:['取消','重启切换'],defaultId:0,cancelId:0})
      if(result.response===1){pendingProfile=id;app.quit();return 'restarting'}
      return 'cancelled'
    })
  })
  ipcMain.handle('central:devices',event=>{assertTrustedIpc(event);return centralClient?.devices()??[]})
  ipcMain.handle('central:remove-device',async(event,id:unknown)=>{
    assertTrustedIpc(event)
    if(typeof id!=='string'||!centralClient||!mainWindow)throw new Error('无效设备')
    const serverId=centralClient.snapshot().serverId
    const device=(await centralClient.devices()).find(d=>d.id===id&&!d.current)
    if(!device)throw new Error('不能移除此设备')
    const result=await dialog.showMessageBox(mainWindow,{type:'warning',message:'移除设备 '+device.name+'？',detail:'本服将停止向它投递，并清除专门等待它接收的消息。它已保存的本地内容仍会保留。此操作不是身份密钥吊销。',buttons:['取消','移除设备'],defaultId:0,cancelId:0})
    if(result.response===1){
      if(centralClient.snapshot().serverId!==serverId)throw new Error('服务器已切换，请重新查看设备列表')
      await centralClient.removeDevice(id)
      return 'removed'
    }
    return 'cancelled'
  })
  ipcMain.handle('app:window-focused',event=>{assertTrustedIpc(event);return desktop?.foreground()??false})
  ipcMain.handle('app:focus-window',event=>{
    assertTrustedIpc(event)
    openChatWindow()
  })
  ipcMain.handle('chat:set-reading',(event,id:unknown)=>{
    assertTrustedIpc(event)
    if(id!==null&&(typeof id!=='string'||id.length>200))throw new Error('Invalid conversation')
    centralClient?.setReadingConversation(desktop?.foreground()&&(!pendingNavigation||pendingNavigation.conversationId===id) ? id as string|null : null)
    desktop?.notifications.reconcile()
  })
  ipcMain.handle('chat:retry-message',(event,id:unknown)=>{
    assertTrustedIpc(event)
    if(typeof id!=='string'||id.length>200||!centralClient)throw new Error('无效消息')
    return centralClient.retryMessage(id)
  })
  ipcMain.handle('chat:search',(event,input:{query:string;conversationId?:string})=>{
    assertTrustedIpc(event)
    if(!input||typeof input.query!=='string'||input.query.length>200||(input.conversationId!==undefined&&typeof input.conversationId!=='string'))throw new Error('无效搜索条件')
    return chatStore?.searchMessages(input.query,input.conversationId) ?? []
  })
  ipcMain.handle('chat:copy-message',(event,id:unknown)=>{
    assertTrustedIpc(event)
    if(typeof id!=='string')throw new Error('无效消息')
    const message=chatStore?.message(id)
    if(!message)throw new Error('消息不存在')
    clipboard.writeText(String(message.text || (message.attachment as {name?:string}|undefined)?.name || ''))
  })
  ipcMain.handle('chat:message',(event,id:unknown)=>{assertTrustedIpc(event);if(typeof id!=='string'||id.length>256)throw new Error('无效消息');return chatStore?.message(id)??null})
  ipcMain.handle('central:retract',(event,id:unknown)=>{assertTrustedIpc(event);if(typeof id!=='string'||id.length>80||!centralClient)throw new Error('无效撤回');return centralClient.retractMessage(id)})
  ipcMain.handle('central:forward',(event,input:{messageId:string;conversationId:string;clientMessageId:string})=>{assertTrustedIpc(event);if(!centralClient||!input||[input.messageId,input.conversationId,input.clientMessageId].some(v=>typeof v!=='string'||!v||v.length>256))throw new Error('无效转发');return centralClient.forwardMessage(input.messageId,input.conversationId,input.clientMessageId)})
  ipcMain.handle('chat:conversation-options',(event,input:{id:string;patch:Record<string,unknown>})=>{
    assertTrustedIpc(event)
    if(!input||typeof input.id!=='string'||!input.patch||Object.keys(input.patch).some(key=>!['pinned','muted'].includes(key)||typeof input.patch[key]!=='boolean'))throw new Error('无效会话设置')
    const state=chatStore?.load(),conversation=state?.conversations.find(c=>c.id===input.id)
    if(!state||!conversation)throw new Error('会话不存在')
    Object.assign(conversation,input.patch)
    chatStore!.save(state,undefined,{authoritative:true})
    centralClient?.refreshChat()
    return input.patch
  })
  ipcMain.handle('chat:history',(event,input:{conversationId:string;before?:number;after?:number;around?:string;limit?:number})=>{
    assertTrustedIpc(event)
    if(!input||typeof input.conversationId!=='string'||!chatStore)throw new Error('无效历史请求')
    return chatStore.messagePage(input.conversationId,input)
  })
  ipcMain.handle('app:appearance', (event, theme: unknown) => {
    assertTrustedIpc(event)
    if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid appearance')
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return
    const background = theme === 'dark' ? '#24283b' : '#faf9f6'
    const chrome = theme === 'dark' ? '#1f2335' : '#f0eee8'
    window.setBackgroundColor(background)
    if (process.platform !== 'darwin')
      window.setTitleBarOverlay({ color: chrome, symbolColor: theme === 'dark' ? '#a9b1d6' : '#62645c', height: 38 })
  })
  ipcMain.handle('central:state', (event) => {
    assertTrustedIpc(event)
    if (!centralClient) throw new Error('本机身份加密不可用')
    return centralClient.snapshot()
  })
  ipcMain.handle('central:copy-id',event=>{assertTrustedIpc(event);if(!centralClient)throw new Error('身份尚未准备好');clipboard.writeText(centralClient.identity.userId)})
  ipcMain.handle(
    'central:plugin-inbox',
    (event, input: { groupId: string; pluginId: string }) => {
      assertTrustedIpc(event)
      if (
        !centralClient ||
        !input ||
        typeof input.groupId !== 'string' ||
        typeof input.pluginId !== 'string'
      )
        throw new Error('无效插件收件箱')
      return centralClient.pluginInbox(input.groupId, input.pluginId)
    },
  )
  ipcMain.handle(
    'central:connect',
    (event, input: { address: string; displayName: string }) => {
      assertTrustedIpc(event)
      if (
        !centralClient ||
        !input ||
        typeof input.address !== 'string' ||
        typeof input.displayName !== 'string'
      )
        throw new Error('无效连接配置')
      return centralClient.connect(input.address, input.displayName)
    },
  )
  ipcMain.handle('central:disconnect', (event) => {
    assertTrustedIpc(event)
    return centralClient?.disconnect()
  })
  ipcMain.handle(
    'central:action',
    async (event, input: { route: string; data: unknown }) => {
      assertTrustedIpc(event)
      if (
        !centralClient ||
        !input ||
        ![
          'friends/request',
          'friends/accept',
          'friends/reject',
          'friends/cancel',
          'friends/remove',
          'groups',
          'groups/invite',
          'groups/join',
          'groups/accept',
          'groups/reject',
          'groups/rename',
          'groups/kick',
          'groups/transfer',
          'groups/leave',
          'groups/dissolve',
          'plugins/submit',
          'plugins/review',
          'plugins/event',
        ].includes(input.route)
      )
        throw new Error('不允许的中心服务操作')
      const client=centralClient, snapshot=client.snapshot()
      if (input.route==='plugins/event') {
        const data=input.data as {groupId?:string;pluginId?:string;digest?:string;serverId?:string}|null
        const plugin=snapshot.directory?.plugins.find(p=>p.groupId===data?.groupId&&p.pack.id===data?.pluginId&&p.status==='approved')
        if (!plugin || !snapshot.serverId || await groupConsent.get(snapshot,plugin.groupId,plugin.pack.id,plugin.digest)!=='loaded') throw new Error('请先确认在本机载入此版本的群插件')
        if (['declarative','executable'].includes(plugin.pack.kind)&&data?.digest!==plugin.digest) throw new Error('插件版本已改变')
        if (plugin.pack.kind==='executable'&&data?.serverId!==snapshot.serverId) throw new Error('插件服务器已改变')
        if (client!==centralClient||client.serverId!==snapshot.serverId) throw new Error('中心服务器已切换')
      }
      return client.action(input.route, input.data)
    },
  )
  ipcMain.handle('central:plugin-consent', async (event, input) => {
    assertTrustedIpc(event)
    if (!centralClient||!input||typeof input.groupId!=='string'||typeof input.pluginId!=='string'||typeof input.digest!=='string') throw new Error('无效插件授权')
    const client=centralClient, snapshot=client.snapshot()
    if (input.decision!==undefined) await groupConsent.set(snapshot,input.groupId,input.pluginId,input.digest,input.decision)
    if (client!==centralClient||client.serverId!==snapshot.serverId) throw new Error('中心服务器已切换')
    const decision=await groupConsent.get(client.snapshot(),input.groupId,input.pluginId,input.digest)
    if (input.decision!==undefined&&mainWindow&&!mainWindow.isDestroyed()) mainWindow.webContents.send('central:plugin-consent-changed',{groupId:input.groupId,pluginId:input.pluginId,digest:input.digest})
    return decision
  })
  ipcMain.handle('central:submit-draft', async (event, input) => {
    assertTrustedIpc(event)
    if (!centralClient||!hostSupervisor||!input||input.confirmed!==true||typeof input.groupId!=='string'||typeof input.draftId!=='string'||!Number.isSafeInteger(input.revision)||!UI_SLOTS.includes(input.slot)) throw new Error('请明确确认要提交的草稿、版本和群聊')
    const client=centralClient, snapshot=client.snapshot()
    if (snapshot.status!=='connected'||snapshot.serverId!==input.serverId||!snapshot.directory?.groups.some(g=>g.id===input.groupId)) throw new Error('请先连接目标群所在的中心服务器')
    const draft=await hostSupervisor.exportGroupDraft(input.draftId,input.revision)
    const artifact=parseGroupArtifact({manifest:JSON.parse(draft.manifestJson),program:JSON.parse(draft.source)})
    if (client!==centralClient||client.serverId!==snapshot.serverId) throw new Error('中心服务器已切换，提交已取消')
    const hex=createHash('sha256').update(snapshot.userId+':'+artifact.manifest.id).digest('hex').slice(0,32)
    const id='gplugin_'+[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
    const prior=client.snapshot().directory?.plugins.filter(p=>p.groupId===input.groupId&&p.pack.id===id)??[]
    const pack=parseGroupPluginPack({id,version:1+Math.max(0,...prior.map(p=>p.pack.version)),displayName:artifact.manifest.displayName,kind:'declarative',slot:input.slot as UiSlot,artifact})
    return client.action('plugins/submit',{groupId:input.groupId,pack})
  })
  ipcMain.handle('central:share-client-plugin', async (event, input) => {
    assertTrustedIpc(event)
    if (!centralClient || !input || typeof input.groupId!=='string' || typeof input.serverId!=='string') throw new Error('请选择要分享的会话')
    const client=centralClient, snapshot=client.snapshot()
    if (snapshot.status!=='connected'||snapshot.serverId!==input.serverId||!snapshot.directory||!pluginScopeMembers(snapshot.directory,input.groupId).some(m=>m.id===snapshot.userId)) throw new Error('会话或服务器已改变')
    let source
    if (typeof input.draftId==='string' && Number.isSafeInteger(input.revision) && hostSupervisor) {
      const draft=await hostSupervisor.exportClientDraft(input.draftId,input.revision)
      source={manifest:JSON.parse(draft.manifestJson),program:JSON.parse(draft.source)}
    } else if (typeof input.pluginId==='string' && typeof input.digest==='string') {
      const installed=(await clientPlugins.list()).find(p=>p.manifest.id===input.pluginId&&p.digest===input.digest)
      if (!installed) throw new Error('本机插件版本已改变，请刷新后分享')
      source={manifest:installed.manifest,program:installed.program}
    } else throw new Error('请选择已校验的草稿或已安装插件版本')
    const executable=parseExecutableClientPackage(source)
    if (client!==centralClient||client.serverId!==snapshot.serverId) throw new Error('中心服务器已切换')
    const hex=createHash('sha256').update(snapshot.userId+':'+executable.manifest.id).digest('hex').slice(0,32)
    const id='gplugin_'+[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
    const prior=client.snapshot().directory?.plugins.filter(p=>p.groupId===input.groupId&&p.pack.id===id)??[]
    const pack=parseGroupPluginPack({id,version:1+Math.max(0,...prior.map(p=>p.pack.version)),displayName:executable.manifest.displayName,kind:'executable',slot:'chat.details',client:executable})
    return client.action('plugins/submit',{groupId:input.groupId,pack})
  })
  ipcMain.handle(
    'central:send',
    (
      event,
      input: {
        conversationId: string
        clientMessageId: string
        text: string
        attachmentId?: string
        quoteMessageId?: string
      },
    ) => {
      assertTrustedIpc(event)
      if (
        !centralClient ||
        !input ||
        typeof input.conversationId !== 'string' ||
        typeof input.clientMessageId !== 'string' ||
        typeof input.text !== 'string' ||
        (input.attachmentId !== undefined &&
          typeof input.attachmentId !== 'string') || (input.quoteMessageId!==undefined&&(typeof input.quoteMessageId!=='string'||input.quoteMessageId.length>256))
      )
        throw new Error('无效消息')
      return centralClient.send(input)
    },
  )
  ipcMain.handle('attachment:choose', async (event) => {
    assertTrustedIpc(event)
    if (!mainWindow || !attachmentStore) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: '选择要发送的文件（最多 5 MiB）',
    })
    const file = result.filePaths[0]
    if (result.canceled || !file) return null
    const info = await stat(file)
    if (!info.isFile() || info.size > 5 * 1024 * 1024)
      throw new Error('请选择 5 MiB 以内的文件')
    const mime: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.txt': 'text/plain',
      '.pdf': 'application/pdf',
    }
    return attachmentStore.put(
      await readFile(file),
      path.basename(file),
      mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    )
  })
  ipcMain.handle(
    'attachment:voice',
    async (
      event,
      input: { data: string; mime: string; durationMs: number },
    ) => {
      assertTrustedIpc(event)
      if (
        !attachmentStore ||
        !input ||
        typeof input.data !== 'string' ||
        input.data.length > 7000000 ||
        !['audio/webm', 'audio/ogg', 'audio/mp4'].includes(input.mime) ||
        !Number.isFinite(input.durationMs) ||
        input.durationMs < 0 ||
        input.durationMs > 60000
      )
        throw new Error('无效录音')
      return attachmentStore.put(
        Buffer.from(input.data, 'base64'),
        '语音消息',
        input.mime,
        input.durationMs,
      )
    },
  )
  ipcMain.handle('attachment:read', (event, id: string) => {
    assertTrustedIpc(event)
    if (!attachmentStore || typeof id !== 'string') throw new Error('无效附件')
    return attachmentStore.read(id)
  })
  ipcMain.handle('attachment:save', async (event, id: string) => {
    assertTrustedIpc(event)
    if (!attachmentStore || !mainWindow || typeof id !== 'string')
      throw new Error('无效附件')
    const wire = await attachmentStore.read(id),
      result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: wire.name,
        title: '保存文件',
      })
    if (result.canceled || !result.filePath) return 'cancelled'
    await writeFile(result.filePath, Buffer.from(wire.data, 'base64'))
    return 'saved'
  })
  ipcMain.handle('chat:state:load', (event) => {
    assertTrustedIpc(event)
    if (!chatStore) throw new Error('Chat storage is unavailable.')
    return chatStore.loadView()
  })
  ipcMain.handle('chat:state:save', (event, value: unknown) => {
    assertTrustedIpc(event)
    if (!chatStore) throw new Error('Chat storage is unavailable.')
    const candidate = value as { profile?: Record<string, unknown> }
    if (centralClient && candidate?.profile)
      candidate.profile.id = centralClient.identity.userId
    return chatStore.save(value)
  })
  ipcMain.handle('app:info', (event) => {
    assertTrustedIpc(event)
    return { version: app.getVersion(), platform: process.platform }
  })
  ipcMain.handle('host:status:get', (event) => {
    assertTrustedIpc(event)
    return hostSupervisor?.getStatus() ?? { state: 'stopped', generation: 0 }
  })
  ipcMain.handle('host:ping', (event) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host supervisor is unavailable.')
    return hostSupervisor.ping()
  })
  ipcMain.handle('host:plugins:list', (event) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    return hostSupervisor.getPlugins()
  })
  ipcMain.handle('host:plugins:set-enabled', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('plugins.setEnabled', 'ipc', payload as never),
    )
    if (request.kind !== 'request' || request.method !== 'plugins.setEnabled')
      throw new Error('Invalid plugin request.')
    return hostSupervisor.setPluginEnabled(
      request.payload.pluginId,
      request.payload.enabled,
    )
  })
  ipcMain.handle('host:tools:invoke', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('tools.invoke', 'ipc', payload as never),
    )
    if (request.kind !== 'request' || request.method !== 'tools.invoke')
      throw new Error('Invalid tool request.')
    return hostSupervisor.invokeTool(
      request.payload.pluginId,
      request.payload.toolId,
      request.payload.input,
    )
  })
  ipcMain.handle('host:model:get-settings', (event) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    return hostSupervisor.getModelSettings()
  })
  ipcMain.handle('host:model:set-settings', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('model.setSettings', 'ipc', payload as never),
    )
    if (request.kind !== 'request' || request.method !== 'model.setSettings')
      throw new Error('Invalid model settings.')
    return hostSupervisor.setModelSettings(request.payload)
  })
  ipcMain.handle('host:model:chat-start', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if(historyTransferStatus.busy)throw new Error('聊天记录备份/恢复进行中，请完成后再开始 AI 回复')
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('model.chat.start', 'ipc', payload as never),
    )
    if (request.kind !== 'request' || request.method !== 'model.chat.start')
      throw new Error('Invalid model chat request.')
    return hostSupervisor.startModelChat(request.payload)
  })
  ipcMain.handle('host:model:chat-cancel', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('model.chat.cancel', 'ipc', payload as never),
    )
    if (request.kind !== 'request' || request.method !== 'model.chat.cancel')
      throw new Error('Invalid model cancel request.')
    return hostSupervisor.cancelModelChat(request.payload.streamId)
  })
  ipcMain.handle('host:plugin-drafts:inspect', (event) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    return hostSupervisor.inspectPluginDrafts()
  })
  ipcMain.handle('host:plugin-drafts:create', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('pluginDrafts.create', 'ipc', payload as never),
    )
    if (request.kind !== 'request' || request.method !== 'pluginDrafts.create')
      throw new Error('Invalid plugin draft.')
    return hostSupervisor.createPluginDraft(request.payload)
  })
  ipcMain.handle('host:plugin-drafts:validate', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('pluginDrafts.validate', 'ipc', payload as never),
    )
    if (
      request.kind !== 'request' ||
      request.method !== 'pluginDrafts.validate'
    )
      throw new Error('Invalid plugin draft.')
    return hostSupervisor.validatePluginDraft(request.payload.draftId)
  })
  ipcMain.handle('host:plugin-drafts:diagnose', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('pluginDrafts.diagnose', 'ipc', payload as never),
    )
    if (
      request.kind !== 'request' ||
      request.method !== 'pluginDrafts.diagnose'
    )
      throw new Error('Invalid plugin draft.')
    return hostSupervisor.diagnosePluginDraft(request.payload.draftId)
  })
  ipcMain.handle('host:plugin-drafts:install', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(
      createHostRequest('pluginDrafts.install', 'ipc', payload as never),
    )
    if (request.kind !== 'request' || request.method !== 'pluginDrafts.install')
      throw new Error('Invalid plugin draft.')
    return hostSupervisor.installPluginDraft(request.payload)
  })
}

function electronResourcesPath(): string {
  const value = (process as { resourcesPath?: unknown }).resourcesPath
  return typeof value === 'string' ? value : ''
}

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Rejected IPC from an untrusted frame.')
  }
}

function startHostSupervisor(): void {
  const hostEntry = resolveHostEntry({
    packaged: app.isPackaged,
    resourcesPath: electronResourcesPath(),
    moduleDir: __dirname,
  })
  hostSupervisor = new HostSupervisor({
    manageClientPlugins,
    clientVersion: app.getVersion(),
    credentials: new EncryptedCredentialStore(
      path.join(dataDirectory, 'host-private'),
      {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
    ),
    createProcess: createElectronHostProcessFactory({
      entryPath: hostEntry.entryPath,
      cwd: hostEntry.cwd,
      environment: {
        MTC_HOST_DATA_DIR: path.join(dataDirectory, 'host-private'),
        MTC_ENABLE_DEMO_PLUGINS: process.env.MTC_QA_MODE === '1' ? '1' : '0',
        MTC_HOST_QA_CRASH_ONCE:
          process.env.MTC_QA_HOST_CRASH_ONCE === '1' ? '1' : undefined,
      },
    }),
  })
  hostStatusCleanup = hostSupervisor.subscribe((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send('host:status:changed', status)
    }
  })
  hostEventCleanup = hostSupervisor.subscribeEvents((event) => {
    const clientEvent = toClientModelEvent(event)
    if (!clientEvent) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send('host:model:event', clientEvent)
    }
  })
  void hostSupervisor.start().catch((error) => {
    if (!quitAfterHostStops)
      console.error('[pc-host] Failed to reach ready state:', error)
  })
}

async function createWindow(previous?: BrowserWindow): Promise<void> {
  const window = new BrowserWindow({
    icon: path.join(app.getAppPath(),'assets','icon.png'),
    width: 1260,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#faf9f6',
    title: 'MoreThanChat',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f0eee8',
      symbolColor: '#62645c',
      height: 38,
    },
    webPreferences: {
      ...(currentProfile==='default'?{}:{partition:'persist:identity-'+currentProfile}),
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: process.env.MTC_QA_MODE === '1' ? ['--mtc-demo-plugins'] : [],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  mainWindow = window
  if (previous && !previous.isDestroyed()) {
    window.setBounds(previous.getNormalBounds())
    if (previous.isMaximized()) window.maximize()
  }
  window.on('closed', () => {
    if (mainWindow === window) {mainWindow = null;windowClosing = false}
  })
  window.once('ready-to-show', () => window.show())
  window.on('blur',()=>{centralClient?.setReadingConversation(null);window.webContents.send('app:window-focus-changed',false)})
  const stopReading=()=>{centralClient?.setReadingConversation(null);window.webContents.send('app:window-focus-changed',false)}
  window.on('hide',stopReading)
  window.on('minimize',stopReading)
  window.on('focus',()=>{window.flashFrame(false);desktop?.notifications.reconcile();window.webContents.send('app:window-focus-changed',true)})
  let allowClose = false
  let flushing = false
  window.on('close', (event) => {
    if(historyTransferStatus.busy){
      event.preventDefault();quitRequested=false;hideRequested=false;window.show();window.focus()
      dialog.showErrorBox('历史操作正在进行','请等待备份或恢复完成后再关闭窗口，现有数据会保留。')
      return
    }
    if (allowClose) return
    event.preventDefault()
    if (flushing) return
    flushing = true
    windowClosing = true
    const token = crypto.randomUUID()
    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('chat:state:flushed', acknowledged)
    }
    const finish = () => {
      cleanup()
      if(!quitRequested&&desktop?.trayAvailable&&(hideRequested||desktop.preferences.get().closeToTray)){
        hideRequested=false;flushing=false;windowClosing=false
        if(!window.isDestroyed())window.hide()
        return
      }
      hideRequested=false
      allowClose = true
      if (!window.isDestroyed()) window.close()
    }
    const stay = () => {
      cleanup()
      flushing = false
      windowClosing = false
      quitRequested = false
      pendingProfile = null
      hideRequested = false
      if (!window.isDestroyed()) { window.show(); window.focus() }
    }
    const acknowledged = (event: IpcMainEvent, reply: unknown) => {
      const result = reply as { token?: unknown; ok?: unknown } | null
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        result?.token !== token
      )
        return
      if (result.ok === true) finish()
      else {
        stay()
        dialog.showErrorBox(
          '会话未保存',
          '本地保存失败，应用已保持打开。请检查磁盘空间后再次关闭。',
        )
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      if (window.isDestroyed()) return
      window.show()
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          message: '会话保存尚未完成',
          detail: '退出可能丢失最近的消息。可以留在应用稍后再试。',
          buttons: ['留在应用', '仍然退出'],
          defaultId: 0,
          cancelId: 0,
        })
        .then((result) => { if(result.response===1){quitRequested=true;finish()}else stay() })
    }, 2500)
    ipcMain.on('chat:state:flushed', acknowledged)
    window.webContents.send('chat:state:flush', token)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://'))
      void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      contents === window.webContents &&
      permission === 'media' &&
      details.mediaType === 'audio',
  )
  window.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(
        contents === window.webContents &&
          details.isMainFrame &&
          permission === 'media' &&
          'mediaTypes' in details &&
          details.mediaTypes.length > 0 &&
          details.mediaTypes.every((type) => type === 'audio'),
      ),
  )
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.error(
        `[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`,
      )
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] Process exited:', details)
    if (mainWindow === window && !recoveryPending && !quitRequested) requestInterfaceRecovery()
  })
  window.on('unresponsive', () => { if (mainWindow === window) requestInterfaceRecovery() })
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key === 'F12') {
      event.preventDefault(); requestInterfaceRecovery()
    }
  })

  let loadTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      process.argv.includes('--dev') ? window.loadURL('http://127.0.0.1:5173') : window.loadFile(path.join(__dirname, '../dist-renderer/index.html')),
      new Promise<never>((_, reject) => {loadTimer = setTimeout(() => reject(new Error('界面加载超时')), 15000)}),
    ])
  } catch (error) {
    if (previous && !previous.isDestroyed()) mainWindow = previous
    window.destroy()
    throw error
  } finally {
    clearTimeout(loadTimer)
  }
  desktop?.refresh()

  const screenshotPath = process.env.MTC_SCREENSHOT_PATH
  if (screenshotPath) {
    setTimeout(() => {
      void window.webContents
        .capturePage()
        .then((image) => writeFile(screenshotPath, image.toPNG()))
        .catch((error) =>
          console.error('[qa] Failed to capture screenshot:', error),
        )
        .finally(() => app.quit())
    }, 900)
  }
}

app
  .whenReady()
  .then(async () => {
    chatStore = await ChatStore.open(dataDirectory)
    desktop = new DesktopIntegration(dataDirectory,{window:()=>mainWindow,store:()=>chatStore,central:()=>centralClient,open:openChatWindow,hide:hideChatWindow})
    attachmentStore = new AttachmentStore(
      path.join(dataDirectory, 'attachments'),
    )
    try {
      const identity = await ClientIdentity.load(
        path.join(dataDirectory, 'host-private'),
        systemCipher,
      )
      centralClient = new CentralClient(
        identity,
        chatStore,
        attachmentStore,
        dataDirectory,
        async (serverId,previous,next)=>{
          if(!mainWindow||mainWindow.isDestroyed())return false
          const result=await dialog.showMessageBox(mainWindow,{type:'warning',message:'确认服务器地址变更',detail:'服务器 ID：'+serverId+'\n之前地址：'+previous+'\n新地址：'+next+'\n\n继续连接会将待发送消息交给新地址。请确认这是你迁移或信任的同一服务器。',buttons:['取消','确认连接新地址'],defaultId:0,cancelId:0})
          return result.response===1
        },
      )
      await centralClient.load()
      const broadcast = (channel: string, value: unknown) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send(channel, value)
      }
      centralCleanup = [
        centralClient.subscribe((snapshot) => {desktop?.notifications.reconcile();broadcast('central:changed', snapshot)}),
        centralClient.onChat((state) => {desktop?.update(state);broadcast('central:chat', state)}),
        centralClient.onIncomingMessage(notice=>desktop?.incoming(notice)),
        centralClient.onPlugin((event) => broadcast('central:plugin', event)),
      ]
    } catch {
      console.error(
        '[central] System identity encryption unavailable; local mode remains available',
      )
    }
    registerIpc()
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label: 'MoreThanChat', submenu: [
      {label: '恢复默认界面（停用界面插件）', accelerator: 'CommandOrControl+Shift+F12', click: requestInterfaceRecovery},
      {role: 'quit'},
    ]}, {role: 'editMenu'}]))
    startHostSupervisor()
    await createWindow()
    await desktop.initialize()
    desktop.publish()
    desktopReady = true
    if(pendingShow){pendingShow=false;openChatWindow()}
    void centralClient?.restore()
    app.on('activate', () => openChatWindow())
  })
  .catch((error) => {
    console.error('[main] Failed to start:', error)
    dialog.showErrorBox(
      '无法启动 MoreThanChat',
      '应用未能打开本地会话存储或后台服务。原数据已保留，请检查磁盘空间或应用版本后重试。',
    )
    app.exit(1)
  })

app.on('window-all-closed', () => {
  if (quitRequested || process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  desktop?.dispose()
  chatStore?.close()
  chatStore = null
})

app.on('before-quit', (event) => {
  if (quitAfterHostStops || !hostSupervisor) return
  event.preventDefault()
  if (mainWindow && !mainWindow.isDestroyed()) {
    quitRequested = true
    mainWindow.close()
    return
  }
  quitAfterHostStops = true
  for (const dispose of centralCleanup) dispose()
  centralCleanup = []
  hostStatusCleanup?.()
  hostStatusCleanup = null
  hostEventCleanup?.()
  hostEventCleanup = null
  desktop?.dispose()
  void Promise.all([hostSupervisor.stop(), centralClient?.disconnect(false),desktop?.preferences.flush()])
    .catch((error) => {
      console.error('[pc-host] Failed to stop cleanly:', error)
    })
    .finally(async () => {
      if(pendingProfile){
        try { await selectProfile(profileRoot,pendingProfile); app.relaunch() }
        catch { dialog.showErrorBox('身份切换未完成','原身份及聊天数据已保留，下次启动仍会打开原空间。') }
      }
      app.quit()
    })
})
