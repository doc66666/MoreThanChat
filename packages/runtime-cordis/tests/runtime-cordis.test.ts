import { describe, expect, it, vi } from 'vitest'
import { ContributionRegistry, type PluginContext, type PluginDisposer, type PluginManifestV1, type PluginModule } from '@more-than-chat/plugin-runtime'
import { CordisPluginRuntime } from '../src/index'

function manifest(id = 'test.scoped'): PluginManifestV1 {
  return { manifestVersion: 1, id, version: '0.1.0', displayName: 'Test', description: 'Lifecycle contract',
    targets: ['pc-host'], permissions: [], engine: { moreThanChat: '^0.1.0' }, services: { requires: ['test.registry'] } }
}

function fixture(activate: PluginModule['activate'], healthCheck?: PluginModule['healthCheck']) {
  const registry = new ContributionRegistry<{ id: string }>()
  const runtime = new CordisPluginRuntime({ target: 'pc-host', services: { 'test.registry': registry } })
  const module: PluginModule = { manifest: manifest(), activate, ...(healthCheck ? { healthCheck } : {}) }
  runtime.install({ manifest: module.manifest, trust: 'builtin', load: async () => module })
  return { runtime, registry, id: module.manifest.id }
}

describe('Cordis lifecycle adapter contracts', () => {
  it('uses real isolated scopes, keeps the SDK context, and removes scope/contribution after 100 cycles', async () => {
    let retained!: PluginContext
    const { runtime, registry, id } = fixture(context => {
      retained = context
      expect(context).not.toHaveProperty('scope')
      expect(context).not.toHaveProperty('root')
      context.contribute(context.getService<ContributionRegistry<{ id: string }>>('test.registry'), { id: 'tool' })
    })
    expect(runtime.getDiagnostics()).toMatchObject({ engine: 'cordis', engineVersion: '3.18.1', registeredScopes: 0 })
    for (let cycle = 0; cycle < 100; cycle++) {
      await runtime.activate(id)
      expect(runtime.list()[0]?.status).toBe('active')
      expect(runtime.getDiagnostics().registeredScopes).toBe(1)
      expect(registry.list()).toEqual([{ ownerId: id, contribution: { id: 'tool' } }])
      await runtime.deactivate(id)
      expect(registry.list()).toHaveLength(0)
      expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    }
    expect(() => retained.contribute(registry, { id: 'late' })).toThrow('after activation completed')
    await runtime.close()
  })

  it('translates async Cordis activation failures and rolls back already registered contributions', async () => {
    const { runtime, registry, id } = fixture(async context => {
      context.contribute(context.getService<ContributionRegistry<{ id: string }>>('test.registry'), { id: 'partial' })
      await Promise.resolve()
      throw new Error('activation failed')
    })
    await expect(runtime.activate(id)).rejects.toThrow('activation failed')
    expect(runtime.list()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('activation failed') })
    expect(registry.list()).toHaveLength(0)
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    await runtime.close()
  })

  it('cleans the SDK effects and Cordis scope when the health check fails', async () => {
    const { runtime, registry, id } = fixture(context => {
      context.contribute(context.getService<ContributionRegistry<{ id: string }>>('test.registry'), { id: 'tool' })
    }, async () => { throw new Error('health check failed') })
    await expect(runtime.activate(id)).rejects.toThrow('health check failed')
    expect(registry.list()).toHaveLength(0)
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    await runtime.close()
  })

  it('awaits the returned async disposer and cleans effects in reverse registration order', async () => {
    const events: string[] = []
    const { runtime, id } = fixture(context => {
      context.effect(async () => { await Promise.resolve(); events.push('first') })
      context.effect(() => { events.push('second') })
      return async () => { await Promise.resolve(); events.push('returned') }
    })
    await runtime.activate(id)
    await runtime.deactivate(id)
    expect(events).toEqual(['returned', 'second', 'first'])
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    await runtime.close()
  })

  it('retains failed disposers, blocks reactivation, and allows cleanup to be retried', async () => {
    let attempts = 0
    const { runtime, id } = fixture(context => {
      context.effect(() => { if (++attempts === 1) throw new Error('temporary cleanup failure') })
    })
    await runtime.activate(id)
    await expect(runtime.deactivate(id)).rejects.toThrow('temporary cleanup failure')
    expect(runtime.list()[0]?.status).toBe('failed')
    await expect(runtime.activate(id)).rejects.toThrow('awaiting cleanup')
    await runtime.deactivate(id)
    expect(attempts).toBe(2)
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    await runtime.close()
  })

  it('rejects missing required services before loading plugin code', async () => {
    const runtime = new CordisPluginRuntime({ target: 'pc-host' })
    const load = vi.fn(async () => ({ manifest: manifest(), activate() {} }))
    runtime.install({ manifest: manifest(), trust: 'builtin', load })
    await expect(runtime.activate('test.scoped')).rejects.toThrow('unavailable service')
    expect(load).not.toHaveBeenCalled()
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    await runtime.close()
  })

  it('waits for an in-flight activation during close and rejects new work', async () => {
    let started!: () => void
    let finish!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const continuing = new Promise<void>(resolve => { finish = resolve })
    const cleaned = vi.fn()
    const { runtime, id } = fixture(async context => {
      started()
      await continuing
      context.effect(cleaned)
    })
    const activating = runtime.activate(id)
    await entered
    const closing = runtime.close()
    expect(runtime.close()).toBe(closing)
    await expect(runtime.activate(id)).rejects.toThrow('closing')
    finish()
    await activating
    await closing
    expect(cleaned).toHaveBeenCalledOnce()
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    expect(runtime.list()[0]?.status).toBe('inactive')
  })

  it('cleans other plugins when one fails close and permits a second close to retry it', async () => {
    let attempts = 0
    const { runtime, id } = fixture(context => {
      context.effect(() => { if (++attempts === 1) throw new Error('retry me') })
    })
    const other = manifest('test.other')
    const cleaned = vi.fn()
    runtime.install({ manifest: other, trust: 'builtin', load: async () => ({ manifest: other, activate: () => cleaned }) })
    await runtime.activate(id)
    await runtime.activate(other.id)
    await expect(runtime.close()).rejects.toThrow('cleanup failed')
    expect(cleaned).toHaveBeenCalledOnce()
    await runtime.close()
    expect(attempts).toBe(2)
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
  })

  it('uninstalls a plugin without retaining a framework registration', async () => {
    const disposed = vi.fn<PluginDisposer>()
    const { runtime, id } = fixture(() => disposed)
    await runtime.activate(id)
    await runtime.uninstall(id)
    expect(disposed).toHaveBeenCalledOnce()
    expect(runtime.list()).toHaveLength(0)
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    await runtime.close()
  })
})
