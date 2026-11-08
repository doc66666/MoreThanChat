import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  validatePluginManifest,
  type PluginSource,
  type PluginModule,
  type PluginContext,
  type PluginRuntime,
  type PluginManifestV1,
  type PluginSnapshot,
} from '@more-than-chat/plugin-runtime'

const loadModule = (
  url: string,
): Promise<{
  default: (context: PluginContext, sdk: unknown) => ReturnType<PluginModule['activate']>
}> => import(url)

/** Explicit trusted Node extensions in a user-owned directory. The watcher is
 * a loader, not a second runtime; updates use the same composition transaction. */
export class NodePluginDirectory {
  readonly errors = new Map<string, string>()
  readonly #loaded = new Map<string, { digest: string; source: PluginSource }>()
  readonly #rejected = new Map<string, string>()
  readonly #manifests = new Map<string, PluginManifestV1>()
  readonly #ownedRecords = new Set<string>()
  #folders = new Set<string>()
  #disabled = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false
  #prepared: Promise<void> | undefined
  constructor(
    readonly directory: string,
    readonly runtime: Pick<
      PluginRuntime,
      'install' | 'activate' | 'deactivate' | 'replace' | 'uninstall' | 'list' | 'services'
    >,
    readonly sdk: unknown = {},
  ) {}
  /** Read preferences before the owner starts bundled plugins, so disabled
   * services never acquire sockets, workers or subscriptions during boot. */
  async prepare(): Promise<void> {
    return this.#prepared ??= this.#readPreferences()
  }
  isEnabled(id: string): boolean { return !this.#disabled.has(id) }
  async #readPreferences() {
    await mkdir(this.directory, { recursive: true })
    try {
      const value = JSON.parse(await readFile(path.join(this.directory, 'disabled.json'), 'utf8'))
      if (Array.isArray(value))
        this.#disabled = new Set(value.filter((id) => typeof id === 'string'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  async start() {
    await this.prepare()
    for (const id of this.#disabled)
      if (this.runtime.list().some((p) => p.manifest.id === id)) await this.runtime.deactivate(id)
    await this.refresh()
    this.#schedule()
  }
  has(id: string) {
    return this.#loaded.has(id)
  }
  owns(id: string): boolean {
    return this.#folders.has(id) || this.runtime.list().some(p => p.manifest.id === id)
  }
  list(): PluginSnapshot[] {
    const installed = this.runtime.list().map(p => ({...p, error: this.errors.get(p.manifest.id) ?? p.error}))
    const known = new Set(installed.map(p => p.manifest.id))
    for (const id of this.#folders) if (!known.has(id)) {
      installed.push({
        manifest: this.#manifests.get(id) ?? {
          manifestVersion: 1, id, version: '0.0.0', displayName: id,
          description: '本机 Node 插件', targets: ['pc-host'], permissions: ['host.trusted'], engine: {moreThanChat: '^0.1.0'},
        },
        trust: 'trusted', status: !this.#disabled.has(id) && this.errors.has(id) ? 'failed' : 'inactive', error: this.errors.get(id) ?? null,
      })
    }
    return installed
  }
  async setEnabled(id: string, enabled: boolean) {
    return this.#enqueue(async () => {
      if (this.#closed) throw new Error('Node plugin directory is closed')
      if (!this.owns(id))
        throw new Error('Unknown local Node plugin')
      const next = new Set(this.#disabled), wasDisabled = this.#disabled.has(id)
      if (enabled) {
        // Explicit enable is also a retry. Read edits before activating an old
        // disabled revision, including a first install that never loaded.
        this.#rejected.delete(id)
        if (this.#folders.has(id)) await this.#scan(id)
        if (!this.runtime.list().some(p => p.manifest.id === id))
          throw new Error(this.errors.get(id) ?? 'Node plugin could not be loaded')
        await this.runtime.activate(id)
        next.delete(id)
        try { await this.#saveDisabled(next) }
        catch (error) {
          if (wasDisabled) await this.runtime.deactivate(id)
          throw error
        }
      } else {
        next.add(id)
        // Persist first: cleanup errors must not undo a user's stop request.
        await this.#saveDisabled(next)
        if (this.runtime.list().some(p => p.manifest.id === id)) await this.runtime.deactivate(id)
      }
    }).then(() => this.refresh())
  }
  async #saveDisabled(disabled: Set<string>) {
    await atomicJson(path.join(this.directory, 'disabled.json'), [...disabled])
    this.#disabled = disabled
  }
  refresh(): Promise<void> {
    return this.#enqueue(() => this.#scan())
  }
  async #scan(enableId?: string): Promise<void> {
      if (this.#closed) return
      const present = new Set<string>()
      const entries = (await readdir(this.directory, {withFileTypes:true}))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(entry.name))
      this.#folders = new Set(entries.map(entry => entry.name))
      for (const entry of entries) {
        if (enableId && entry.name !== enableId) continue
        const folder = path.join(this.directory, entry.name)
        let digest: string | undefined
        let committing = false
        let rejectable = false
        try {
          // Keep the last accepted version across process restarts, including
          // when the editable files contain a partial or broken hot update.
          if (!this.#loaded.has(entry.name)) {
            try {
              const revision: unknown = JSON.parse(await readFile(path.join(folder, '.mtc-runtime', 'current.json'), 'utf8'))
              if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid saved Node plugin revision')
              const files = await readSources(path.join(folder, '.mtc-runtime', revision))
              if (sourceDigest(files) !== revision) throw new Error('Saved Node plugin revision is incomplete')
              const source = await this.#source(entry.name, folder, revision, files)
              await this.#apply(entry.name, source)
              this.#loaded.set(entry.name, {digest: revision, source})
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.errors.set(entry.name, String(error))
            }
          }
          const files = await readSources(folder)
          digest = sourceDigest(files)
          if (this.#rejected.get(entry.name) === digest && entry.name !== enableId) {
            present.add(entry.name)
            continue
          }
          const id = entry.name
          present.add(id)
          if (this.#loaded.get(id)?.digest === digest) {this.errors.delete(id);this.#rejected.delete(id);continue}
          // Do not overwrite the accepted revision with unexecuted edits while
          // disabled. Apply those edits after the user enables the plugin.
          if (this.#disabled.has(id) && id !== enableId) {this.#manifest(id, files);continue}
          const source = await this.#source(id, folder, digest, files), previous = this.#loaded.get(id)
          // Waiting for a provider must remain retryable when that provider loads.
          rejectable = (source.manifest.services?.requires ?? []).every(service => this.runtime.services.has(service))
          await this.#apply(id, source, id === enableId)
          committing = true
          try { await atomicJson(path.join(folder, '.mtc-runtime', 'current.json'), digest) }
          catch (error) {
            if (previous) await this.runtime.replace(previous.source)
            else {await this.runtime.uninstall(id);this.#ownedRecords.delete(id)}
            throw error
          }
          this.#loaded.set(id, { digest, source })
          this.errors.delete(entry.name)
          this.#rejected.delete(id)
        } catch (error) {
          this.errors.set(entry.name, error instanceof Error ? error.message : String(error))
          if (digest && !committing && rejectable) this.#rejected.set(entry.name, digest)
          // A partial save must not unload a working previous version.
          for (const id of this.#loaded.keys()) if (id === entry.name) present.add(id)
        }
      }
      // Only remove files whose entire directory was deleted. Invalid edits retain
      // the previous source and are retried on the next poll.
      const folders = new Set(
        (await readdir(this.directory, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name),
      )
      for (const id of new Set([...this.#loaded.keys(), ...this.#ownedRecords]))
        if (!present.has(id) && !folders.has(id)) {
          try {
            if (this.runtime.list().some(p => p.manifest.id === id)) await this.runtime.uninstall(id)
            this.#loaded.delete(id);this.#ownedRecords.delete(id)
          } catch (error) {this.errors.set(id, error instanceof Error ? error.message : String(error))}
        }
      for (const id of this.errors.keys())
        if (id !== '@loader' && !folders.has(id) && !this.#ownedRecords.has(id)) this.errors.delete(id)
      for (const id of this.#rejected.keys()) if (!folders.has(id)) this.#rejected.delete(id)
      for (const id of this.#manifests.keys()) if (!folders.has(id)) this.#manifests.delete(id)
      this.errors.delete('@loader')
  }
  async #apply(id: string, source: PluginSource, activate = false) {
    const previous = this.#loaded.get(id)
    if (previous) {
      const wasActive = this.runtime.list().some(p => p.manifest.id === id && p.status === 'active')
      let replaced = false
      try {
        await this.runtime.replace(source); replaced = true
        if (activate) await this.runtime.activate(id)
      } catch (error) {
        if (replaced) {await this.runtime.replace(previous.source);if (!wasActive) await this.runtime.deactivate(id)}
        throw error
      }
    }
    else {
      // A failed first activation can leave retryable cleanup effects. This
      // loader may clean its own record, but must never replace another owner's ID.
      if (this.#ownedRecords.has(id) && this.runtime.list().some(p => p.manifest.id === id)) {
        await this.runtime.uninstall(id);this.#ownedRecords.delete(id)
      }
      this.runtime.install(source)
      this.#ownedRecords.add(id)
      try { if (activate || !this.#disabled.has(id)) await this.runtime.activate(id) }
      catch (error) { await this.runtime.uninstall(id);this.#ownedRecords.delete(id);throw error }
    }
  }
  #manifest(id: string, files: Map<string, Buffer>): PluginManifestV1 {
    const json = files.get('manifest.json')?.toString('utf8'), code = files.get('index.mjs')
    if (!json || !code) throw new Error('Node plugin needs manifest.json and index.mjs')
    const manifest: unknown = JSON.parse(json)
    validatePluginManifest(manifest)
    if (manifest.id !== id) throw new Error('Plugin directory name must match manifest.id')
    if (!manifest.targets.includes('pc-host') || !manifest.permissions.includes('host.trusted') || /^(builtin|core)[.-]/.test(id))
      throw new Error('Node plugin needs pc-host, host.trusted and its own ID')
    this.#manifests.set(id, manifest)
    return manifest
  }
  async #source(id: string, folder: string, revision: string, files: Map<string, Buffer>): Promise<PluginSource> {
    const manifest = this.#manifest(id, files)
    // Stage even disabled versions, before accepting a new revision on disk.
    const staged = path.join(folder, '.mtc-runtime', revision)
    for (const [file, bytes] of files) {
      const target = path.join(staged, file)
      await mkdir(path.dirname(target), {recursive: true})
      await writeFile(target, bytes)
    }
    return {manifest, trust: 'trusted', load: async () => {
      const module = await loadModule(pathToFileURL(path.join(staged, 'index.mjs')).href)
      if (typeof module.default !== 'function') throw new Error('Node plugin must export default activate(ctx, sdk)')
      return {manifest, activate: context => module.default(context, this.sdk)}
    }}
  }
  async close() {
    this.#closed = true
    clearTimeout(this.#timer)
    await this.#tail
  }
  #schedule() {
    if (this.#closed) return
    this.#timer = setTimeout(() => {
      void this.refresh()
        .catch((error) => this.errors.set('@loader', String(error)))
        .finally(() => this.#schedule())
    }, 750)
    this.#timer.unref()
  }
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(work, work)
    this.#tail = task.catch(() => undefined)
    return task
  }
}

function sourceDigest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(file + '\0').update(String(bytes.length) + '\0').update(bytes)
  return hash.digest('hex')
}
async function atomicJson(file: string, value: unknown) {
  await writeFile(file + '.next', JSON.stringify(value))
  await rename(file + '.next', file)
}

async function readSources(folder: string, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  for (const entry of await readdir(path.join(folder, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', '.git', '.mtc-runtime'].includes(entry.name))
      continue
    const file = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) for (const item of await readSources(folder, file)) files.set(...item)
    else if (entry.isFile()) files.set(file, await readFile(path.join(folder, file)))
  }
  return files
}
