export const pluginTargets = ['pc-host', 'pc-ui', 'android-runtime', 'android-ui'] as const
export { parseExecutableClientPackage, type ExecutableClientProgram, type ExecutableClientPackage, type InstalledClientPackage } from './client-package'

export type PluginTarget = typeof pluginTargets[number]
export type PluginTrust = 'builtin' | 'trusted'
export type PluginStatus = 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed'
export type PluginDisposer = () => void | Promise<void>

export interface ContributionRegistrar<T> {
  register(ownerId: string, contribution: T): PluginDisposer
}

export interface PluginManifestV1 {
  readonly manifestVersion: 1
  readonly id: string
  readonly version: string
  readonly displayName: string
  readonly description: string
  readonly targets: readonly PluginTarget[]
  readonly engine: {
    readonly moreThanChat: string
  }
  readonly permissions: readonly string[]
  readonly services?: {
    readonly requires: readonly string[]
    readonly provides?: readonly string[]
  }
}

export interface PluginContext {
  readonly manifest: PluginManifestV1
  readonly target: PluginTarget
  getService<T>(id: string): T
  provideService<T>(id: string, value: T, priority?: number): void
  effect(disposer: PluginDisposer): void
  contribute<T>(registry: ContributionRegistrar<T>, contribution: T): void
}

export interface PluginModule {
  readonly manifest: PluginManifestV1
  activate(context: PluginContext): void | PluginDisposer | Promise<void | PluginDisposer>
  healthCheck?(context: PluginContext): void | Promise<void>
}

export interface PluginModuleNamespace {
  readonly default: PluginModule
}

export interface PluginSource {
  readonly manifest: PluginManifestV1
  readonly trust: PluginTrust
  load(): Promise<PluginModule | PluginModuleNamespace>
}

export interface PluginSnapshot {
  readonly manifest: PluginManifestV1
  readonly trust: PluginTrust
  readonly status: PluginStatus
  readonly error: string | null
}

export interface PluginRuntimeOptions {
  readonly target: PluginTarget
  readonly services?: Readonly<Record<string, unknown>>
  readonly activationDriver?: PluginActivationDriver
}

/** Host-side lifecycle seam. Plugins never receive the implementation. */
export interface PluginActivationDriver {
  activate(module: PluginModule, context: PluginContext): Promise<void | PluginDisposer>
}

interface PluginRecord {
  readonly source: Readonly<PluginSource>
  status: PluginStatus
  error: string | null
  effects: PluginDisposer[]
  module: PluginModule | undefined
  operation: Promise<void>
  terminationRequested: boolean
  uninstallPromise: Promise<void> | undefined
  readonly bindings: Map<string, string>
}

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function validatePluginManifest(value: unknown): asserts value is PluginManifestV1 {
  if (!value || typeof value !== 'object') throw new Error('Plugin manifest must be an object.')
  const manifest = value as Partial<PluginManifestV1>
  if (manifest.manifestVersion !== 1) throw new Error('Unsupported plugin manifest version.')
  if (typeof manifest.id !== 'string' || !pluginIdPattern.test(manifest.id)) {
    throw new Error('Plugin id must contain lowercase letters, numbers, dots, or hyphens.')
  }
  if (typeof manifest.version !== 'string' || !semanticVersionPattern.test(manifest.version)) {
    throw new Error(`Plugin '${manifest.id}' has an invalid semantic version.`)
  }
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim()) {
    throw new Error(`Plugin '${manifest.id}' must have a display name.`)
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    throw new Error(`Plugin '${manifest.id}' must have a description.`)
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0
    || manifest.targets.some(target => !pluginTargets.includes(target))) {
    throw new Error(`Plugin '${manifest.id}' has an invalid target.`)
  }
  if (!manifest.engine || typeof manifest.engine.moreThanChat !== 'string' || !manifest.engine.moreThanChat.trim()) {
    throw new Error(`Plugin '${manifest.id}' must declare a MoreThanChat engine range.`)
  }
  if (!Array.isArray(manifest.permissions) || manifest.permissions.some(permission => typeof permission !== 'string')) {
    throw new Error(`Plugin '${manifest.id}' has invalid permissions.`)
  }
  if (new Set(manifest.permissions).size !== manifest.permissions.length) {
    throw new Error(`Plugin '${manifest.id}' declares duplicate permissions.`)
  }
  if (manifest.services) {
    if (!Array.isArray(manifest.services.requires)
      || manifest.services.requires.some(service => typeof service !== 'string' || !service)) {
      throw new Error(`Plugin '${manifest.id}' has invalid required services.`)
    }
    if (manifest.services.provides && (!Array.isArray(manifest.services.provides)
      || manifest.services.provides.some(service => typeof service !== 'string' || !service))) {
      throw new Error(`Plugin '${manifest.id}' has invalid provided services.`)
    }
  }
}

