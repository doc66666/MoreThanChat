import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ClientPluginStore, clientPackageDigest } from '../src/main/client-plugins'
import { ClientPluginLoader } from '../src/renderer/src/client-plugin-loader'
import { ClientPluginController } from '../src/renderer/src/client-plugin-controller'
import { parseExecutableClientPackage, UiSurfaceRegistry, type InstalledClientPackage } from '@more-than-chat/plugin-runtime'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'

const temporary: string[] = []
afterEach(async () => {for (const directory of temporary.splice(0)) await rm(directory, {recursive: true, force: true})})
function pack(version = '0.1.0', code = 'export default function activate() {}'): InstalledClientPackage {
  const value = parseExecutableClientPackage({manifest: {manifestVersion: 1, id: 'test.desktop', version, displayName: '测试桌面', description: '测试', targets: ['pc-ui'], engine: {moreThanChat: '^0.1.0'}, permissions: ['client.trusted'], services: {requires: ['ui.surfaces']}}, program: {kind: 'executable-client', code}})
  return {...value, digest: clientPackageDigest(value)}
}
async function store() {const dir = await mkdtemp(path.join(os.tmpdir(), 'mtc-client-store-')); temporary.push(dir); return new ClientPluginStore(dir)}
describe('trusted executable client packages', () => {
  it('revokes pending auto-replies and subscriptions on disable and hot replacement',async()=>{
    const runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.surfaces':new UiSurfaceRegistry()}})
    const listeners=new Set<(value:unknown)=>void>(),request=vi.fn(async()=>({ok:true})),notify=vi.fn()
    const instances:any[]=[]
    const sdk={chat:{request,subscribe:(fn:(value:unknown)=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}}}}
    const loader=new ClientPluginLoader(runtime,sdk,async()=>({default:(_ctx,value:any)=>{instances.push(value);value.chat.subscribe(notify)}}))
    try{
      await loader.enable(pack())
      let release!:(value:unknown)=>void
      request.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
      const pending=instances[0].chat.request({action:'history',conversationId:'test'}).catch((error:unknown)=>error)
      await loader.disable('test.desktop')
      release({messages:[]})
      expect(await pending).toBeInstanceOf(Error)
      expect(listeners.size).toBe(0)
      await expect(instances[0].chat.request({action:'send'})).rejects.toThrow('停用')
      await loader.enable(pack())
      expect(listeners.size).toBe(1)
      await loader.enable(pack('0.2.0'))
      expect(listeners.size).toBe(1)
      await expect(instances[1].chat.request({action:'send'})).rejects.toThrow('停用')
      await instances[2].chat.request({action:'list'})
      expect(request).toHaveBeenCalledTimes(2)
      for(const listener of listeners)listener({})
      expect(notify).toHaveBeenCalledOnce()
    }finally{await runtime.close()}
    expect(listeners.size).toBe(0)
  })
  it('uninstalls running code and durable selection without touching another plugin or restoring after restart',async()=>{
    const s=await store(),surfaces=new UiSurfaceRegistry(),runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.surfaces':surfaces}})
    const cleaned=vi.fn(),loader=new ClientPluginLoader(runtime,{},async()=>({default:ctx=>{ctx.contribute(surfaces,{id:'root',surface:'root',render:()=>null});ctx.effect(cleaned)}}))
    const controller=new ClientPluginController(loader,{getClientPlugins:()=>s.list(),saveClientPlugin:(p,e)=>s.save({manifest:p.manifest,program:p.program},e),removeClientPlugin:(id,v)=>s.remove(id,v)},()=>{})
    try{
      await controller.apply(pack())
      await expect(controller.uninstall('test.desktop','9.0.0')).rejects.toThrow('变化')
      expect(surfaces.list()).toHaveLength(1)
      await controller.uninstall('test.desktop','0.1.0')
      expect(surfaces.list()).toHaveLength(0);expect(cleaned).toHaveBeenCalledTimes(1)
      expect(loader.current('test.desktop')).toBeUndefined()
      expect(await new ClientPluginStore(path.dirname(s.directory)).list()).toEqual([])
    }finally{await runtime.close()}
  })
  it('requires explicit full trust and supported target/engine, rejects reserved IDs and invalid format', () => {
    for (const change of [{permissions: []}, {targets: ['pc-host']}, {id: 'builtin.replace'}, {engine: {moreThanChat: '^99.0.0'}}, {services: {requires: ['secrets']}}]) {
      const p = pack()
      expect(() => parseExecutableClientPackage({manifest: {...p.manifest, ...change}, program: p.program})).toThrow()
    }
    expect(() => parseExecutableClientPackage({manifest: pack().manifest, program: {kind: 'executable-client', code: 'x'.repeat(100001)}})).toThrow()
  })
  it('keeps failed cleanup visible and disabled, then permits uninstall retry',async()=>{
    const s=await store(),surfaces=new UiSurfaceRegistry(),runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.surfaces':surfaces}})
    const cleanup=vi.fn().mockRejectedValueOnce(new Error('temporary cleanup failure')).mockResolvedValue(undefined)
    const loader=new ClientPluginLoader(runtime,{},async()=>({default:ctx=>{ctx.contribute(surfaces,{id:'root',surface:'root',render:()=>null});ctx.effect(cleanup)}}))
    const remove=vi.fn((id:string,v:string)=>s.remove(id,v))
    const controller=new ClientPluginController(loader,{getClientPlugins:()=>s.list(),saveClientPlugin:(p,e)=>s.save({manifest:p.manifest,program:p.program},e),removeClientPlugin:remove},()=>{})
    try{
      await controller.apply(pack())
      await expect(controller.uninstall('test.desktop','0.1.0')).rejects.toThrow('cleanup failed')
      expect(remove).not.toHaveBeenCalled()
      expect((await s.list())[0]?.enabled).toBe(false)
      expect(controller.errors.get('test.desktop')).toContain('cleanup failed')
      expect(loader.current('test.desktop')).toBeDefined()
      const restartedLoader=new ClientPluginLoader(new CordisPluginRuntime({target:'pc-ui'}),{},vi.fn())
      const restarted=new ClientPluginController(restartedLoader,{getClientPlugins:()=>s.list(),saveClientPlugin:async p=>p},()=>{})
      await restarted.start()
      expect(restartedLoader.load).not.toHaveBeenCalled()
      await controller.uninstall('test.desktop','0.1.0')
      expect(await s.list()).toEqual([])
      expect(runtime.list()).toEqual([])
      expect(controller.errors.has('test.desktop')).toBe(false)
      expect(cleanup).toHaveBeenCalledTimes(2)
    }finally{await runtime.close()}
  })

  it('keeps a disabled entry when deleting the installed record fails',async()=>{
    const s=await store(),runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.surfaces':new UiSurfaceRegistry()}})
    const loader=new ClientPluginLoader(runtime,{},async()=>({default:()=>{}}))
    const remove=vi.fn((id:string,v:string)=>s.remove(id,v)).mockRejectedValueOnce(new Error('disk write failed'))
    const controller=new ClientPluginController(loader,{getClientPlugins:()=>s.list(),saveClientPlugin:(p,e)=>s.save({manifest:p.manifest,program:p.program},e),removeClientPlugin:remove},()=>{})
    try{
      await controller.apply(pack())
      await expect(controller.uninstall('test.desktop','0.1.0')).rejects.toThrow('disk write failed')
      expect((await s.list())[0]?.enabled).toBe(false)
      expect(loader.isActive('test.desktop')).toBe(false)
      await controller.uninstall('test.desktop','0.1.0')
      expect(await s.list()).toEqual([])
    }finally{await runtime.close()}
  })
  it('persists immutable snapshots without executing; updates only selected ID and serializes concurrent writes', async () => {
    const s = await store(), initial = pack(), next = pack('0.2.0')
    expect(await s.list()).toEqual([])
    await Promise.all([s.save({manifest: initial.manifest, program: initial.program}), s.save({manifest: next.manifest, program: next.program})])
    expect(await s.list()).toEqual([{...next, enabled: false}])
    expect(clientPackageDigest(next)).toBe(next.digest)
    const text = await readFile(path.join(s.directory, 'installed.json'), 'utf8')
    expect(JSON.parse(text)[0].enabled).toBe(false)
    expect(await new ClientPluginStore(path.dirname(s.directory)).list()).toEqual([{...next, enabled: false}])
  })
  it('persists enabled choices, migrates old catalogs, and disables without deleting source', async () => {
    const s = await store(), p = pack()
    await s.save({manifest: p.manifest, program: p.program}, true)
    expect((await new ClientPluginStore(path.dirname(s.directory)).list())[0]?.enabled).toBe(true)
    await s.save({manifest: p.manifest, program: p.program})
    expect((await s.list())[0]?.enabled).toBe(true)
    await s.disableAll()
    expect(await s.list()).toEqual([{...p, enabled: false}])
    await writeFile(path.join(s.directory, 'installed.json'), JSON.stringify([p]))
    expect(await s.list()).toEqual([{...p, enabled: false}])
  })
  it('detects disk tampering and does not silently overwrite a damaged catalog', async () => {
    const s = await store(), p = pack()
    await s.save({manifest: p.manifest, program: p.program})
    const file = path.join(s.directory, 'installed.json')
    const altered = JSON.stringify([{...p, program: {...p.program, code: 'changed'}}])
    await writeFile(file, altered)
    await expect(s.list()).rejects.toThrow('修改')
    await expect(s.save({manifest: p.manifest, program: p.program})).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(altered)
  })
  it('does not import or execute on construction, manages full-root replacement and cleanup through Cordis', async () => {
    const surfaces = new UiSurfaceRegistry(), runtime = new CordisPluginRuntime({target: 'pc-ui', services: {'ui.surfaces': surfaces}})
    const cleaned = vi.fn(), load = vi.fn(async () => ({default: (ctx: any) => {
      ctx.contribute(ctx.getService('ui.surfaces'), {id: 'root', surface: 'root', render: () => 'whole desktop'})
      ctx.effect(cleaned)
    }}))
    const loader = new ClientPluginLoader(runtime, {}, load)
    expect(load).not.toHaveBeenCalled()
    await loader.enable(pack())
    expect(surfaces.resolve('root')).toBeDefined()
    expect(runtime.getDiagnostics().registeredScopes).toBe(1)
    await loader.disable('test.desktop')
    expect(surfaces.list()).toHaveLength(0)
    expect(cleaned).toHaveBeenCalledTimes(1)
    expect(runtime.getDiagnostics().registeredScopes).toBe(0)
    await loader.enable(pack()); await loader.disable('test.desktop')
    expect(cleaned).toHaveBeenCalledTimes(2)
    await runtime.close()
  })
  it('hot updates atomically owned contributions, and rolls back failed activation to the previously running version', async () => {
    const surfaces = new UiSurfaceRegistry(), runtime = new CordisPluginRuntime({target: 'pc-ui', services: {'ui.surfaces': surfaces}})
    const loader = new ClientPluginLoader(runtime, {}, async code => ({default: ctx => {
      ctx.contribute(surfaces, {id: 'root', surface: 'root', render: () => code})
      if (code === 'broken') throw new Error('deliberate activation failure')
    }}))
    const first = pack('0.1.0', 'first'), second = pack('0.2.0', 'second'), broken = pack('0.3.0', 'broken')
    await loader.enable(first); await loader.enable(second)
    expect(surfaces.list()).toHaveLength(1)
    expect(loader.current(first.manifest.id)?.digest).toBe(second.digest)
    await expect(loader.enable(broken)).rejects.toThrow('deliberate')
    expect(loader.current(first.manifest.id)?.digest).toBe(second.digest)
    expect(runtime.list()[0]?.status).toBe('active')
    expect(surfaces.list()).toHaveLength(1)
    expect(surfaces.resolve('root')?.contribution.render({context: null, defaultView: null, renderSurface: () => null})).toBe('second')
    expect(runtime.getDiagnostics().registeredScopes).toBe(1)
    await runtime.close()
  })
  it('recovers from invalid exports and refuses to replace built-in identifiers already registered', async () => {
    const runtime = new CordisPluginRuntime({target: 'pc-ui', services: {'ui.surfaces': new UiSurfaceRegistry()}})
    const loader = new ClientPluginLoader(runtime, {}, async () => ({default: 1}) as any)
    await expect(loader.enable(pack())).rejects.toThrow('export default')
    expect(runtime.list()).toHaveLength(0)
    runtime.install({manifest: pack().manifest, trust: 'builtin', load: async () => ({manifest: pack().manifest, activate() {}})})
    await expect(loader.enable(pack())).rejects.toThrow('占用')
    expect(runtime.list()[0]?.trust).toBe('builtin')
    await runtime.close()
  })
})

