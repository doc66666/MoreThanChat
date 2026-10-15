import type { InstalledClientPackage } from '@more-than-chat/plugin-runtime'
import type { ClientPluginLoader } from './client-plugin-loader'

export interface ClientPluginBridge {
  getClientPlugins(): Promise<InstalledClientPackage[]>
  saveClientPlugin(pack: InstalledClientPackage, enabled: boolean): Promise<InstalledClientPackage>
  removeClientPlugin?(id:string,version:string):Promise<void>
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
    return this.#enqueue(() => this.#apply(pack))
  }
  enableInstalled(pack: InstalledClientPackage): Promise<void> {
    return this.#enqueue(async () => {
      const current = (await this.bridge.getClientPlugins()).find(p => p.manifest.id === pack.manifest.id)
      if (!current || current.digest !== pack.digest) throw new Error('插件已变化，请刷新后重试')
      await this.#apply(current)
    })
  }
  async #apply(pack: InstalledClientPackage): Promise<void> {
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
  }
  disable(pack: InstalledClientPackage): Promise<void> {
    return this.#enqueue(async () => {
      const current = (await this.bridge.getClientPlugins()).find(p => p.manifest.id === pack.manifest.id)
      if (!current || current.digest !== pack.digest) throw new Error('插件已变化，请刷新后重试')
      // Even if a badly written disposer fails, the next launch remains disabled.
      await this.bridge.saveClientPlugin(current, false)
      if (this.loader.current(pack.manifest.id)) await this.loader.disable(pack.manifest.id)
      this.errors.delete(pack.manifest.id)
    })
  }
  uninstall(id:string,version:string):Promise<void> {
    return this.#enqueue(async()=>{
      if(!this.bridge.removeClientPlugin)throw new Error('卸载服务不可用')
      const current=(await this.bridge.getClientPlugins()).find(p=>p.manifest.id===id)
      if(!current||current.manifest.version!==version)throw new Error('插件已变化，请刷新后重试')
      try {
        // Keep a disabled, visible record until cleanup succeeds. Failed cleanup
        // must remain retryable, and must not reactivate on the next launch.
        await this.bridge.saveClientPlugin(current,false)
        if(this.loader.current(id))await this.loader.disable(id)
        await this.bridge.removeClientPlugin(id,version)
        if(this.loader.current(id))await this.loader.remove(id)
        this.errors.delete(id)
      } catch(error) {this.errors.set(id,message(error));throw error}
    })
  }
  #enqueue(work: () => Promise<void>): Promise<void> {
    const task = this.#tail.then(work).finally(this.changed)
    this.#tail = task.catch(() => undefined)
    return task
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : '插件操作失败' }
