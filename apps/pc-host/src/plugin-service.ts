import { ContributionRegistry, definePlugin, hostToolsServiceId, type HostTool, type PluginManifestV1, type PluginSource } from '@more-than-chat/plugin-runtime'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { timeToolPlugin } from '@more-than-chat/plugin-time-tool'
import type { HostPluginCatalog } from '@more-than-chat/protocol'
import { isAcceptedStaticTextTool, type DeclarativeComposerAction, type DeclarativeTextTool } from './static-text-tool'

export class HostPluginError extends Error {
  constructor(readonly code: 'PLUGIN_NOT_FOUND' | 'TOOL_UNAVAILABLE', message: string) {
    super(message)
  }
}

export class StaticToolInstallError extends Error {
  constructor(readonly reason: 'already-installed' | 'not-installable' | 'activation-failed' | 'persist-failed') {
    super(`Static tool install failed: ${reason}`)
    this.name = 'StaticToolInstallError'
  }
}

/** Serializes mutations and tool calls so deactivation cannot overlap execution. */
export class HostPluginService {
  readonly #tools = new ContributionRegistry<HostTool>()
  readonly #runtime = new CordisPluginRuntime({ target: 'pc-host', services: { [hostToolsServiceId]: this.#tools } })
  readonly #staticIds = new Set<string>()
  readonly #composerActionIds = new Map<string, Set<string>>()
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

  isStaticInstall(id: string): boolean {
    return this.#staticIds.has(id)
  }

  catalog(): HostPluginCatalog {
    return {
      generation: this.generation,
      plugins: this.#runtime.list().map(plugin => {
        const owned = this.#tools.list().filter(tool => tool.ownerId === plugin.manifest.id)
        const composerIds = this.#composerActionIds.get(plugin.manifest.id) ?? new Set<string>()
        const entry = ({ contribution }: { contribution: HostTool }) => ({ id: contribution.id, label: contribution.label })
        return {
          id: plugin.manifest.id, displayName: plugin.manifest.displayName,
          description: plugin.manifest.description, version: plugin.manifest.version,
          status: plugin.status, error: plugin.error,
          tools: owned.filter(tool => !composerIds.has(tool.contribution.id)).map(entry),
          composerActions: owned.filter(tool => composerIds.has(tool.contribution.id)).map(entry),
        }
      }),
    }
  }

  installStaticTool(manifest: PluginManifestV1, tool: DeclarativeTextTool, persist?: () => Promise<void>): Promise<HostPluginCatalog> {
    return persist
      ? this.#installClosedText(manifest, tool, 'tool', persist)
      : this.#installClosedText(manifest, tool, 'tool')
  }

  installStaticComposerAction(manifest: PluginManifestV1, action: DeclarativeComposerAction, persist?: () => Promise<void>): Promise<HostPluginCatalog> {
    return persist
      ? this.#installClosedText(manifest, action, 'composer', persist)
      : this.#installClosedText(manifest, action, 'composer')
  }

  #installClosedText(
    manifest: PluginManifestV1,
    contribution: DeclarativeTextTool,
    slot: 'tool' | 'composer',
    persist?: () => Promise<void>,
  ): Promise<HostPluginCatalog> {
    const toolId = contribution.id
    const label = contribution.label
    const text = contribution.text
    return this.#enqueue(async () => {
      if (!isAcceptedStaticTextTool(manifest, { id: toolId, label, text })) throw new StaticToolInstallError('not-installable')
      if (this.#runtime.list().some(plugin => plugin.manifest.id === manifest.id)) {
        throw new StaticToolInstallError('already-installed')
      }
      this.#runtime.install({
        manifest,
        trust: 'trusted',
        load: async () => definePlugin({
          manifest,
          activate(context) {
            const tools = context.getService<ContributionRegistry<HostTool>>(hostToolsServiceId)
            context.contribute(tools, { id: toolId, label, run: () => text })
          },
        }),
      })
      try {
        await this.#runtime.activate(manifest.id)
      }
      catch {
        await this.#runtime.uninstall(manifest.id).catch(() => undefined)
        this.#staticIds.delete(manifest.id)
        this.#composerActionIds.delete(manifest.id)
        throw new StaticToolInstallError('activation-failed')
      }
      try {
        await persist?.()
      }
      catch {
        await this.#runtime.uninstall(manifest.id).catch(() => undefined)
        this.#staticIds.delete(manifest.id)
        this.#composerActionIds.delete(manifest.id)
        throw new StaticToolInstallError('persist-failed')
      }
      if (slot === 'composer') {
        const ids = this.#composerActionIds.get(manifest.id) ?? new Set<string>()
        ids.add(toolId)
        this.#composerActionIds.set(manifest.id, ids)
      }
      this.#staticIds.add(manifest.id)
      return this.catalog()
    })
  }

  uninstall(pluginId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#runtime.list().some(plugin => plugin.manifest.id === pluginId)) {
        await this.#runtime.uninstall(pluginId)
      }
      this.#staticIds.delete(pluginId)
      this.#composerActionIds.delete(pluginId)
    })
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
