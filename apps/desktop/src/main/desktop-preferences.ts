import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface DesktopPreferences {
  notifications: boolean
  preview: boolean
  sound: boolean
  closeToTray: boolean
}
const defaults: DesktopPreferences = { notifications: true, preview: false, sound: false, closeToTray: false }
const keys = Object.keys(defaults) as (keyof DesktopPreferences)[]
function parsePatch(value: unknown): Partial<DesktopPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效通知设置')
  for (const [key, item] of Object.entries(value)) {
    if (!keys.includes(key as keyof DesktopPreferences) || typeof item !== 'boolean') throw new Error('无效通知设置')
  }
  return value as Partial<DesktopPreferences>
}
export class DesktopPreferenceStore {
  #value = { ...defaults }
  #writes: Promise<unknown> = Promise.resolve()
  error: string | null = null
  constructor(readonly directory: string) {}
  async load(): Promise<void> {
    try {
      const text = await readFile(path.join(this.directory, 'desktop-preferences.json'), 'utf8')
      if (text.length > 4096) throw new Error('Invalid settings file')
      this.#value = { ...defaults, ...parsePatch(JSON.parse(text)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = '通知设置未能恢复，正在使用默认值；原文件已保留。'
    }
  }
  get(): DesktopPreferences { return { ...this.#value } }
  update(patch: unknown): Promise<DesktopPreferences> {
    const parsed = { ...parsePatch(patch) }
    const task = this.#writes.catch(() => undefined).then(async () => {
      const next = { ...this.#value, ...parsed }
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = path.join(this.directory, 'desktop-preferences.' + randomUUID() + '.tmp')
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(next)); await file.sync() } finally { await file.close() }
        await rename(temporary, path.join(this.directory, 'desktop-preferences.json'))
        this.#value = next; this.error = null
        return this.get()
      } finally { await unlink(temporary).catch(() => undefined) }
    })
    this.#writes = task
    return task
  }
  async flush(): Promise<void> { await this.#writes }
}
