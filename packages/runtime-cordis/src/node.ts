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
  #disabled = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false
  #prepared: Promise<void> | undefined
  constructor(
    readonly directory: string,
    readonly runtime: Pick<
      PluginRuntime,
      'install' | 'activate' | 'deactivate' | 'replace' | 'uninstall' | 'list'
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
  async setEnabled(id: string, enabled: boolean) {
    return this.#enqueue(async () => {
      if (!this.runtime.list().some((p) => p.manifest.id === id))
        throw new Error('Unknown local Node plugin')
      const next = new Set(this.#disabled), wasDisabled = this.#disabled.has(id)
      if (enabled) {
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
        await this.runtime.deactivate(id)
      }
    }).then(() => this.refresh())
  }
  async #saveDisabled(disabled: Set<string>) {
    await atomicJson(path.join(this.directory, 'disabled.json'), [...disabled])
    this.#disabled = disabled
  }
  refresh(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) return
      const present = new Set<string>()
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\w[\w.-]*$/.test(entry.name))
          continue
        const folder = path.join(this.directory, entry.name)
        let digest: string | undefined
        let committing = false
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
          if (this.#rejected.get(entry.name) === digest) {
            present.add(entry.name)
            continue
          }
          const id = entry.name
          present.add(id)
          if (this.#loaded.get(id)?.digest === digest) {this.errors.delete(id);this.#rejected.delete(id);continue}
          // Do not overwrite the accepted revision with unexecuted edits while
          // disabled. Apply those edits after the user enables the plugin.
          if (this.#loaded.has(id) && this.#disabled.has(id)) continue
          const source = await this.#source(id, folder, digest, files), previous = this.#loaded.get(id)
          await this.#apply(id, source)
          committing = true
          try { await atomicJson(path.join(folder, '.mtc-runtime', 'current.json'), digest) }
          catch (error) {
            if (previous) await this.runtime.replace(previous.source)
            else await this.runtime.uninstall(id)
            throw error
          }
          this.#loaded.set(id, { digest, source })
          this.errors.delete(entry.name)
          this.#rejected.delete(id)
        } catch (error) {
          this.errors.set(entry.name, error instanceof Error ? error.message : String(error))
          if (digest && !committing && this.#loaded.has(entry.name)) this.#rejected.set(entry.name, digest)
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
      for (const id of this.#loaded.keys())
        if (!present.has(id) && !folders.has(id)) {
          await this.runtime.uninstall(id)
          this.#loaded.delete(id)
        }
      for (const id of this.errors.keys())
        if (id !== '@loader' && !folders.has(id)) this.errors.delete(id)
      for (const id of this.#rejected.keys()) if (!folders.has(id)) this.#rejected.delete(id)
    })
  }
  async #apply(id: string, source: PluginSource) {
    if (this.#loaded.has(id)) await this.runtime.replace(source)
    else {
      this.runtime.install(source)
      try { if (!this.#disabled.has(id)) await this.runtime.activate(id) }
      catch (error) { await this.runtime.uninstall(id); throw error }
    }
  }
  async #source(id: string, folder: string, revision: string, files: Map<string, Buffer>): Promise<PluginSource> {
    const json = files.get('manifest.json')?.toString('utf8'), code = files.get('index.mjs')
    if (!json || !code) throw new Error('Node plugin needs manifest.json and index.mjs')
    const manifest: unknown = JSON.parse(json)
    validatePluginManifest(manifest)
    if (manifest.id !== id) throw new Error('Plugin directory name must match manifest.id')
    if (!manifest.targets.includes('pc-host') || !manifest.permissions.includes('host.trusted') || /^(builtin|core)[.-]/.test(id))
      throw new Error('Node plugin needs pc-host, host.trusted and its own ID')
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
