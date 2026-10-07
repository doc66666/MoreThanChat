import { describe, expect, it } from 'vitest'
import { hostToolsServiceId, type ContributionRegistrar, type HostTool, type PluginSource } from '@more-than-chat/plugin-runtime'
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
