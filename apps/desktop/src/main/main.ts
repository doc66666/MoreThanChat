import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createElectronHostProcessFactory } from './electron-host-process'
import { resolveHostEntry } from './host-entry'
import { HostSupervisor } from './host-supervisor'
import { toClientModelEvent } from './model-client-event'
import { redactSecretFields } from './secret-redaction'
import { createHostRequest, parseHostMessage } from '@more-than-chat/protocol'

const MAX_STATE_BYTES = 8 * 1024 * 1024
let mainWindow: BrowserWindow | null = null
let hostSupervisor: HostSupervisor | null = null
let hostStatusCleanup: (() => void) | null = null
let hostEventCleanup: (() => void) | null = null
let quitAfterHostStops = false

if (process.env.MTC_SCREENSHOT_PATH || process.env.MTC_QA_MODE === '1') {
  app.setPath('userData', path.join(app.getPath('temp'), 'MoreThanChat-QA'))
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'chat-state.json')
}

async function loadState(): Promise<unknown | null> {
  try {
    const raw = await readFile(statePath(), 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new Error('Persisted chat state is too large.')
    return JSON.parse(raw) as unknown
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error('[persistence] Failed to load chat state:', error)
    return null
  }
}

async function saveState(value: unknown): Promise<void> {
  const raw = JSON.stringify(redactSecretFields(value))
  if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new Error('Chat state exceeds the local storage limit.')

  const target = statePath()
  const temporary = `${target}.next`
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

function registerIpc(): void {
  ipcMain.handle('chat:state:load', event => {
    assertTrustedIpc(event)
    return loadState()
  })
  ipcMain.handle('chat:state:save', (event, value: unknown) => {
    assertTrustedIpc(event)
    return saveState(value)
  })
  ipcMain.handle('app:info', event => {
    assertTrustedIpc(event)
    return { version: app.getVersion(), platform: process.platform }
  })
  ipcMain.handle('host:status:get', event => {
    assertTrustedIpc(event)
    return hostSupervisor?.getStatus() ?? { state: 'stopped', generation: 0 }
  })
  ipcMain.handle('host:ping', event => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host supervisor is unavailable.')
    return hostSupervisor.ping()
  })
  ipcMain.handle('host:plugins:list', event => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    return hostSupervisor.getPlugins()
  })
  ipcMain.handle('host:plugins:set-enabled', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('plugins.setEnabled', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'plugins.setEnabled') throw new Error('Invalid plugin request.')
    return hostSupervisor.setPluginEnabled(request.payload.pluginId, request.payload.enabled)
  })
  ipcMain.handle('host:tools:invoke', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('tools.invoke', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'tools.invoke') throw new Error('Invalid tool request.')
    return hostSupervisor.invokeTool(request.payload.pluginId, request.payload.toolId)
  })
  ipcMain.handle('host:model:get-settings', event => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    return hostSupervisor.getModelSettings()
  })
  ipcMain.handle('host:model:set-settings', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('model.setSettings', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'model.setSettings') throw new Error('Invalid model settings.')
    return hostSupervisor.setModelSettings(request.payload)
  })
  ipcMain.handle('host:model:chat-start', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('model.chat.start', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'model.chat.start') throw new Error('Invalid model chat request.')
    return hostSupervisor.startModelChat(request.payload)
  })
  ipcMain.handle('host:model:chat-cancel', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('model.chat.cancel', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'model.chat.cancel') throw new Error('Invalid model cancel request.')
    return hostSupervisor.cancelModelChat(request.payload.streamId)
  })
  ipcMain.handle('host:plugin-drafts:inspect', event => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    return hostSupervisor.inspectPluginDrafts()
  })
  ipcMain.handle('host:plugin-drafts:create', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('pluginDrafts.create', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'pluginDrafts.create') throw new Error('Invalid plugin draft.')
    return hostSupervisor.createPluginDraft(request.payload)
  })
  ipcMain.handle('host:plugin-drafts:validate', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('pluginDrafts.validate', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'pluginDrafts.validate') throw new Error('Invalid plugin draft.')
    return hostSupervisor.validatePluginDraft(request.payload.draftId)
  })
  ipcMain.handle('host:plugin-drafts:diagnose', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('pluginDrafts.diagnose', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'pluginDrafts.diagnose') throw new Error('Invalid plugin draft.')
    return hostSupervisor.diagnosePluginDraft(request.payload.draftId)
  })
  ipcMain.handle('host:plugin-drafts:install', (event, payload: unknown) => {
    assertTrustedIpc(event)
    if (!hostSupervisor) throw new Error('PC Host is unavailable.')
    const request = parseHostMessage(createHostRequest('pluginDrafts.install', 'ipc', payload as never))
    if (request.kind !== 'request' || request.method !== 'pluginDrafts.install') throw new Error('Invalid plugin draft.')
    return hostSupervisor.installPluginDraft(request.payload)
  })
}

function electronResourcesPath(): string {
  const value = (process as { resourcesPath?: unknown }).resourcesPath
  return typeof value === 'string' ? value : ''
}

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
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
    createProcess: createElectronHostProcessFactory({
      entryPath: hostEntry.entryPath,
      cwd: hostEntry.cwd,
      environment: {
        MTC_HOST_DATA_DIR: path.join(app.getPath('userData'), 'host-private'),
        MTC_HOST_QA_CRASH_ONCE: process.env.MTC_QA_HOST_CRASH_ONCE === '1' ? '1' : undefined,
      },
    }),
  })
  hostStatusCleanup = hostSupervisor.subscribe(status => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('host:status:changed', status)
    }
  })
  hostEventCleanup = hostSupervisor.subscribeEvents(event => {
    const clientEvent = toClientModelEvent(event)
    if (!clientEvent) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('host:model:event', clientEvent)
    }
  })
  void hostSupervisor.start().catch(error => {
    if (!quitAfterHostStops) console.error('[pc-host] Failed to reach ready state:', error)
  })
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f4f5f8',
    title: 'MoreThanChat',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f7f8fb',
      symbolColor: '#4b4d59',
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

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('console-message', details => {
    if (details.level === 'warning' || details.level === 'error') {
      console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`)
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] Process exited:', details)
  })

  if (process.argv.includes('--dev')) {
    await window.loadURL('http://127.0.0.1:5173')
  }
  else {
    await window.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const screenshotPath = process.env.MTC_SCREENSHOT_PATH
  if (screenshotPath) {
    setTimeout(() => {
      void window.webContents.capturePage()
        .then(image => writeFile(screenshotPath, image.toPNG()))
        .catch(error => console.error('[qa] Failed to capture screenshot:', error))
        .finally(() => app.quit())
    }, 900)
  }
}

app.whenReady().then(async () => {
  registerIpc()
  startHostSupervisor()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
}).catch(error => {
  console.error('[main] Failed to start:', error)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', event => {
  if (quitAfterHostStops || !hostSupervisor) return
  event.preventDefault()
  quitAfterHostStops = true
  hostStatusCleanup?.()
  hostStatusCleanup = null
  hostEventCleanup?.()
  hostEventCleanup = null
  void hostSupervisor.stop().catch(error => {
    console.error('[pc-host] Failed to stop cleanly:', error)
  }).finally(() => app.quit())
})
