import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validatePluginManifest, type PluginManifestV1 } from '@more-than-chat/plugin-runtime'
import { isAcceptedStaticTextTool, type DeclarativeTextTool } from './static-text-tool'

const directoryName = 'installed-static-tools'

export interface StoredStaticTool {
  readonly v: 1
  readonly enabled: boolean
  readonly manifest: PluginManifestV1
  readonly tool: DeclarativeTextTool
}

/** Persists declarative tool data. The file is never loaded or executed as code. */
export class InstalledStaticToolStore {
  readonly #root: string

  constructor(dataDir: string) {
    this.#root = path.resolve(dataDir, directoryName)
  }

  async list(): Promise<StoredStaticTool[]> {
    let names: string[]
    try {
      names = await readdir(this.#root)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: StoredStaticTool[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!isPluginFileId(id)) continue
      try {
        const record = parseStoredStaticTool(JSON.parse(await readFile(this.#file(id), 'utf8')) as unknown)
        if (record && record.manifest.id === id) records.push(record)
      }
      catch {
        // Skip an unreadable record. Leaving it in place avoids replacing a plugin with nothing.
      }
      if (records.length >= 100) break
    }
    return records
  }

  async save(record: StoredStaticTool): Promise<void> {
    const stored = parseStoredStaticTool(record)
    if (!stored) throw new Error('Refusing to store an invalid declarative text tool.')
    await this.#write(stored.manifest.id, stored)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!isPluginFileId(id)) return
    let record: StoredStaticTool | null
    try {
      record = parseStoredStaticTool(JSON.parse(await readFile(this.#file(id), 'utf8')) as unknown)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!record || record.manifest.id !== id || record.enabled === enabled) return
    await this.#write(id, { ...record, enabled })
  }

  async #write(id: string, record: StoredStaticTool): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    await chmod(this.#root, 0o700)
    const file = this.#file(id)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  }

  #file(id: string): string {
    const file = path.resolve(this.#root, `${id}.json`)
    if (file !== path.join(this.#root, `${id}.json`)) throw new Error('Invalid declarative tool id.')
    return file
  }
}

export async function restoreInstalledStaticTools(store: InstalledStaticToolStore, plugins: {
  installStaticTool(manifest: PluginManifestV1, tool: DeclarativeTextTool, persist?: () => Promise<void>): Promise<unknown>
  setEnabled(pluginId: string, enabled: boolean): Promise<unknown>
}): Promise<void> {
  for (const record of await store.list()) {
    try {
      await plugins.installStaticTool(record.manifest, record.tool)
      if (!record.enabled) await plugins.setEnabled(record.manifest.id, false)
    }
    catch {
      // Keep the stored record. Startup must not replace an existing plugin or abort the host.
    }
  }
}

function parseStoredStaticTool(value: unknown): StoredStaticTool | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<StoredStaticTool>
  if (record.v !== 1 || typeof record.enabled !== 'boolean' || !record.tool) return null
  try {
    validatePluginManifest(record.manifest)
  }
  catch {
    return null
  }
  const tool = record.tool
  if (!isAcceptedStaticTextTool(record.manifest, { id: tool.id, label: tool.label, text: tool.text })) return null
  return {
    v: 1,
    enabled: record.enabled,
    manifest: record.manifest,
    tool: { id: tool.id, label: tool.label, text: tool.text },
  }
}

function isPluginFileId(value: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) && value.length <= 128
}
