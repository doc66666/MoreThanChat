import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UiSurfaceRegistry, uiSurfacesServiceId, type PluginManifestV1 } from '@more-than-chat/plugin-runtime'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { UiSurface } from '../src/renderer/src/UiSurface'

const manifest: PluginManifestV1 = {
  manifestVersion: 1, id: 'test.custom-desktop', version: '0.1.0', displayName: 'Custom desktop',
  description: 'Executable UI composition fixture, not installed in normal releases.',
  targets: ['pc-ui'], engine: { moreThanChat: '^0.1.0' }, permissions: [], services: { requires: [uiSurfacesServiceId] },
}
const render = (registry: UiSurfaceRegistry) => renderToStaticMarkup(h(UiSurface, {
  registry, name: 'root', context: { title: '聊天环境' }, children: h('main', null, 'Default desktop'),
}))

describe('executable desktop composition', () => {
  it('prefers a conversation instance over its same-package local view and restores local without changing other priorities',async()=>{
    const registry=new UiSurfaceRegistry()
    registry.register('local.game',{id:'root',surface:'root',priority:-10,render:()=> 'local'})
    const shared=registry.registerInstance('shared.game','local.game',{id:'root',surface:'root',priority:5,render:()=> 'shared'})
    expect(render(registry)).toBe('shared')
    const other=registry.register('other',{id:'root',surface:'root',priority:-100,render:()=> 'other'})
    expect(render(registry)).toBe('other');await other();expect(render(registry)).toBe('shared')
    await shared();expect(render(registry)).toBe('local')
  })
  it('keeps the original desktop when no replacement is installed', () => {
    expect(render(new UiSurfaceRegistry())).toBe('<main>Default desktop</main>')
  })
  it('replaces the entire root and renders arbitrary plugin-defined nested surfaces', async () => {
    const registry = new UiSurfaceRegistry()
    const runtime = new CordisPluginRuntime({ target: 'pc-ui', services: { [uiSurfacesServiceId]: registry } })
    runtime.install({ manifest, trust: 'trusted', load: async () => ({ manifest, activate(ctx) {
      const ui = ctx.getService<UiSurfaceRegistry>(uiSurfacesServiceId)
      ctx.contribute(ui, { id: 'shell', surface: 'root', render: ({ renderSurface }) =>
        h('section', { 'data-custom-desktop': true, style: { display: 'grid', gridTemplateColumns: '2fr 1fr' } },
          h('header', null, 'My desktop'), renderSurface('custom.workspace.board') as ReactNode) })
      ctx.contribute(ui, { id: 'board', surface: 'custom.workspace.board', render: ({ context, renderSurface }) =>
        h('article', null, (context as { title: string }).title, renderSurface('custom.workspace.actions') as ReactNode) })
      ctx.contribute(ui, { id: 'actions', surface: 'custom.workspace.actions', render: () => h('button', null, 'Custom action') })
    } }) })
    for (let n = 0; n < 3; n++) {
      await runtime.activate(manifest.id)
      const html = render(registry)
      expect(html).toContain('data-custom-desktop')
      expect(html).toContain('grid-template-columns:2fr 1fr')
      expect(html).toContain('聊天环境')
      expect(html).toContain('Custom action')
      expect(html).not.toContain('Default desktop')
      await runtime.deactivate(manifest.id)
      expect(registry.list()).toHaveLength(0)
      expect(render(registry)).toBe('<main>Default desktop</main>')
    }
    await runtime.close()
  })
  it('allows a plugin to wrap the built-in desktop instead of replacing its contents', () => {
    const registry = new UiSurfaceRegistry()
    registry.register('wrapper', { id: 'shell', surface: 'root', render: ({ defaultView }) => h('section', null, 'New frame', defaultView as ReactNode) })
    expect(render(registry)).toContain('New frame<main>Default desktop</main>')
  })
  it('restores the previous winner after removing a higher-priority replacement', async () => {
    const registry = new UiSurfaceRegistry()
    registry.register('one', { id: 'root', surface: 'root', render: () => 'first' })
    registry.register('two', { id: 'root', surface: 'root', render: () => 'second' })
    expect(render(registry)).toBe('first')
    const dispose = registry.register('override', { id: 'root', surface: 'root', priority: -10, render: () => 'override' })
    expect(render(registry)).toBe('override')
    await dispose()
    expect(render(registry)).toBe('first')
  })
  it('bounds recursive surface composition without limiting names to the legacy nine placements', () => {
    const registry = new UiSurfaceRegistry()
    registry.register('loop', { id: 'root', surface: 'root', render: ({ renderSurface }) => renderSurface('my.region') })
    registry.register('loop', { id: 'child', surface: 'my.region', render: ({ renderSurface }) => renderSurface('root', {}, 'Cycle fallback') })
    expect(render(registry)).toBe('Cycle fallback')
  })
  it('cleans up root replacement after failed Cordis activation', async () => {
    const registry = new UiSurfaceRegistry()
    const runtime = new CordisPluginRuntime({ target: 'pc-ui', services: { [uiSurfacesServiceId]: registry } })
    runtime.install({ manifest, trust: 'trusted', load: async () => ({ manifest, activate(ctx) {
      ctx.contribute(registry, { id: 'root', surface: 'root', render: () => 'broken' })
      throw new Error('fixture activation failed')
    } }) })
    await expect(runtime.activate(manifest.id)).rejects.toThrow()
    expect(registry.list()).toEqual([])
    expect(render(registry)).toBe('<main>Default desktop</main>')
    await runtime.close()
  })
  it('freezes registration metadata and rejects malformed surface declarations', () => {
    const registry = new UiSurfaceRegistry()
    const contribution = { id: 'root', surface: 'root', priority: 0, render: () => 'registered' }
    registry.register('owner', contribution)
    contribution.surface = 'other'
    expect(render(registry)).toBe('registered')
    expect(() => registry.register('owner', { ...contribution, surface: '../arbitrary' })).toThrow()
    expect(() => registry.register('owner', { ...contribution, priority: NaN })).toThrow()
  })
})
