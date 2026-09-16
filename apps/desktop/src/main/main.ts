import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_STATE_BYTES = 8 * 1024 * 1024
let mainWindow: BrowserWindow | null = null

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
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new Error('Chat state exceeds the local storage limit.')

  const target = statePath()
  const temporary = `${target}.next`
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

function registerIpc(): void {
  ipcMain.handle('chat:state:load', loadState)
  ipcMain.handle('chat:state:save', (_event, value: unknown) => saveState(value))
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }))
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

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.argv.includes('--dev')) {
    await window.loadURL('http://127.0.0.1:5173')
  }
  else {
    await window.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const screenshotPath = process.env.MTC_SCREENSHOT_PATH
  if (screenshotPath) {
    setTimeout(() => {
      void window.webContents.capturePage().then(image => writeFile(screenshotPath, image.toPNG())).finally(() => app.quit())
    }, 900)
  }
}

app.whenReady().then(async () => {
  registerIpc()
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
