import { chmod, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validatePluginManifest, type PluginManifestV1 } from '@more-than-chat/plugin-runtime'
import { isAcceptedStaticTextTool, type DeclarativeComposerAction, type DeclarativeTextTool } from './static-text-tool'

const directoryName = 'installed-static-tools'

export type StoredStaticKind = 'text-tool' | 'composer-action'

export interface StoredStaticTool {
  readonly v: 1
  readonly revision: number
  readonly enabled: boolean
  /** Missing on records stored before composer actions were persisted. Those stay text tools. */
  readonly kind: StoredStaticKind
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

  async read(id: string): Promise<StoredStaticTool | null> {
    if (!isPluginFileId(id)) return null
    let text: string
    try {
      text = await readFile(this.#file(id), 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const record = parseStoredStaticTool(JSON.parse(text) as unknown)
      return record && record.manifest.id === id ? record : null
    }
    catch {
      return null
    }
  }

  /** Writes an immutable version file, then the current record. */
  async save(record: StoredStaticTool): Promise<void> {
    const stored = requireStored(record)
    const placed = await this.#placeVersion(stored)
    if (placed === 'exists') {
      const existing = await readFile(this.#versionFile(stored.manifest.id, stored.revision), 'utf8')
      if (existing !== serialized(stored)) throw new Error('Refusing to replace an immutable declarative tool version.')
    }
    await this.#write(stored.manifest.id, stored)
  }

  /** Rewrites only the current record. Version files stay untouched. */
  async saveCurrent(record: StoredStaticTool): Promise<void> {
    const stored = requireStored(record)
    await this.#write(stored.manifest.id, stored)
  }

  /** Creates the version file when a record was stored before versions existed. */
  async preserveVersion(record: StoredStaticTool): Promise<void> {
    await this.#placeVersion(requireStored(record))
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

  async #placeVersion(record: StoredStaticTool): Promise<'created' | 'exists'> {
    const directory = this.#versionDirectory(record.manifest.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(path.dirname(directory), 0o700)
    await chmod(directory, 0o700)
    const file = this.#versionFile(record.manifest.id, record.revision)
    const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    try {
      await writeFile(temporary, serialized(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      try {
        await link(temporary, file)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        throw error
      }
      await chmod(file, 0o600)
      return 'created'
    }
    finally {
      await rm(temporary, { force: true })
    }
  }

  async #write(id: string, record: StoredStaticTool): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    await chmod(this.#root, 0o700)
    const file = this.#file(id)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, serialized(record), { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  }

  #file(id: string): string {
    const file = path.resolve(this.#root, `${id}.json`)
    if (file !== path.join(this.#root, `${id}.json`)) throw new Error('Invalid declarative tool id.')
    return file
  }

  #versionDirectory(id: string): string {
    if (!isPluginFileId(id)) throw new Error('Invalid declarative tool id.')
    const directory = path.resolve(this.#root, 'versions', id)
    if (directory !== path.join(this.#root, 'versions', id)) throw new Error('Invalid declarative tool id.')
    return directory
  }

  #versionFile(id: string, revision: number): string {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid declarative tool revision.')
    const directory = this.#versionDirectory(id)
    const file = path.resolve(directory, `version-${revision}.json`)
    if (file !== path.join(directory, `version-${revision}.json`)) throw new Error('Invalid declarative tool revision.')
    return file
  }
}

export async function restoreInstalledStaticTools(store: InstalledStaticToolStore, plugins: {
  installStaticTool(manifest: PluginManifestV1, tool: DeclarativeTextTool, persist?: () => Promise<void>): Promise<unknown>
  installStaticComposerAction(manifest: PluginManifestV1, action: DeclarativeComposerAction, persist?: () => Promise<void>): Promise<unknown>
  setEnabled(pluginId: string, enabled: boolean): Promise<unknown>
}): Promise<void> {
  for (const record of await store.list()) {
    try {
      if (record.kind === 'composer-action') await plugins.installStaticComposerAction(record.manifest, record.tool)
      else await plugins.installStaticTool(record.manifest, record.tool)
      if (!record.enabled) await plugins.setEnabled(record.manifest.id, false)
    }
    catch {
      // Keep the stored record. Startup must not replace an existing plugin or abort the host.
    }
  }
}

function requireStored(record: StoredStaticTool): StoredStaticTool {
  const stored = parseStoredStaticTool(record)
  if (!stored) throw new Error('Refusing to store an invalid declarative text tool.')
  return stored
}

function serialized(record: StoredStaticTool): string {
  return `${JSON.stringify(record)}\n`
}

function parseStoredStaticTool(value: unknown): StoredStaticTool | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<StoredStaticTool>
  const revision = record.revision === undefined ? 1 : record.revision
  if (record.v !== 1 || typeof record.enabled !== 'boolean' || !record.tool) return null
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null
  try {
    validatePluginManifest(record.manifest)
  }
  catch {
    return null
  }
  const tool = record.tool
  const kind = storedKind(record.kind)
  if (!kind) return null
  if (!isAcceptedStaticTextTool(record.manifest, { id: tool.id, label: tool.label, text: tool.text })) return null
  return {
    v: 1,
    revision,
    enabled: record.enabled,
    kind,
    manifest: record.manifest,
    tool: { id: tool.id, label: tool.label, text: tool.text },
  }
}

function storedKind(value: unknown): StoredStaticKind | null {
  if (value === undefined) return 'text-tool'
  if (value === 'text-tool' || value === 'composer-action') return value
  return null
}

function isPluginFileId(value: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) && value.length <= 128
}