describe('client plugin selection and hot update transaction', () => {
  async function fixture() {
    const s = await store(), surfaces = new UiSurfaceRegistry()
    const runtime = new CordisPluginRuntime({target: 'pc-ui', services: {'ui.surfaces': surfaces}})
    const load = vi.fn(async (code: string) => ({default: (ctx: any) => {
      ctx.contribute(surfaces, {id: 'root', surface: 'root', render: () => code})
      if (code === 'broken') throw new Error('activation failed')
    }}))
    const loader = new ClientPluginLoader(runtime, {}, load)
    const bridge = {getClientPlugins: () => s.list(), saveClientPlugin: vi.fn((p: InstalledClientPackage, enabled: boolean) => s.save({manifest: p.manifest, program: p.program}, enabled))}
    const controller = new ClientPluginController(loader, bridge, vi.fn())
    return {s, surfaces, runtime, loader, bridge, controller, load}
  }
  it('installs once, restores enabled plugins once on startup, and remembers disable', async () => {
    const f = await fixture(), p = pack()
    await f.controller.apply(p)
    expect((await f.s.list())[0]?.enabled).toBe(true)
    await f.loader.remove(p.manifest.id)
    f.load.mockClear()
    await Promise.all([f.controller.start(), f.controller.start()])
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(f.loader.isActive(p.manifest.id)).toBe(true)
    await f.controller.disable(p)
    expect((await f.s.list())[0]?.enabled).toBe(false)
    expect(f.surfaces.list()).toHaveLength(0)
    await f.runtime.close()
  })
  it('failed hot updates preserve both the running and next-start version', async () => {
    const f = await fixture(), good = pack('0.2.0', 'good'), bad = pack('0.3.0', 'broken')
    await f.controller.apply(good)
    await expect(f.controller.apply(bad)).rejects.toThrow('activation failed')
    expect(f.loader.current(good.manifest.id)?.digest).toBe(good.digest)
    expect(await f.s.list()).toEqual([{...good, enabled: true}])
    expect(f.surfaces.list()).toHaveLength(1)
    await f.runtime.close()
  })
  it('does not let a queued stale disable overwrite a hot update or resurrect an uninstalled package',async()=>{
    const f=await fixture(),old=pack('0.1.0','old'),next=pack('0.1.0','new code same version')
    try{
      await f.controller.apply(old)
      const update=f.controller.apply(next)
      await expect(f.controller.disable(old)).rejects.toThrow('已变化')
      await update
      expect(await f.s.list()).toEqual([{...next,enabled:true}])
      expect(f.loader.current(old.manifest.id)?.digest).toBe(next.digest)
      await expect(f.controller.enableInstalled(old)).rejects.toThrow('已变化')
      await f.controller.disable(next)
      await f.controller.enableInstalled(next)
      expect((await f.s.list())[0]?.enabled).toBe(true)
      await f.s.remove(next.manifest.id,next.manifest.version)
      await expect(f.controller.disable(next)).rejects.toThrow('已变化')
      await expect(f.controller.enableInstalled(next)).rejects.toThrow('已变化')
      expect(await f.s.list()).toEqual([])
    }finally{await f.runtime.close()}
  })
  it('rolls back the runtime on save failure and permits a later successful update', async () => {
    const f = await fixture(), a = pack('0.1.0', 'a'), b = pack('0.2.0', 'b')
    await f.controller.apply(a)
    f.bridge.saveClientPlugin.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.controller.apply(b)).rejects.toThrow('disk full')
    expect(f.loader.current(a.manifest.id)?.digest).toBe(a.digest)
    expect((await f.s.list())[0]?.digest).toBe(a.digest)
    await f.controller.apply(b)
    expect((await f.s.list())[0]?.digest).toBe(b.digest)
    expect(f.surfaces.list()).toHaveLength(1)
    await f.runtime.close()
  })
  it('removes an uncommitted first install if saving fails', async () => {
    const f = await fixture()
    f.bridge.saveClientPlugin.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.controller.apply(pack())).rejects.toThrow('disk full')
    expect(f.runtime.list()).toHaveLength(0)
    expect(await f.s.list()).toEqual([])
    await f.runtime.close()
  })
  it('a broken startup plugin does not prevent later plugins or the default UI from loading', async () => {
    const f = await fixture(), bad = pack('0.1.0', 'broken'), good = pack('0.2.0', 'good')
    good.manifest.id = 'test.second'; good.digest = clientPackageDigest(good)
    await f.s.save({manifest: bad.manifest, program: bad.program}, true)
    await f.s.save({manifest: good.manifest, program: good.program}, true)
    await f.controller.start()
    expect(f.controller.errors.get(bad.manifest.id)).toContain('activation failed')
    expect(f.loader.isActive(good.manifest.id)).toBe(true)
    await f.runtime.close()
  })
})