export function definePlugin(module: PluginModule): PluginModule {
  validatePluginManifest(module.manifest)
  return module
}

/**
 * Lifecycle host for trusted plugins. It deliberately knows nothing about
 * Electron, React, or Node so the same contract can later be hosted on Android.
 */
export class PluginRuntime {
  readonly #target: PluginTarget
  readonly services = new ServiceRegistry()
  readonly #activationDriver: PluginActivationDriver | undefined
  readonly #records = new Map<string, PluginRecord>()
  readonly #listeners = new Set<() => void>()

  constructor(options: PluginRuntimeOptions) {
    this.#target = options.target
    for (const [id, value] of Object.entries(options.services ?? {})) this.services.register('@host', id, value, 10000)
    this.#activationDriver = options.activationDriver
  }

  install(source: PluginSource): void {
    validatePluginManifest(source.manifest)
    const manifest = snapshotManifest(source.manifest)
    if (!manifest.targets.includes(this.#target)) {
      throw new Error(`Plugin '${manifest.id}' does not support target '${this.#target}'.`)
    }
    if (this.#records.has(manifest.id)) {
      throw new Error(`Plugin '${manifest.id}' is already installed.`)
    }
    const load = source.load.bind(source)
    this.#records.set(manifest.id, {
      source: Object.freeze({ manifest, trust: source.trust, load }),
      status: 'inactive',
      error: null,
      effects: [],
      module: undefined,
      operation: Promise.resolve(),
      terminationRequested: false,
      uninstallPromise: undefined,
      bindings: new Map(),
    })
    this.#emit()
  }

  uninstall(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    if (record.uninstallPromise) return record.uninstallPromise

    // Close the record synchronously. Operations accepted before this call stay
    // ordered ahead of uninstall; operations arriving afterwards cannot be
    // queued onto a record that is about to disappear.
    record.terminationRequested = true
    const operation = this.#enqueue(record, async () => {
      await this.#deactivateRecord(id, record)
      if (record.effects.length > 0 || record.status === 'failed') {
        throw new Error(`Plugin '${id}' could not be cleanly uninstalled.`)
      }
      if (this.#records.get(id) === record) {
        this.#records.delete(id)
        this.#emit()
      }
    })
    const trackedOperation = operation.finally(() => {
      if (this.#records.get(id) === record) {
        record.terminationRequested = false
        record.uninstallPromise = undefined
      }
    })
    record.uninstallPromise = trackedOperation
    return trackedOperation
  }

  activate(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    if (record.terminationRequested) {
      return Promise.reject(new Error(`Plugin '${id}' is being uninstalled.`))
    }
    return this.#enqueue(record, async () => {
      if (record.status === 'active') return
      if (record.effects.length > 0) {
        throw new Error(`Plugin '${id}' still has effects awaiting cleanup.`)
      }
      record.status = 'activating'
      record.bindings.clear()
      record.error = null
      this.#emit()

      const effects: PluginDisposer[] = []
      let acceptingEffects = true
      const assertAcceptingEffects = (): void => {
        if (!acceptingEffects) throw new Error(`Plugin '${id}' registered an effect after activation completed.`)
      }
      const trackEffect = (disposer: PluginDisposer): void => {
        assertAcceptingEffects()
        if (typeof disposer !== 'function') throw new Error(`Plugin '${id}' registered an invalid disposer.`)
        effects.push(disposer)
      }
      const context: PluginContext = {
        manifest: record.source.manifest,
        target: this.#target,
        getService: <T>(serviceId: string): T => {
          if (!this.services.has(serviceId)) {
            throw new Error(`Plugin '${id}' requested unavailable service '${serviceId}'.`)
          }
          const selected = this.services.resolve(serviceId)
          record.bindings.set(serviceId, selected.ownerId)
          return selected.value as T
        },
        provideService: <T>(serviceId: string, value: T, priority = record.source.trust === 'builtin' ? 100 : 0): void => {
          assertAcceptingEffects()
          if (!record.source.manifest.services?.provides?.includes(serviceId)) throw new Error(`Plugin '${id}' must declare provided service '${serviceId}'.`)
          trackEffect(this.services.register(id, serviceId, value, priority))
        },
        effect: trackEffect,
        contribute: <T>(registry: ContributionRegistrar<T>, contribution: T): void => {
          assertAcceptingEffects()
          if (!registry || typeof registry.register !== 'function') {
            throw new Error(`Plugin '${id}' requested an invalid contribution registry.`)
          }
          trackEffect(registry.register(id, contribution))
        },
      }

      try {
        for (const serviceId of record.source.manifest.services?.requires ?? []) context.getService(serviceId)
        const loaded = await record.source.load()
        const module = unwrapPluginModule(loaded)
        validatePluginManifest(module.manifest)
        assertMatchingManifest(record.source.manifest, module.manifest)
        if (typeof module.activate !== 'function') throw new Error(`Plugin '${id}' has no activate function.`)

        const dispose = await (this.#activationDriver
          ? this.#activationDriver.activate(module, context)
          : module.activate(context))
        if (dispose !== undefined) context.effect(dispose)
        await module.healthCheck?.(context)
        acceptingEffects = false
        record.module = module
        record.effects = effects
        record.status = 'active'
        record.error = null
        this.#emit()
      }
      catch (error) {
        acceptingEffects = false
        const cleanup = await disposeAll(effects)
        record.module = undefined
        record.effects = cleanup.remaining
        record.status = 'failed'
        record.error = describeActivationError(error, cleanup.errors)
        this.#emit()
        if (cleanup.errors.length > 0) {
          throw new AggregateError([error, ...cleanup.errors], record.error)
        }
        throw error
      }
    })
  }

  deactivate(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    if (record.terminationRequested) {
      return Promise.reject(new Error(`Plugin '${id}' is being uninstalled.`))
    }
    return this.#enqueue(record, () => this.#deactivateRecord(id, record))
  }

  async reload(id: string): Promise<void> {
    await this.deactivate(id)
    await this.activate(id)
  }

  async replace(source: PluginSource): Promise<void> {
    const previous = this.#requireRecord(source.manifest.id).source
    const active = this.#requireRecord(source.manifest.id).status === 'active'
    await this.uninstall(source.manifest.id)
    try { this.install(source); if (active) await this.activate(source.manifest.id) }
    catch (error) {
      await this.uninstall(source.manifest.id)
      this.install(previous); if (active) await this.activate(previous.manifest.id)
      throw error
    }
  }

  list(): PluginSnapshot[] {
    return [...this.#records.values()].map(record => ({
      manifest: record.source.manifest,
      trust: record.source.trust,
      status: record.status,
      error: record.error,
    }))
  }

  subscribe(listener: () => void): PluginDisposer {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  /** Owners actually used by the current activation, including decorators. */
  protected serviceBindings(id: string): ReadonlyMap<string, string> { return this.#requireRecord(id).bindings }

  #requireRecord(id: string): PluginRecord {
    const record = this.#records.get(id)
    if (!record) throw new Error(`Plugin '${id}' is not installed.`)
    return record
  }

  #enqueue(record: PluginRecord, operation: () => Promise<void>): Promise<void> {
    const next = record.operation.catch(() => undefined).then(operation)
    record.operation = next
    return next
  }

  async #deactivateRecord(id: string, record: PluginRecord): Promise<void> {
    if (record.status === 'inactive') return
    if (record.status === 'failed' && record.effects.length === 0) {
      record.status = 'inactive'
      record.error = null
      this.#emit()
      return
    }

    record.status = 'deactivating'
    record.error = null
    record.module = undefined
    this.#emit()

    const cleanup = await disposeAll(record.effects)
    record.effects = cleanup.remaining
    if (cleanup.errors.length > 0) {
      record.status = 'failed'
      record.error = `Plugin '${id}' cleanup failed: ${cleanup.errors.map(formatError).join('; ')}`
      this.#emit()
      throw new AggregateError(cleanup.errors, record.error)
    }

    record.status = 'inactive'
    record.error = null
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      }
      catch {
        // A UI subscriber must not be able to corrupt plugin lifecycle state.
      }
    }
  }
}

