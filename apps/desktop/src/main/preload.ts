import { contextBridge, ipcRenderer } from 'electron'

const api = {
  loadState: (): Promise<unknown | null> => ipcRenderer.invoke('chat:state:load') as Promise<unknown | null>,
  saveState: (value: unknown): Promise<void> => ipcRenderer.invoke('chat:state:save', value) as Promise<void>,
  getAppInfo: (): Promise<{ version: string; platform: string }> => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string }>,
}

contextBridge.exposeInMainWorld('moreThanChat', Object.freeze(api))
