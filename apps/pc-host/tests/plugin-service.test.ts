import { describe, expect, it } from 'vitest'
import { hostToolsServiceId, type ContributionRegistrar, type HostTool, type PluginManifestV1, type PluginSource } from '@more-than-chat/plugin-runtime'
import { timeToolPlugin } from '@more-than-chat/plugin-time-tool'
import { HostPluginService } from '../src/plugin-service'

describe('HostPluginService', () => {
  it('runs a bundled plugin and clears its tool on every deactivate', async () => {
    const service = new HostPluginService(7)
    await service.start()
    const result = await service.invoke('builtin.time-tool', 'current-time')
    expect(result.generation).toBe(7)
    expect(result.text).toMatch(/^当前时间：\d{4}-\d{2}-\d{2}T/)
    for (let i = 0; i < 100; i++) {
      const inactive = await service.setEnabled('builtin.time-tool', false)
      expect(inactive.plugins[0]).toMatchObject({ status: 'inactive', tools: [] })
      await expect(service.invoke('builtin.time-tool', 'current-time')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
      const active = await service.setEnabled('builtin.time-tool', true)
      expect(active.plugins[0]!.tools).toHaveLength(1)
    }
    await service.stop()
    expect(service.catalog().plugins[0]).toMatchObject({ status: 'inactive', tools: [] })
    await expect(service.invoke('builtin.time-tool', 'current-time')).rejects.toThrow('shutting down')
  })

  it('installs a declarative text tool without replacing an existing plugin', async () => {
    const service = new HostPluginService(3)
    await service.start()
    const marker = 'static-note-body'
    const catalog = await service.installStaticTool(staticManifest(), { id: 'note', label: '便签', text: marker })
    expect(catalog.plugins.map(plugin => plugin.id)).toEqual(['builtin.time-tool', 'example.note'])
    expect(catalog.plugins[1]).toMatchObject({ status: 'active', tools: [{ id: 'note', label: '便签' }] })
    await expect(service.invoke('example.note', 'note')).resolves.toEqual({ generation: 3, text: marker })

    const disabled = await service.setEnabled('example.note', false)
    expect(disabled.plugins.find(plugin => plugin.id === 'example.note')).toMatchObject({ status: 'inactive', tools: [] })
    await expect(service.invoke('example.note', 'note')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    const enabled = await service.setEnabled('example.note', true)
    expect(enabled.plugins.find(plugin => plugin.id === 'example.note')?.tools).toEqual([{ id: 'note', label: '便签' }])
    await expect(service.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })

    await expect(service.installStaticTool(staticManifest(), { id: 'note', label: '便签', text: 'replaced' })).rejects.toMatchObject({ reason: 'already-installed' })
    await expect(service.installStaticTool(staticManifest('builtin.time-tool'), { id: 'current-time', label: '当前时间', text: 'replaced' })).rejects.toMatchObject({ reason: 'already-installed' })
    expect((await service.invoke('builtin.time-tool', 'current-time')).text).not.toBe('replaced')
    await expect(service.invoke('example.note', 'note')).resolves.toMatchObject({ text: marker })

    const hostile: PluginManifestV1 = { ...staticManifest('example.files'), permissions: ['files'] }
    await expect(service.installStaticTool(hostile, { id: 'note', label: '便签', text: marker })).rejects.toMatchObject({ reason: 'not-installable' })
    expect(service.catalog().plugins.map(plugin => plugin.id)).toEqual(['builtin.time-tool', 'example.note'])
    await service.stop()
  })

  it('rejects unknown plugins and tools', async () => {
    const service = new HostPluginService(1)
    await service.start()
    await expect(service.setEnabled('missing', true)).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND' })
    await expect(service.invoke('builtin.time-tool', 'missing')).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' })
    await service.stop()
  })

  it('waits for an in-flight tool before disposing its resources', async () => {
    let complete!: (value: string) => void
    const result = new Promise<string>(resolve => { complete = resolve })
    const source: PluginSource = {
      manifest: timeToolPlugin.manifest, trust: 'builtin',
      load: async () => ({ manifest: timeToolPlugin.manifest, activate(context) {
        context.contribute(context.getService<ContributionRegistrar<HostTool>>(hostToolsServiceId), {
          id: 'slow', label: 'Slow tool', run: () => result,
        })
      } }),
    }
    const service = new HostPluginService(1, [source])
    await service.start()
    const invoking = service.invoke('builtin.time-tool', 'slow')
    const stopping = service.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    complete('finished')
    await expect(invoking).resolves.toEqual({ generation: 1, text: 'finished' })
    await stopping
    expect(service.catalog().plugins[0]!.tools).toHaveLength(0)
  })
})

function staticManifest(id = 'example.note'): PluginManifestV1 {
  return {
    manifestVersion: 1,
    id,
    version: '0.1.0',
    displayName: '便签',
    description: '返回一段固定文本。',
    targets: ['pc-host'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: [],
    services: { requires: ['host.tools'] },
  }
}