/** Providers are effects, including built-ins. Lower priorities override defaults. */
export class ServiceRegistry {
  readonly #entries: { ownerId: string; id: string; value: unknown; priority: number }[] = []
  readonly #listeners = new Set<() => void>()
  readonly #ownerOrder = new Map<string, number>()
  register(ownerId: string, id: string, value: unknown, priority = 0): PluginDisposer {
    if (!id || !Number.isFinite(priority)) throw new Error('Invalid service registration.')
    if (this.#entries.some(entry => entry.ownerId === ownerId && entry.id === id)) throw new Error(`Duplicate service '${id}' from '${ownerId}'.`)
    const entry = { ownerId, id, value, priority }
    if (!this.#ownerOrder.has(ownerId)) this.#ownerOrder.set(ownerId, this.#ownerOrder.size)
    this.#entries.push(entry); this.#emit()
    return () => { const index = this.#entries.indexOf(entry); if (index >= 0) { this.#entries.splice(index, 1); this.#emit() } }
  }
  has(id: string): boolean { return this.#entries.some(entry => entry.id === id) }
  get<T>(id: string): T {
    return this.resolve(id).value as T
  }
  resolve(id: string): {readonly ownerId: string; readonly value: unknown} {
    const entry = this.#entries.filter(entry => entry.id === id).sort((a, b) => a.priority - b.priority || this.#ownerOrder.get(a.ownerId)! - this.#ownerOrder.get(b.ownerId)!)[0]
    if (!entry) throw new Error(`Unavailable service '${id}'.`)
    return entry
  }
  list() { return this.#entries.map(({ ownerId, id, priority }) => ({ ownerId, id, priority })) }
  subscribe(listener: () => void): PluginDisposer { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  #emit() { for (const listener of this.#listeners) { try { listener() } catch {} } }
}

/** One composition path for built-in and installed modules. Dependency consumers
 * are stopped before providers, then rebound after a provider change. */
export class ComposedPluginRuntime extends PluginRuntime {
  readonly #sources = new Map<string, PluginSource>()
  readonly #wanted = new Set<string>()
  readonly #removing = new Set<string>()
  #tail: Promise<unknown> = Promise.resolve()
  #composing = false
  readonly #compositionListeners = new Set<() => void>()
  get isComposing(): boolean { return this.#composing }
  subscribeComposition(listener: () => void): PluginDisposer { this.#compositionListeners.add(listener); return () => { this.#compositionListeners.delete(listener) } }

  override install(source: PluginSource): void { super.install(source); this.#remember(source) }
  desired(id: string): boolean { return this.#wanted.has(id) }
  async start(ids: readonly string[] = this.list().map(item => item.manifest.id), allowWaiting = false): Promise<void> {
    return this.#enqueueComposition(async () => {
      for (const id of ids) { this.#source(id); this.#wanted.add(id) }
      await this.#resume()
      const waiting = this.list().filter(item => this.#wanted.has(item.manifest.id) && item.status !== 'active')
      if (waiting.length && !allowWaiting) throw new Error('Unresolved plugin dependencies: ' + waiting.map(item => item.manifest.id).join(', '))
    })
  }
  override activate(id: string): Promise<void> {
    if (this.#removing.has(id)) return Promise.reject(new Error(`Plugin '${id}' is being uninstalled.`))
    this.#source(id)
    return this.#enqueueComposition(async () => {
      const wasWanted = this.#wanted.has(id), active = this.#activeIds()
      this.#wanted.add(id)
      if (this.list().find(item => item.manifest.id === id)?.status === 'active') return
      const missing = this.#source(id).manifest.services?.requires.find(service => !this.services.has(service))
      if (missing) throw new Error(`Plugin '${id}' requested unavailable service '${missing}'.`)
      await this.#suspend(new Set(this.#source(id).manifest.services?.provides ?? []), id)
      try {
        await super.activate(id)
        await this.#resume(id)
        this.#assertRestored(active, id)
      } catch (error) {
        await this.#suspend(new Set(this.#source(id).manifest.services?.provides ?? []), id)
        if (this.list().find(item => item.manifest.id === id)?.status === 'active') await super.deactivate(id)
        if (!wasWanted) this.#wanted.delete(id)
        await this.#resetFailed(active)
        await this.#resume(id)
        throw error
      }
    })
  }
  override deactivate(id: string): Promise<void> {
    this.#source(id)
    return this.#enqueueComposition(async () => {
      this.#wanted.delete(id)
      await this.#suspend(new Set(this.#source(id).manifest.services?.provides ?? []), id)
      await super.deactivate(id)
      await this.#resume(id)
    })
  }
  override uninstall(id: string): Promise<void> {
    this.#source(id); this.#removing.add(id)
    return this.#enqueueComposition(async () => {
      try {
        this.#wanted.delete(id)
        await this.#suspend(new Set(this.#source(id).manifest.services?.provides ?? []), id)
        await super.uninstall(id); this.#sources.delete(id)
        await this.#resume(id)
      } finally { this.#removing.delete(id) }
    })
  }
  override replace(source: PluginSource): Promise<void> {
    validatePluginManifest(source.manifest)
    return this.#enqueueComposition(async () => {
      const id = source.manifest.id, previous = this.#source(id), wanted = this.#wanted.has(id), active = this.#activeIds()
      const changed = new Set([...(previous.manifest.services?.provides ?? []), ...(source.manifest.services?.provides ?? [])])
      await this.#suspend(changed, id)
      await super.uninstall(id)
      try {
        super.install(source); this.#remember(source)
        if (wanted) await super.activate(id)
        await this.#resume(id)
        this.#assertRestored(active, id)
      } catch (error) {
        await this.#suspend(changed, id)
        if (this.list().some(item => item.manifest.id === id)) await super.uninstall(id)
        super.install(previous); this.#remember(previous)
        await this.#resetFailed(active)
        if (active.has(id)) await super.activate(id)
        await this.#resume(id)
        throw error
      }
    })
  }
  override reload(id: string): Promise<void> { return this.replace(this.#source(id)) }
  stopAll(): Promise<void> {
    return this.#enqueueComposition(async()=>{
      this.#wanted.clear()
      const errors:unknown[]=[]
      for(const item of this.list())try {
        await this.#suspend(new Set(item.manifest.services?.provides??[]),item.manifest.id)
        await super.deactivate(item.manifest.id)
      }catch(error){errors.push(error)}
      if(errors.length)throw new AggregateError(errors,'Plugin cleanup failed.')
    })
  }
  #source(id: string): PluginSource { const source = this.#sources.get(id); if (!source) throw new Error(`Plugin '${id}' is not installed.`); return source }
  #remember(source: PluginSource): void {
    this.#sources.set(source.manifest.id, Object.freeze({manifest: snapshotManifest(source.manifest), trust: source.trust, load: source.load.bind(source)}))
  }
  #activeIds(): Set<string> { return new Set(this.list().filter(item => item.status === 'active').map(item => item.manifest.id)) }
  #assertRestored(active: Set<string>, owner: string): void {
    const waiting = this.list().filter(item => item.manifest.id !== owner && active.has(item.manifest.id) && item.status !== 'active')
    if (waiting.length) throw new Error('Plugin update left active consumers unavailable: ' + waiting.map(item => item.manifest.id).join(', '))
  }
  async #resetFailed(active: Set<string>): Promise<void> {
    for (const item of this.list()) if (active.has(item.manifest.id) && item.status === 'failed') await super.deactivate(item.manifest.id)
  }
  #enqueueComposition<T>(work: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.#composing = true
      try { return await work() }
      finally {
        this.#composing = false
        for (const listener of this.#compositionListeners) { try { listener() } catch {} }
      }
    }
    const task = this.#tail.then(run, run); this.#tail = task.catch(() => undefined); return task
  }
  #upstream(owner: string): Set<string> {
    const upstream = new Set<string>([owner])
    const visit = (id: string) => {
      const item = this.list().find(item => item.manifest.id === id)
      if (!item) return
      const dependencies = item.status === 'active'
        ? [...this.serviceBindings(id).values()]
        : (item.manifest.services?.requires ?? []).filter(service => this.services.has(service)).map(service => this.services.resolve(service).ownerId)
      for (const dependency of dependencies) if (!upstream.has(dependency)) {upstream.add(dependency);visit(dependency)}
    }
    visit(owner)
    return upstream
  }
  async #suspend(changed: Set<string>, owner: string): Promise<string[]> {
    const affected = new Set<string>(), ordered: string[] = []
    const upstream = this.#upstream(owner)
    const visit = (services: Set<string>) => {
      for (const item of this.list()) {
        const id = item.manifest.id
        if (upstream.has(id) || affected.has(id) || item.status !== 'active' || !item.manifest.services?.requires.some(service => services.has(service))) continue
        affected.add(id)
        visit(new Set(item.manifest.services.provides ?? []))
        ordered.push(id)
      }
    }
    visit(changed)
    for (const id of ordered) await super.deactivate(id)
    return ordered
  }
  async #resume(skip?: string): Promise<void> {
    const attempted = new Set<string>(), errors: unknown[] = []
    let activations = 0
    const limit = Math.max(8, this.list().length ** 2 * 2)
    let progress = true
    while (progress) {
      progress = false
      for (const item of this.list()) {
        const id = item.manifest.id
        const status = this.list().find(record => record.manifest.id === id)?.status
        if (id === skip || attempted.has(id) || !this.#wanted.has(id) || status === 'active' || status === 'failed') continue
        if (!item.manifest.services?.requires.every(service => this.services.has(service)) && item.manifest.services?.requires.length) continue
        attempted.add(id)
        if (++activations > limit) throw new Error('Plugin service dependencies could not settle.')
        try {
          // A waiting replacement may become ready after another provider loads.
          // Rebind existing consumers just as for an explicit enable operation.
          for (const stopped of await this.#suspend(new Set(item.manifest.services?.provides ?? []), id)) attempted.delete(stopped)
          await super.activate(id); progress = true
        } catch (error) { errors.push(error) }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Plugin composition could not activate: ' + errors.map(String).join('; '))
  }
}

export interface RegisteredContribution<T> {
  readonly ownerId: string
  readonly contribution: T
}

export class ContributionRegistry<T extends { readonly id: string }> implements ContributionRegistrar<T> {
  readonly #entries = new Map<string, RegisteredContribution<T>>()
  readonly #listeners = new Set<() => void>()

  register(ownerId: string, contribution: T): PluginDisposer {
    if (!ownerId || !contribution.id) throw new Error('Contribution owner and id are required.')
    const key = `${ownerId}:${contribution.id}`
    if (this.#entries.has(key)) throw new Error(`Contribution '${key}' is already registered.`)
    const entry = { ownerId, contribution }
    this.#entries.set(key, entry)
    this.#emit()

    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#entries.get(key) === entry) {
        this.#entries.delete(key)
        this.#emit()
      }
    }
  }

  list(): RegisteredContribution<T>[] {
    return [...this.#entries.values()]
  }

  subscribe(listener: () => void): PluginDisposer {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      }
      catch {
        // Contribution registration must remain atomic even if a view fails.
      }
    }
  }
}

