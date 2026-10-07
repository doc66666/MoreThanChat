import { Context, ScopeStatus } from '@cordisjs/core'
import {
  PluginRuntime,
  type PluginActivationDriver,
  type PluginContext,
  type PluginDisposer,
  type PluginModule,
  type PluginRuntimeOptions,
  type PluginSource,
} from '@more-than-chat/plugin-runtime'

export const CORDIS_ENGINE_VERSION = '3.18.1' as const
export type CordisRuntimeOptions = Omit<PluginRuntimeOptions, 'activationDriver'>

/** Public MoreThanChat lifecycle contract; Cordis contexts/scopes stay private. */
export class CordisPluginRuntime extends PluginRuntime {
  readonly #driver: CordisActivationDriver
  #closing = false
  #closePromise: Promise<void> | undefined

  constructor(options: CordisRuntimeOptions) {
    const driver = new CordisActivationDriver(options.services ?? {})
    super({ ...options, activationDriver: driver })
    this.#driver = driver
  }

  override install(source: PluginSource): void {
    if (this.#closing) throw new Error('Cordis runtime is closing.')
    super.install(source)
  }

  override activate(id: string): Promise<void> {
    if (this.#closing) return Promise.reject(new Error('Cordis runtime is closing.'))
    return super.activate(id)
  }

  getDiagnostics(): { engine: 'cordis'; engineVersion: string; registeredScopes: number; closing: boolean } {
    return { engine: 'cordis', engineVersion: CORDIS_ENGINE_VERSION, registeredScopes: this.#driver.scopeCount, closing: this.#closing }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    const operation = this.#close()
    this.#closePromise = operation
    // Keep the runtime closed to new work, but allow cleanup to be retried.
    void operation.catch(() => { if (this.#closePromise === operation) this.#closePromise = undefined })
    return operation
  }

  async #close(): Promise<void> {
    const results = await Promise.allSettled(this.list().map(plugin => this.deactivate(plugin.manifest.id)))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Cordis runtime cleanup failed.')
    await this.#driver.close()
  }
}

class CordisActivationDriver implements PluginActivationDriver {
  readonly #root = new Context()
  readonly #baselineScopes = this.#root.registry.size
  #closed = false

  constructor(services: Readonly<Record<string, unknown>>) {
    for (const [id, value] of Object.entries(services)) this.#root.set(id, value)
  }

  get scopeCount(): number { return this.#root.registry.size - this.#baselineScopes }

  async activate(module: PluginModule, context: PluginContext): Promise<void | PluginDisposer> {
    if (this.#closed) throw new Error('Cordis activation driver is closed.')
    let dispose: void | PluginDisposer = undefined
    const scope = this.#root.plugin({
      name: context.manifest.id,
      inject: [...(context.manifest.services?.requires ?? [])],
      apply: async () => {
        // Register the scope's cleanup first so plugin effects clean up before
        // their Cordis owner disappears. Never expose this Context to plugins.
        await Promise.resolve()
        dispose = await module.activate(context)
      },
    })
    context.effect(() => { scope.dispose() })
    await this.#root.lifecycle.flush()
    // Cordis records async failures rather than rejecting flush(). Translate
    // them back into the SDK's activation/rollback error contract.
    if (scope.runtime.status === ScopeStatus.FAILED) throw scope.runtime.error
    if (scope.runtime.status !== ScopeStatus.ACTIVE) throw new Error(`Cordis scope for '${context.manifest.id}' did not become active.`)
    return dispose
  }

  async close(): Promise<void> {
    if (this.#closed) return
    if (this.scopeCount !== 0) throw new Error('Cannot close Cordis while plugin scopes remain.')
    await this.#root.stop()
    this.#closed = true
  }
}
