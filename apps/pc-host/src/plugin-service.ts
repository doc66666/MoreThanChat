import { ContributionRegistry, hostToolsServiceId, type HostTool, type PluginSource } from '@more-than-chat/plugin-runtime'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { timeToolPlugin } from '@more-than-chat/plugin-time-tool'
import type { HostPluginCatalog } from '@more-than-chat/protocol'

export class HostPluginError extends Error {
  constructor(readonly code: 'PLUGIN_NOT_FOUND' | 'TOOL_UNAVAILABLE', message: string) {
    super(message)
  }
}

/** Serializes mutations and tool calls so deactivation cannot overlap execution. */
export class HostPluginService {
  readonly #tools = new ContributionRegistry<HostTool>()
  readonly #runtime = new CordisPluginRuntime({ target: 'pc-host', services: { [hostToolsServiceId]: this.#tools } })
  #operation: Promise<unknown> = Promise.resolve()
  #closing = false

  constructor(readonly generation: number, sources: readonly PluginSource[] = [{
    manifest: timeToolPlugin.manifest, trust: 'builtin', load: async () => timeToolPlugin,
  }]) {
    for (const source of sources) this.#runtime.install(source)
  }

  start(): Promise<void> {
    return this.#enqueue(async () => {
      for (const plugin of this.#runtime.list()) await this.#runtime.activate(plugin.manifest.id)
    })
  }

  catalog(): HostPluginCatalog {
    return {
      generation: this.generation,
      plugins: this.#runtime.list().map(plugin => ({
        id: plugin.manifest.id, displayName: plugin.manifest.displayName,
        description: plugin.manifest.description, version: plugin.manifest.version,
        status: plugin.status, error: plugin.error,
        tools: this.#tools.list().filter(tool => tool.ownerId === plugin.manifest.id)
          .map(({ contribution }) => ({ id: contribution.id, label: contribution.label })),
      })),
    }
  }

  setEnabled(pluginId: string, enabled: boolean): Promise<HostPluginCatalog> {
    return this.#enqueue(async () => {
      this.#requirePlugin(pluginId)
      if (enabled) await this.#runtime.activate(pluginId)
      else await this.#runtime.deactivate(pluginId)
      return this.catalog()
    })
  }

  invoke(pluginId: string, toolId: string): Promise<{ generation: number; text: string }> {
    return this.#enqueue(async () => {
      const plugin = this.#requirePlugin(pluginId)
      const tool = this.#tools.list().find(tool => tool.ownerId === pluginId && tool.contribution.id === toolId)
      if (plugin.status !== 'active' || !tool) throw new HostPluginError('TOOL_UNAVAILABLE', 'The requested tool is not active.')
      const text = await tool.contribution.run()
      if (typeof text !== 'string' || !text.trim() || text.length > 16_384) throw new Error('Invalid or oversized tool result.')
      return { generation: this.generation, text }
    })
  }

  stop(): Promise<void> {
    this.#closing = true
    const stopped = this.#operation.catch(() => undefined).then(async () => {
      await this.#runtime.close()
    })
    this.#operation = stopped
    return stopped
  }

  #requirePlugin(id: string) {
    const plugin = this.#runtime.list().find(plugin => plugin.manifest.id === id)
    if (!plugin) throw new HostPluginError('PLUGIN_NOT_FOUND', `Plugin '${id}' is not installed.`)
    return plugin
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('Host plugins are shutting down.'))
    const next = this.#operation.catch(() => undefined).then(operation)
    this.#operation = next
    return next
  }
}
