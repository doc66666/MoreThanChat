import type { InstalledClientPackage, PluginRuntime, PluginContext, PluginDisposer } from '@more-than-chat/plugin-runtime'

export type ClientModule = {default: (context: PluginContext, sdk: unknown) => void | PluginDisposer | Promise<void | PluginDisposer>}

/** Serial hot replacement with rollback of lifecycle-managed effects. Not a JS sandbox. */
export class ClientPluginLoader {
  readonly #packages = new Map<string, InstalledClientPackage>()
  #tail: Promise<unknown> = Promise.resolve()
  constructor(readonly runtime: PluginRuntime, readonly sdk: unknown, readonly load: (code: string) => Promise<ClientModule>) {}
  current(id: string): InstalledClientPackage | undefined { return this.#packages.get(id) }
  isActive(id: string): boolean { return this.runtime.list().some(p => p.manifest.id === id && p.status === 'active') }
  remove(id: string): Promise<void> { return this.#enqueue(async () => {await this.runtime.uninstall(id); this.#packages.delete(id)}) }
  enable(pack: InstalledClientPackage): Promise<void> {
    return this.#enqueue(async () => {
      const id = pack.manifest.id, previous = this.#packages.get(id)
      const wasActive = this.runtime.list().some(p => p.manifest.id === id && p.status === 'active')
      if (!previous && this.runtime.list().some(p => p.manifest.id === id)) throw new Error('插件 ID 已被其他运行时占用')
      if (previous?.digest === pack.digest) {await this.runtime.activate(id); return}
      if (previous) await this.runtime.uninstall(id)
      try { this.#install(pack); await this.runtime.activate(id) }
      catch (error) {
        // If cleanup fails, retain the failed record for retry/recovery, never install over it.
        await this.runtime.uninstall(id)
        this.#packages.delete(id)
        if (previous) {this.#install(previous); if (wasActive) await this.runtime.activate(id)}
        throw error
      }
    })
  }
  disable(id: string): Promise<void> { return this.#enqueue(() => this.runtime.deactivate(id)) }
  #install(pack: InstalledClientPackage): void {
    this.runtime.install({manifest: pack.manifest, trust: 'trusted', load: async () => {
      const module = await this.load(pack.program.code)
      if (typeof module.default !== 'function') throw new Error('界面模块需要 export default function activate(ctx, sdk)')
      return {manifest: pack.manifest, activate: context => module.default(context, this.sdk)}
    }})
    this.#packages.set(pack.manifest.id, pack)
  }
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(work, work)
    this.#tail = task.catch(() => undefined)
    return task
  }
}

export async function importClientModule(code: string): Promise<ClientModule> {
  const url = URL.createObjectURL(new Blob([code], {type: 'text/javascript'}))
  try { return await import(/* @vite-ignore */ url) as ClientModule }
  finally { URL.revokeObjectURL(url) }
}
