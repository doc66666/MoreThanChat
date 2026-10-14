import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ClientPluginStore, clientPackageDigest } from '../src/main/client-plugins'
import { ClientPluginLoader } from '../src/renderer/src/client-plugin-loader'
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
  it('requires explicit full trust and supported target/engine, rejects reserved IDs and invalid format', () => {
    for (const change of [{permissions: []}, {targets: ['pc-host']}, {id: 'builtin.replace'}, {engine: {moreThanChat: '^99.0.0'}}, {services: {requires: ['secrets']}}]) {
      const p = pack()
      expect(() => parseExecutableClientPackage({manifest: {...p.manifest, ...change}, program: p.program})).toThrow()
    }
    expect(() => parseExecutableClientPackage({manifest: pack().manifest, program: {kind: 'executable-client', code: 'x'.repeat(100001)}})).toThrow()
  })
  it('persists immutable snapshots without executing; updates only selected ID and serializes concurrent writes', async () => {
    const s = await store(), initial = pack(), next = pack('0.2.0')
    expect(await s.list()).toEqual([])
    await Promise.all([s.save({manifest: initial.manifest, program: initial.program}), s.save({manifest: next.manifest, program: next.program})])
    expect(await s.list()).toEqual([next])
    expect(clientPackageDigest(next)).toBe(next.digest)
    const text = await readFile(path.join(s.directory, 'installed.json'), 'utf8')
    expect(text).not.toContain('enabled')
    expect(await new ClientPluginStore(path.dirname(s.directory)).list()).toEqual([next])
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
