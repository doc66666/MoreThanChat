import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { PluginContext, PluginSource } from '@more-than-chat/plugin-runtime'
import { CordisPluginRuntime } from '../src/index'
import { NodePluginDirectory } from '../src/node'

function source(
  id: string,
  requires: string[],
  provides: string[],
  activate: (ctx: PluginContext) => void | Promise<void>,
  version = '1.0.0',
): PluginSource {
  const manifest = {
    manifestVersion: 1,
    id,
    version,
    displayName: id,
    description: 'composition contract',
    targets: ['pc-host'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: ['host.trusted'],
    services: { requires, provides },
  } as const
  return {
    manifest,
    trust: id.startsWith('builtin.') ? 'builtin' : 'trusted',
    load: async () => ({ manifest, activate }),
  }
}
describe('shared built-in and user composition', () => {
  it('starts a reverse-ordered graph and stops consumers before replacing providers, then restores defaults', async () => {
    const runtime = new CordisPluginRuntime({ target: 'pc-host' }),
      events: string[] = []
    const provider = source('builtin.provider', [], ['clock'], (ctx) => {
      ctx.provideService('clock', 'base')
      ctx.effect(() => {
        events.push('dispose-base')
      })
    })
    const consumer = source('builtin.consumer', ['clock'], ['label'], (ctx) => {
      const value = ctx.getService<string>('clock')
      events.push('bind-' + value)
      ctx.provideService('label', value)
      ctx.effect(() => {
        events.push('unbind-' + value)
      })
    })
    const view = source('builtin.view', ['label'], [], (ctx) => {
      events.push('view-' + ctx.getService('label'))
      ctx.effect(() => {
        events.push('dispose-view')
      })
    })
    runtime.install(view)
    runtime.install(consumer)
    runtime.install(provider)
    await runtime.start()
    expect(events).toEqual(['bind-base', 'view-base'])
    const custom = source('user.provider', [], ['clock'], (ctx) => {
      ctx.provideService('clock', 'custom')
      ctx.effect(() => {
        events.push('dispose-custom')
      })
    })
    runtime.install(custom)
    await runtime.activate(custom.manifest.id)
    expect(events.slice(2)).toEqual(['dispose-view', 'unbind-base', 'bind-custom', 'view-custom'])
    await runtime.deactivate(custom.manifest.id)
    expect(runtime.services.get('label')).toBe('base')
    expect(events.slice(-5)).toEqual([
      'dispose-view',
      'unbind-custom',
      'dispose-custom',
      'bind-base',
      'view-base',
    ])
    await runtime.deactivate(provider.manifest.id)
    expect(runtime.list().filter((p) => p.status === 'active')).toEqual([])
    await runtime.activate(provider.manifest.id)
    expect(runtime.services.get('label')).toBe('base')
    await runtime.close()
    expect(runtime.services.list()).toEqual([])
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
  })
  it('rolls back failed provider code and rebinds consumers to the previous working version', async () => {
    const runtime = new CordisPluginRuntime({ target: 'pc-host' }),
      seen: string[] = []
    runtime.install(
      source('user.clock', [], ['clock'], (ctx) => {
        ctx.provideService('clock', 'v1')
      }),
    )
    runtime.install(
      source('builtin.reader', ['clock'], [], (ctx) => {
        seen.push(ctx.getService('clock'))
      }),
    )
    await runtime.start()
    await expect(
      runtime.replace(
        source(
          'user.clock',
          [],
          ['clock'],
          (ctx) => {
            ctx.provideService('clock', 'broken')
            throw new Error('bad update')
          },
          '2.0.0',
        ),
      ),
    ).rejects.toThrow('bad update')
    expect(runtime.services.get('clock')).toBe('v1')
    expect(seen).toEqual(['v1', 'v1'])
    await runtime.replace(
      source(
        'user.clock',
        [],
        ['clock'],
        (ctx) => {
          ctx.provideService('clock', 'v3')
        },
        '3.0.0',
      ),
    )
    expect(seen.at(-1)).toBe('v3')
    await runtime.close()
  })
  it('does not load missing dependencies or run a graph cycle', async () => {
    const runtime = new CordisPluginRuntime({ target: 'pc-host' })
    let loaded = false
    runtime.install(
      source('cycle.a', ['b'], ['a'], (ctx) => {
        loaded = true
        ctx.provideService('a', 1)
      }),
    )
    runtime.install(
      source('cycle.b', ['a'], ['b'], (ctx) => {
        loaded = true
        ctx.provideService('b', 1)
      }),
    )
    await expect(runtime.start()).rejects.toThrow('Unresolved')
    expect(loaded).toBe(false)
    await runtime.close()
  })
  it('rebinds existing consumers when a waiting replacement becomes available', async () => {
    const runtime = new CordisPluginRuntime({target: 'pc-host'})
    runtime.install(source('builtin.clock', [], ['clock'], ctx => ctx.provideService('clock', 'base')))
    runtime.install(source('builtin.reader', ['clock'], ['label'], ctx => ctx.provideService('label', ctx.getService('clock'))))
    runtime.install(source('user.clock', ['ready'], ['clock'], ctx => ctx.provideService('clock', 'custom')))
    try {
      await runtime.start(undefined, true)
      expect(runtime.services.get('label')).toBe('base')
      runtime.install(source('user.ready', [], ['ready'], ctx => ctx.provideService('ready', true)))
      await runtime.activate('user.ready')
      expect(runtime.services.get('label')).toBe('custom')
      await runtime.deactivate('user.ready')
      expect(runtime.services.get('label')).toBe('base')
      await runtime.activate('user.ready')
      expect(runtime.services.get('label')).toBe('custom')
    } finally {await runtime.close()}
  })
  it('keeps upstream decorators alive and preserves equal-priority selection during updates', async () => {
    const runtime = new CordisPluginRuntime({target: 'pc-host'})
    let upstreamLive = 0
    runtime.install(source('builtin.clock', [], ['clock'], ctx => ctx.provideService('clock', () => 'base')))
    runtime.install(source('builtin.reader', ['clock'], ['label'], ctx => ctx.provideService('label', ctx.getService<() => string>('clock')())))
    const decorator = (id: string, suffix: string, priority = 0) => source(id, ['clock'], ['clock'], ctx => {
      const previous = ctx.getService<() => string>('clock')
      let alive = true
      if (id === 'user.first') upstreamLive++
      ctx.effect(() => {alive = false;if (id === 'user.first') upstreamLive--})
      ctx.provideService('clock', () => {if (!alive) throw new Error('disposed upstream');return previous() + suffix}, priority)
    })
    try {
      await runtime.start()
      runtime.install(decorator('user.first', '-first'));await runtime.activate('user.first')
      runtime.install(decorator('user.second', '-second', -1));await runtime.activate('user.second')
      expect(runtime.services.get('label')).toBe('base-first-second')
      expect(upstreamLive).toBe(1)
      await runtime.replace(decorator('user.first', '-updated'))
      expect(runtime.services.get('label')).toBe('base-updated-second')
      await runtime.deactivate('user.second')
      expect(runtime.services.get('label')).toBe('base-updated')
      await runtime.replace(decorator('user.second', '-same-priority'))
      await runtime.activate('user.second')
      expect(runtime.services.get('label')).toBe('base-updated')
      await runtime.replace(decorator('user.first', '-latest'))
      expect(runtime.services.get('label')).toBe('base-latest')
      expect(upstreamLive).toBe(1)
    } finally {await runtime.close()}
    expect(upstreamLive).toBe(0)
  })
  it('rolls back a provider whose activation succeeds but breaks a downstream consumer', async () => {
    const runtime = new CordisPluginRuntime({target: 'pc-host'})
    let subscriptions = 0
    const clock = (value: string) => source('user.clock', [], ['clock'], ctx => ctx.provideService('clock', value), value === 'v1' ? '1.0.0' : '2.0.0')
    runtime.install(clock('v1'))
    runtime.install(source('builtin.reader', ['clock'], ['label'], ctx => {
      const value = ctx.getService<string>('clock')
      if (value === 'bad') throw new Error('incompatible clock')
      ctx.provideService('label', value)
    }))
    runtime.install(source('builtin.view', ['label'], [], ctx => {
      subscriptions++
      ctx.effect(() => {subscriptions--})
    }))
    try {
      await runtime.start()
      await expect(runtime.replace(clock('bad'))).rejects.toThrow('incompatible clock')
      expect(runtime.services.get('label')).toBe('v1')
      expect(runtime.list().every(p => p.status === 'active')).toBe(true)
      expect(subscriptions).toBe(1)
      // Removing a declared service is also an incompatible update.
      await expect(runtime.replace(source('user.clock', [], [], () => {}, '3.0.0'))).rejects.toThrow('unavailable')
      expect(runtime.services.get('label')).toBe('v1')
      expect(subscriptions).toBe(1)
      await runtime.replace(clock('v2'))
      expect(runtime.services.get('label')).toBe('v2')
      expect(subscriptions).toBe(1)
    } finally {await runtime.close()}
    expect(subscriptions).toBe(0)
  })
  it('restores default consumers when a newly enabled replacement is incompatible', async () => {
    const runtime = new CordisPluginRuntime({target: 'pc-host'})
    runtime.install(source('builtin.clock', [], ['clock'], ctx => ctx.provideService('clock', 'base')))
    runtime.install(source('builtin.reader', ['clock'], [], ctx => {
      if (ctx.getService('clock') !== 'base') throw new Error('incompatible provider')
    }))
    try {
      await runtime.start()
      runtime.install(source('user.clock', [], ['clock'], ctx => ctx.provideService('clock', 'bad')))
      await expect(runtime.activate('user.clock')).rejects.toThrow('incompatible provider')
      expect(runtime.services.get('clock')).toBe('base')
      expect(runtime.list().find(p => p.manifest.id === 'builtin.reader')?.status).toBe('active')
      await runtime.uninstall('user.clock')
      expect(runtime.getDiagnostics().registeredScopes).toBe(2)
    } finally {await runtime.close()}
  })
  it('restores the last accepted Node revision after a broken edit and persists disabled selections without running them on boot', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mtc-node-restart-')), id = 'user.node', folder = path.join(directory, id)
    const manifest = source(id, [], ['value'], () => {}).manifest
    let starts = 0
    const create = () => {
      const runtime = new CordisPluginRuntime({target: 'pc-host'})
      runtime.install(source('builtin.network', [], [], () => {starts++}))
      const loader = new NodePluginDirectory(directory, runtime)
      return {runtime, loader, boot: async () => {
        await loader.prepare()
        await runtime.start(runtime.list().map(p => p.manifest.id).filter(id => loader.isEnabled(id)), true)
        await loader.start()
      }, close: async () => {await loader.close();await runtime.close()}}
    }
    let app = create()
    try {
      await mkdir(folder)
      await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest))
      await writeFile(path.join(folder, 'index.mjs'), 'export default ctx=>ctx.provideService("value",42)')
      await app.boot()
      expect(app.runtime.services.get('value')).toBe(42)
      await app.loader.setEnabled('builtin.network', false)
      await writeFile(path.join(folder, 'index.mjs'), 'export default ()=>{throw Error("broken update")}')
      await app.loader.refresh()
      expect(app.loader.errors.get(id)).toContain('broken update')
      await app.close();app = create();await app.boot()
      expect(app.runtime.services.get('value')).toBe(42)
      expect(app.loader.errors.get(id)).toContain('broken update')
      expect(starts).toBe(1)
      await app.loader.setEnabled(id, false)
      await app.close();app = create();await app.boot()
      expect(app.runtime.services.has('value')).toBe(false)
      expect(starts).toBe(1)
      // Fix while disabled, then explicitly enable the new version.
      await writeFile(path.join(folder, 'index.mjs'), 'export default ctx=>ctx.provideService("value",43)')
      await app.loader.refresh()
      expect(app.runtime.services.has('value')).toBe(false)
      await app.loader.setEnabled(id, true)
      expect(app.runtime.services.get('value')).toBe(43)
      await app.close();app = create();await app.boot()
      expect(app.runtime.services.get('value')).toBe(43)
      expect(starts).toBe(1)
    } finally {await app.close();await rm(directory, {recursive: true, force: true})}
  })
  it('does not change runtime enablement when writing preferences fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mtc-node-preferences-')), runtime = new CordisPluginRuntime({target:'pc-host'}), loader = new NodePluginDirectory(directory,runtime)
    runtime.install(source('builtin.network', [], ['network'], ctx => ctx.provideService('network', true)))
    try {
      await runtime.start();await loader.start()
      // A directory at the temporary file path reliably simulates write failure on Windows and Linux.
      await mkdir(path.join(directory,'disabled.json.next'))
      await expect(loader.setEnabled('builtin.network', false)).rejects.toThrow()
      expect(runtime.services.has('network')).toBe(true)
      expect(loader.isEnabled('builtin.network')).toBe(true)
      await rm(path.join(directory,'disabled.json.next'),{recursive:true})
      await loader.setEnabled('builtin.network',false)
      await mkdir(path.join(directory,'disabled.json.next'))
      await expect(loader.setEnabled('builtin.network', true)).rejects.toThrow()
      expect(runtime.services.has('network')).toBe(false)
      expect(JSON.parse(await readFile(path.join(directory,'disabled.json'),'utf8'))).toEqual(['builtin.network'])
    } finally {await loader.close();await runtime.close();await rm(directory,{recursive:true,force:true})}
  })
  it('rolls back a Node update if its accepted revision cannot be persisted', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mtc-node-commit-')), id = 'user.node', folder = path.join(directory,id)
    const runtime = new CordisPluginRuntime({target:'pc-host'}), loader = new NodePluginDirectory(directory,runtime)
    try {
      await mkdir(folder)
      await writeFile(path.join(folder,'manifest.json'),JSON.stringify(source(id,[],['value'],()=>{}).manifest))
      await writeFile(path.join(folder,'index.mjs'),'export default ctx=>ctx.provideService("value",1)')
      await loader.start()
      const selected = await readFile(path.join(folder,'.mtc-runtime','current.json'),'utf8')
      await mkdir(path.join(folder,'.mtc-runtime','current.json.next'))
      await writeFile(path.join(folder,'index.mjs'),'export default ctx=>ctx.provideService("value",2)')
      await loader.refresh()
      expect(loader.errors.has(id)).toBe(true)
      expect(runtime.services.get('value')).toBe(1)
      expect(await readFile(path.join(folder,'.mtc-runtime','current.json'),'utf8')).toBe(selected)
      expect(runtime.getDiagnostics().registeredScopes).toBe(1)
      await rm(path.join(folder,'.mtc-runtime','current.json.next'),{recursive:true})
      await loader.refresh()
      expect(runtime.services.get('value')).toBe(2)
      expect(loader.errors.has(id)).toBe(false)
    } finally {await loader.close();await runtime.close();await rm(directory,{recursive:true,force:true})}
  })
  it('keeps a disable request persisted even when plugin cleanup needs a retry', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mtc-node-cleanup-')), runtime = new CordisPluginRuntime({target:'pc-host'}), loader = new NodePluginDirectory(directory,runtime)
    let attempts = 0
    runtime.install(source('builtin.network',[],['network'],ctx=>{
      ctx.provideService('network',true)
      ctx.effect(()=>{if (++attempts === 1) throw new Error('cleanup retry')})
    }))
    try {
      await runtime.start();await loader.start()
      await expect(loader.setEnabled('builtin.network',false)).rejects.toThrow('cleanup')
      expect(JSON.parse(await readFile(path.join(directory,'disabled.json'),'utf8'))).toEqual(['builtin.network'])
      expect(loader.isEnabled('builtin.network')).toBe(false)
      await loader.setEnabled('builtin.network',false)
      expect(runtime.list()[0]?.status).toBe('inactive')
    } finally {await loader.close();await runtime.close();await rm(directory,{recursive:true,force:true})}
  })
  it('loads user Node code, hot updates it, keeps a working version during partial saves and unloads removed directories', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mtc-node-composition-')),
      runtime = new CordisPluginRuntime({ target: 'pc-host' }),
      loader = new NodePluginDirectory(directory, runtime)
    const id = 'user.node',
      folder = path.join(directory, id),
      manifest = source(id, [], ['node.value'], () => {}).manifest
    try {
      await mkdir(folder)
      await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest))
      await writeFile(path.join(folder, 'value.mjs'), 'export default 1')
      await writeFile(
        path.join(folder, 'index.mjs'),
        'import value from "./value.mjs"; export default ctx => {ctx.provideService("node.value",value)}',
      )
      await loader.start()
      expect([...loader.errors]).toEqual([])
      expect(runtime.services.get('node.value')).toBe(1)
      await writeFile(path.join(folder, 'value.mjs'), 'export default 2')
      await loader.refresh()
      expect(runtime.services.get('node.value')).toBe(2)
      let changes = 0
      const unsubscribe = runtime.subscribe(() => changes++)
      await writeFile(
        path.join(folder, 'index.mjs'),
        'export default ctx=>{throw Error("bad update")}',
      )
      await loader.refresh()
      expect(runtime.services.get('node.value')).toBe(2)
      const afterFailure = changes
      await loader.refresh()
      expect(changes).toBe(afterFailure)
      unsubscribe()
      await writeFile(path.join(folder, 'manifest.json'), '{')
      await loader.refresh()
      expect(runtime.services.get('node.value')).toBe(2)
      await rm(folder, { recursive: true })
      await loader.refresh()
      expect(runtime.services.has('node.value')).toBe(false)
    } finally {
      await loader.close()
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
