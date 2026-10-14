import type { InstalledClientPackage } from '@more-than-chat/plugin-runtime'
import type { ClientPluginLoader } from './client-plugin-loader'

export interface ClientPluginBridge {
  getClientPlugins(): Promise<InstalledClientPackage[]>
  saveClientPlugin(pack: InstalledClientPackage, enabled: boolean): Promise<InstalledClientPackage>
}

/** Activate first, persist only working versions. All UI actions share this queue. */
export class ClientPluginController {
  readonly errors = new Map<string, string>()
  #tail: Promise<unknown> = Promise.resolve()
  #started?: Promise<void>
  constructor(readonly loader: ClientPluginLoader, readonly bridge: ClientPluginBridge, readonly changed: () => void) {}
  start(): Promise<void> {
    return this.#started ??= this.#enqueue(async () => {
      for (const pack of await this.bridge.getClientPlugins()) {
        if (!pack.enabled) continue
        try {await this.loader.enable(pack)}
        catch (error) {this.errors.set(pack.manifest.id, message(error))}
      }
    })
  }
  apply(pack: InstalledClientPackage): Promise<void> {
    return this.#enqueue(async () => {
      const id = pack.manifest.id, previous = this.loader.current(id), wasActive = this.loader.isActive(id)
      try {
        await this.loader.enable(pack)
        try {await this.bridge.saveClientPlugin(pack, true)}
        catch (error) {
          if (previous) {await this.loader.enable(previous); if (!wasActive) await this.loader.disable(id)}
          else await this.loader.remove(id)
          throw error
        }
        this.errors.delete(id)
      } catch (error) {this.errors.set(id, message(error)); throw error}
    })
  }
  disable(pack: InstalledClientPackage): Promise<void> {
    return this.#enqueue(async () => {
      // Even if a badly written disposer fails, the next launch remains disabled.
      await this.bridge.saveClientPlugin(pack, false)
      if (this.loader.current(pack.manifest.id)) await this.loader.disable(pack.manifest.id)
      this.errors.delete(pack.manifest.id)
    })
  }
  #enqueue(work: () => Promise<void>): Promise<void> {
    const task = this.#tail.then(work).finally(this.changed)
    this.#tail = task.catch(() => undefined)
    return task
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : '插件操作失败' }
