export const pluginTargets = ['pc-host', 'pc-ui', 'android-runtime', 'android-ui'] as const

export type PluginTarget = typeof pluginTargets[number]
export type PluginTrust = 'builtin' | 'trusted'
export type PluginStatus = 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed'
export type PluginDisposer = () => void | Promise<void>

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
  effect(disposer: PluginDisposer): void
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
}

interface PluginRecord {
  readonly source: PluginSource
  status: PluginStatus
  error: string | null
  effects: PluginDisposer[]
  module: PluginModule | undefined
  operation: Promise<void>
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
  readonly #services: Readonly<Record<string, unknown>>
  readonly #records = new Map<string, PluginRecord>()
  readonly #listeners = new Set<() => void>()

  constructor(options: PluginRuntimeOptions) {
    this.#target = options.target
    this.#services = options.services ?? {}
  }

  install(source: PluginSource): void {
    validatePluginManifest(source.manifest)
    if (!source.manifest.targets.includes(this.#target)) {
      throw new Error(`Plugin '${source.manifest.id}' does not support target '${this.#target}'.`)
    }
    if (this.#records.has(source.manifest.id)) {
      throw new Error(`Plugin '${source.manifest.id}' is already installed.`)
    }
    this.#records.set(source.manifest.id, {
      source,
      status: 'inactive',
      error: null,
      effects: [],
      module: undefined,
      operation: Promise.resolve(),
    })
    this.#emit()
  }

  async uninstall(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    await this.deactivate(id)
    if (record.status === 'failed') throw new Error(`Plugin '${id}' could not be cleanly uninstalled.`)
    this.#records.delete(id)
    this.#emit()
  }

  activate(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    return this.#enqueue(record, async () => {
      if (record.status === 'active') return
      record.status = 'activating'
      record.error = null
      this.#emit()

      const effects: PluginDisposer[] = []
      let acceptingEffects = true
      const context: PluginContext = {
        manifest: record.source.manifest,
        target: this.#target,
        getService: <T>(serviceId: string): T => {
          if (!Object.prototype.hasOwnProperty.call(this.#services, serviceId)) {
            throw new Error(`Plugin '${id}' requested unavailable service '${serviceId}'.`)
          }
          return this.#services[serviceId] as T
        },
        effect: (disposer: PluginDisposer): void => {
          if (!acceptingEffects) throw new Error(`Plugin '${id}' registered an effect after activation completed.`)
          if (typeof disposer !== 'function') throw new Error(`Plugin '${id}' registered an invalid disposer.`)
          effects.push(disposer)
        },
      }

      try {
        for (const serviceId of record.source.manifest.services?.requires ?? []) context.getService(serviceId)
        const loaded = await record.source.load()
        const module = unwrapPluginModule(loaded)
        validatePluginManifest(module.manifest)
        assertMatchingManifest(record.source.manifest, module.manifest)
        if (typeof module.activate !== 'function') throw new Error(`Plugin '${id}' has no activate function.`)

        const dispose = await module.activate(context)
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
        const cleanupErrors = await disposeAll(effects)
        record.module = undefined
        record.effects = []
        record.status = 'failed'
        record.error = describeActivationError(error, cleanupErrors)
        this.#emit()
        if (cleanupErrors.length > 0) {
          throw new AggregateError([error, ...cleanupErrors], record.error)
        }
        throw error
      }
    })
  }

  deactivate(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    return this.#enqueue(record, async () => {
      if (record.status === 'inactive') return
      if (record.status === 'failed' && record.effects.length === 0) {
        record.status = 'inactive'
        record.error = null
        this.#emit()
        return
      }

      record.status = 'deactivating'
      record.error = null
      const effects = record.effects
      record.effects = []
      record.module = undefined
      this.#emit()

      const cleanupErrors = await disposeAll(effects)
      if (cleanupErrors.length > 0) {
        record.status = 'failed'
        record.error = `Plugin '${id}' cleanup failed: ${cleanupErrors.map(formatError).join('; ')}`
        this.#emit()
        throw new AggregateError(cleanupErrors, record.error)
      }

      record.status = 'inactive'
      record.error = null
      this.#emit()
    })
  }

  async reload(id: string): Promise<void> {
    await this.deactivate(id)
    await this.activate(id)
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

export interface RegisteredContribution<T> {
  readonly ownerId: string
  readonly contribution: T
}

export class ContributionRegistry<T extends { readonly id: string }> {
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

async function disposeAll(effects: readonly PluginDisposer[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const dispose of [...effects].reverse()) {
    try {
      await dispose()
    }
    catch (error) {
      errors.push(error)
    }
  }
  return errors
}

function describeActivationError(error: unknown, cleanupErrors: readonly unknown[]): string {
  const base = `Activation failed: ${formatError(error)}`
  if (cleanupErrors.length === 0) return base
  return `${base}; rollback failed: ${cleanupErrors.map(formatError).join('; ')}`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