export const composerActionsServiceId = 'ui.composer-actions'
export const uiSlotsServiceId = 'ui.slots'
/** Renderer-specific hosts decide how to render this generic, platform-neutral contribution. */
export interface UiSlotContribution { readonly id:string; readonly slot:string; readonly order?:number; render(context:unknown):unknown }
/** Executable UI composition, separate from the legacy data-only group placements. */
export const uiSurfacesServiceId = 'ui.surfaces'
export interface UiSurfaceInput {
  readonly context: unknown
  readonly defaultView: unknown
  renderSurface(name: string, context?: unknown, fallback?: unknown): unknown
}
export interface UiSurfaceContribution {
  readonly id: string
  readonly surface: string
  /** Lower priorities win. Equal priorities retain registration order. */
  readonly priority?: number
  render(input: UiSurfaceInput): unknown
}
export class UiSurfaceRegistry extends ContributionRegistry<UiSurfaceContribution> {
  readonly #instanceOwners = new Map<string,string>()
  /** A selected conversation instance shadows only its own local package's surfaces. */
  registerInstance(ownerId:string,localOwnerId:string,contribution:UiSurfaceContribution):PluginDisposer {
    const previous=this.#instanceOwners.get(ownerId)
    this.#instanceOwners.set(ownerId,localOwnerId)
    try {
      const dispose=this.register(ownerId,contribution)
      return()=>{
        const result=dispose()
        if(!this.list().some(entry=>entry.ownerId===ownerId))this.#instanceOwners.delete(ownerId)
        return result
      }
    }catch(error){if(previous===undefined)this.#instanceOwners.delete(ownerId);else this.#instanceOwners.set(ownerId,previous);throw error}
  }
  override register(ownerId: string, contribution: UiSurfaceContribution): PluginDisposer {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(contribution.surface)) throw new Error('Invalid UI surface name.')
    if (typeof contribution.render !== 'function' || !Number.isFinite(contribution.priority ?? 0)) throw new Error('Invalid UI surface contribution.')
    return super.register(ownerId, Object.freeze({ ...contribution }))
  }
  resolve(name: string): RegisteredContribution<UiSurfaceContribution> | undefined {
    return this.resolveAll(name)[0]
  }
  resolveAll(name: string): RegisteredContribution<UiSurfaceContribution>[] {
    const entries=this.list().filter(entry=>entry.contribution.surface===name)
    const shadowed=new Set(entries.map(entry=>this.#instanceOwners.get(entry.ownerId)).filter(Boolean))
    return entries.filter(entry=>!shadowed.has(entry.ownerId))
      .sort((a, b) => (a.contribution.priority ?? 0) - (b.contribution.priority ?? 0))
  }
}
export const hostToolsServiceId = 'host.tools'

/** Trusted host tool contract. Only serializable results cross the IPC boundary. */
export interface HostTool {
  readonly id: string
  readonly label: string
  readonly replacesDraft?: boolean
  run(input?: string): string | Promise<string>
}

export interface ComposerActionContext {
  readonly draft: string
  readonly conversationId: string
  readonly conversationTitle: string
  readonly now: number
}

export interface ComposerActionResult {
  readonly draft: string
  readonly notice?: string
}

export interface ComposerAction {
  readonly id: string
  readonly label: string
  readonly description: string
  run(context: ComposerActionContext): ComposerActionResult | Promise<ComposerActionResult>
}

function unwrapPluginModule(loaded: PluginModule | PluginModuleNamespace): PluginModule {
  if ('default' in loaded) return loaded.default
  return loaded
}

function assertMatchingManifest(expected: PluginManifestV1, actual: PluginManifestV1): void {
  const expectedValue = manifestFingerprint(expected)
  const actualValue = manifestFingerprint(actual)
  if (expectedValue !== actualValue) {
    throw new Error(`Loaded manifest for '${expected.id}' does not match its catalog entry.`)
  }
}

function manifestFingerprint(manifest: PluginManifestV1): string {
  return JSON.stringify({
    manifestVersion: manifest.manifestVersion,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    targets: [...manifest.targets].sort(),
    engine: { moreThanChat: manifest.engine.moreThanChat },
    permissions: [...manifest.permissions].sort(),
    services: {
      requires: [...(manifest.services?.requires ?? [])].sort(),
      provides: [...(manifest.services?.provides ?? [])].sort(),
    },
  })
}

function snapshotManifest(manifest: PluginManifestV1): PluginManifestV1 {
  const services = manifest.services === undefined
    ? undefined
    : Object.freeze({
        requires: Object.freeze([...manifest.services.requires]),
        ...(manifest.services.provides === undefined
          ? {}
          : { provides: Object.freeze([...manifest.services.provides]) }),
      })

  return Object.freeze({
    manifestVersion: manifest.manifestVersion,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    targets: Object.freeze([...manifest.targets]),
    engine: Object.freeze({ moreThanChat: manifest.engine.moreThanChat }),
    permissions: Object.freeze([...manifest.permissions]),
    ...(services === undefined ? {} : { services }),
  })
}

interface DisposeResult {
  readonly errors: unknown[]
  readonly remaining: PluginDisposer[]
}

async function disposeAll(effects: readonly PluginDisposer[]): Promise<DisposeResult> {
  const errors: unknown[] = []
  const remainingInCleanupOrder: PluginDisposer[] = []
  for (const dispose of [...effects].reverse()) {
    try {
      await dispose()
    }
    catch (error) {
      errors.push(error)
      remainingInCleanupOrder.push(dispose)
    }
  }
  return { errors, remaining: remainingInCleanupOrder.reverse() }
}

function describeActivationError(error: unknown, cleanupErrors: readonly unknown[]): string {
  const base = `Activation failed: ${formatError(error)}`
  if (cleanupErrors.length === 0) return base
  return `${base}; rollback failed: ${cleanupErrors.map(formatError).join('; ')}`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
