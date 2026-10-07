import { describe, expect, it, vi } from 'vitest'
import {
  ContributionRegistry,
  PluginRuntime,
  definePlugin,
  type PluginManifestV1,
  type PluginSource,
  type PluginTarget,
} from '../src/index.js'
import { fixtureManifest } from './fixtures/hello-manifest.js'
import type { TestAction } from './fixtures/hello-plugin.js'

function createFixture() {
  const actions = new ContributionRegistry<TestAction>()
  const load = vi.fn(() => import('./fixtures/hello-plugin.js'))
  const runtime = new PluginRuntime({ target: 'pc-ui', services: { 'test.actions': actions } })
  runtime.install({ manifest: fixtureManifest, trust: 'builtin', load })
  return { actions, load, runtime }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('PluginRuntime', () => {
  it('dynamically loads and executes a real plugin module', async () => {
    const { actions, load, runtime } = createFixture()
    expect(runtime.list()[0]?.status).toBe('inactive')

    await runtime.activate(fixtureManifest.id)

    expect(load).toHaveBeenCalledOnce()
    expect(runtime.list()[0]?.status).toBe('active')
    expect(actions.list()[0]?.contribution.run()).toBe('你好，插件！')
  })

  it('removes every contribution and can be repeatedly activated', async () => {
    const { actions, runtime } = createFixture()
    for (let index = 0; index < 100; index += 1) {
      await runtime.activate(fixtureManifest.id)
      expect(actions.list()).toHaveLength(1)
      await runtime.deactivate(fixtureManifest.id)
      expect(actions.list()).toHaveLength(0)
    }
  })

  it('rolls back contributions when activation fails', async () => {
    const actions = new ContributionRegistry<TestAction>()
    const manifest = createManifest('test.broken')
    const source: PluginSource = {
      manifest,
      trust: 'trusted',
      load: async () => definePlugin({
        manifest,
        activate(context) {
          context.effect(actions.register(manifest.id, { id: 'partial', run: () => 'bad' }))
          throw new Error('expected activation failure')
        },
      }),
    }
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install(source)

    await expect(runtime.activate(manifest.id)).rejects.toThrow('expected activation failure')
    expect(actions.list()).toHaveLength(0)
    expect(runtime.list()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('expected activation failure') })
  })

  it('retains a failed activation rollback disposer for a later cleanup retry', async () => {
    const manifest = createManifest('test.rollback-retry')
    let cleanupAttempts = 0
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest,
      trust: 'trusted',
      load: async () => definePlugin({
        manifest,
        activate(context) {
          context.effect(() => {
            cleanupAttempts += 1
            if (cleanupAttempts === 1) throw new Error('rollback cleanup failed')
          })
          throw new Error('activation failed')
        },
      }),
    })

    await expect(runtime.activate(manifest.id)).rejects.toThrow(/rollback cleanup failed/)
    expect(runtime.list()[0]?.status).toBe('failed')
    await runtime.deactivate(manifest.id)
    expect(cleanupAttempts).toBe(2)
    expect(runtime.list()[0]?.status).toBe('inactive')
  })

  it('continues cleanup after a disposer fails', async () => {
    const cleaned: string[] = []
    let shouldFail = true
    const manifest = createManifest('test.cleanup')
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest,
      trust: 'trusted',
      load: async () => definePlugin({
        manifest,
        activate(context) {
          context.effect(() => { cleaned.push('first') })
          context.effect(() => {
            cleaned.push('second')
            if (shouldFail) {
              shouldFail = false
              throw new Error('cleanup failed')
            }
          })
        },
      }),
    })
    await runtime.activate(manifest.id)

    await expect(runtime.deactivate(manifest.id)).rejects.toThrow('cleanup failed')
    expect(cleaned).toEqual(['second', 'first'])
    expect(runtime.list()[0]?.status).toBe('failed')

    await runtime.deactivate(manifest.id)
    expect(cleaned).toEqual(['second', 'first', 'second'])
    expect(runtime.list()[0]?.status).toBe('inactive')
  })

  it('retains a plugin record until failed uninstall cleanup can be retried', async () => {
    const manifest = createManifest('test.uninstall-retry')
    let cleanupAttempts = 0
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest,
      trust: 'trusted',
      load: async () => definePlugin({
        manifest,
        activate(context) {
          context.effect(() => {
            cleanupAttempts += 1
            if (cleanupAttempts === 1) throw new Error('temporary cleanup failure')
          })
        },
      }),
    })
    await runtime.activate(manifest.id)

    await expect(runtime.uninstall(manifest.id)).rejects.toThrow('temporary cleanup failure')
    expect(runtime.list()).toHaveLength(1)
    expect(runtime.list()[0]?.status).toBe('failed')

    await runtime.uninstall(manifest.id)
    expect(cleanupAttempts).toBe(2)
    expect(runtime.list()).toHaveLength(0)
  })

  it('serializes activate, deactivate, and uninstall without leaving an orphan', async () => {
    const manifest = createManifest('test.concurrent')
    const activationStarted = createDeferred<void>()
    const finishActivation = createDeferred<void>()
    const events: string[] = []
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest,
      trust: 'trusted',
      load: async () => definePlugin({
        manifest,
        async activate(context) {
          events.push('activate:start')
          activationStarted.resolve()
          await finishActivation.promise
          context.effect(() => { events.push('dispose') })
          events.push('activate:end')
        },
      }),
    })

    const activation = runtime.activate(manifest.id)
    await activationStarted.promise
    const deactivation = runtime.deactivate(manifest.id)
    const uninstall = runtime.uninstall(manifest.id)
    const repeatedUninstall = runtime.uninstall(manifest.id)

    expect(repeatedUninstall).toBe(uninstall)
    await expect(runtime.activate(manifest.id)).rejects.toThrow(/being uninstalled/)
    finishActivation.resolve()
    await Promise.all([activation, deactivation, uninstall])

    expect(events).toEqual(['activate:start', 'activate:end', 'dispose'])
    expect(runtime.list()).toHaveLength(0)
  })

  it('takes a deeply immutable manifest snapshot during installation', async () => {
    const targets: PluginTarget[] = ['pc-ui']
    const engine = { moreThanChat: '^0.1.0' }
    const permissions = ['chat.read']
    const services = { requires: [] as string[], provides: ['snapshot.service'] }
    const catalogManifest: PluginManifestV1 = {
      manifestVersion: 1,
      id: 'test.snapshot',
      version: '1.0.0',
      displayName: 'Snapshot',
      description: 'Snapshot fixture',
      targets,
      engine,
      permissions,
      services,
    }
    const moduleManifest: PluginManifestV1 = {
      manifestVersion: 1,
      id: 'test.snapshot',
      version: '1.0.0',
      displayName: 'Snapshot',
      description: 'Snapshot fixture',
      targets: ['pc-ui'],
      engine: { moreThanChat: '^0.1.0' },
      permissions: ['chat.read'],
      services: { requires: [], provides: ['snapshot.service'] },
    }
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest: catalogManifest,
      trust: 'trusted',
      load: async () => definePlugin({ manifest: moduleManifest, activate() {} }),
    })

    ;(catalogManifest as { displayName: string }).displayName = 'Changed outside runtime'
    targets[0] = 'android-ui'
    engine.moreThanChat = '*'
    permissions.push('chat.write')
    services.provides.push('changed.service')

    const snapshot = runtime.list()[0]?.manifest
    expect(snapshot).toMatchObject({
      displayName: 'Snapshot',
      targets: ['pc-ui'],
      engine: { moreThanChat: '^0.1.0' },
      permissions: ['chat.read'],
      services: { provides: ['snapshot.service'] },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot?.targets)).toBe(true)
    expect(Object.isFrozen(snapshot?.engine)).toBe(true)
    expect(Object.isFrozen(snapshot?.permissions)).toBe(true)
    expect(Object.isFrozen(snapshot?.services)).toBe(true)
    expect(Object.isFrozen(snapshot?.services?.requires)).toBe(true)
    expect(Object.isFrozen(snapshot?.services?.provides)).toBe(true)
    await runtime.activate(moduleManifest.id)
    expect(runtime.list()[0]?.status).toBe('active')
  })

  it('binds contributions to the plugin owner and tracks their disposer', async () => {
    const actions = new ContributionRegistry<TestAction>()
    const manifest = createManifest('test.owner-scope')
    let contributeAfterActivation: (() => void) | undefined
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest,
      trust: 'trusted',
      load: async () => definePlugin({
        manifest,
        activate(context) {
          context.contribute(actions, { id: 'owned-action', run: () => 'owned' })
          contributeAfterActivation = () => {
            context.contribute(actions, { id: 'late-action', run: () => 'late' })
          }
        },
      }),
    })

    await runtime.activate(manifest.id)
    expect(actions.list()).toEqual([{
      ownerId: manifest.id,
      contribution: expect.objectContaining({ id: 'owned-action' }),
    }])
    expect(contributeAfterActivation).toBeTypeOf('function')
    expect(() => contributeAfterActivation?.()).toThrow(/after activation completed/)
    expect(actions.list()).toHaveLength(1)

    await runtime.deactivate(manifest.id)
    expect(actions.list()).toHaveLength(0)
  })

  it('rejects duplicate ids without replacing the healthy plugin', async () => {
    const { actions, runtime } = createFixture()
    expect(() => runtime.install({
      manifest: fixtureManifest,
      trust: 'trusted',
      load: () => import('./fixtures/hello-plugin.js'),
    })).toThrow(/already installed/)

    await runtime.activate(fixtureManifest.id)
    expect(actions.list()[0]?.contribution.run()).toBe('你好，插件！')
  })

  it('rejects a loaded module whose manifest differs from the catalog', async () => {
    const catalogManifest = createManifest('test.catalog')
    const moduleManifest = { ...catalogManifest, version: '2.0.0' }
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest: catalogManifest,
      trust: 'trusted',
      load: async () => definePlugin({ manifest: moduleManifest, activate() {} }),
    })

    await expect(runtime.activate(catalogManifest.id)).rejects.toThrow(/does not match/)
  })
})

function createManifest(id: string): PluginManifestV1 {
  return {
    manifestVersion: 1,
    id,
    version: '1.0.0',
    displayName: id,
    description: `Fixture ${id}`,
    targets: ['pc-ui'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: [],
  }
}
