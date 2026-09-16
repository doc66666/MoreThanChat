import { describe, expect, it, vi } from 'vitest'
import {
  ContributionRegistry,
  PluginRuntime,
  definePlugin,
  type PluginManifestV1,
  type PluginSource,
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

  it('continues cleanup after a disposer fails', async () => {
    const cleaned: string[] = []
    const manifest = createManifest('test.cleanup')
    const runtime = new PluginRuntime({ target: 'pc-ui' })
    runtime.install({
      manifest,
      trust: 'trusted',
      load: async () => definePlugin({
        manifest,
        activate(context) {
          context.effect(() => { cleaned.push('first') })
          context.effect(() => { cleaned.push('second'); throw new Error('cleanup failed') })
        },
      }),
    })
    await runtime.activate(manifest.id)

    await expect(runtime.deactivate(manifest.id)).rejects.toThrow('cleanup failed')
    expect(cleaned).toEqual(['second', 'first'])
    expect(runtime.list()[0]?.status).toBe('failed')
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
