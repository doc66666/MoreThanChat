import {
  app,
  BrowserWindow,
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
import { AttachmentStore } from './attachments'
import { createHostRequest, parseHostMessage } from '@more-than-chat/protocol'

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
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function registerIpc(): void {
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
    (event, input: { route: string; data: unknown }) => {
      assertTrustedIpc(event)
      if (
        !centralClient ||
        !input ||
        ![
          'friends/request',
          'friends/accept',
          'groups',
          'groups/invite',
          'groups/join',
          'groups/accept',
          'plugins/submit',
          'plugins/review',
          'plugins/event',
        ].includes(input.route)
      )
        throw new Error('不允许的中心服务操作')
      return centralClient.action(input.route, input.data)
    },
  )
  ipcMain.handle(
    'central:send',
    (
      event,
      input: {
        conversationId: string
        clientMessageId: string
        text: string
        attachmentId?: string
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
          typeof input.attachmentId !== 'string')
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
    if (!result.canceled && result.filePath)
      await writeFile(result.filePath, Buffer.from(wire.data, 'base64'))
  })
  ipcMain.handle('chat:state:load', (event) => {
    assertTrustedIpc(event)
    if (!chatStore) throw new Error('Chat storage is unavailable.')
    return chatStore.load()
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
    clientVersion: app.getVersion(),
    credentials: new EncryptedCredentialStore(
      path.join(app.getPath('userData'), 'host-private'),
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
        MTC_HOST_DATA_DIR: path.join(app.getPath('userData'), 'host-private'),
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

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  let allowClose = false
  let flushing = false
  window.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    if (flushing) return
    flushing = true
    const token = crypto.randomUUID()
    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('chat:state:flushed', acknowledged)
    }
    const finish = () => {
      cleanup()
      allowClose = true
      if (!window.isDestroyed()) window.close()
    }
    const stay = () => {
      cleanup()
      flushing = false
      quitRequested = false
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
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          message: '会话保存尚未完成',
          detail: '退出可能丢失最近的消息。可以留在应用稍后再试。',
          buttons: ['留在应用', '仍然退出'],
          defaultId: 0,
          cancelId: 0,
        })
        .then((result) => (result.response === 1 ? finish() : stay()))
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
  })

  if (process.argv.includes('--dev')) {
    await window.loadURL('http://127.0.0.1:5173')
  } else {
    await window.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

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
    chatStore = await ChatStore.open(app.getPath('userData'))
    attachmentStore = new AttachmentStore(
      path.join(app.getPath('userData'), 'attachments'),
    )
    try {
      const identity = await ClientIdentity.load(
        path.join(app.getPath('userData'), 'host-private'),
        systemCipher,
      )
      centralClient = new CentralClient(
        identity,
        chatStore,
        attachmentStore,
        app.getPath('userData'),
      )
      await centralClient.load()
      const broadcast = (channel: string, value: unknown) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send(channel, value)
      }
      centralCleanup = [
        centralClient.subscribe((snapshot) =>
          broadcast('central:changed', snapshot),
        ),
        centralClient.onChat((state) => broadcast('central:chat', state)),
        centralClient.onPlugin((event) => broadcast('central:plugin', event)),
      ]
    } catch {
      console.error(
        '[central] System identity encryption unavailable; local mode remains available',
      )
    }
    registerIpc()
    startHostSupervisor()
    await createWindow()
    void centralClient?.restore()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
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
  void Promise.all([hostSupervisor.stop(), centralClient?.disconnect(false)])
    .catch((error) => {
      console.error('[pc-host] Failed to stop cleanly:', error)
    })
    .finally(() => app.quit())
})
