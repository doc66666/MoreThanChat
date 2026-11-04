import path from 'node:path'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { NodePluginDirectory } from '@more-than-chat/runtime-cordis/node'
import type { PluginContext, PluginSource } from '@more-than-chat/plugin-runtime'
import { HostPluginService } from './plugin-service'
import { PluginDraftService } from './plugin-drafts'
import { InstalledStaticToolStore, restoreInstalledStaticTools } from './installed-static-tools'
import { createPluginManagement } from './plugin-management'
import { createAuthorToolExecutor } from './author-tools'
import { ModelService } from './model-service'
import type { HostCredentialClient } from './credential-client'
import type { HostPluginCatalog } from '@more-than-chat/protocol'

function source(
  id: string,
  requires: string[],
  provides: string[],
  activate: (ctx: PluginContext) => void | Promise<void>,
): PluginSource {
  const manifest = {
    manifestVersion: 1,
    id,
    version: '0.1.0',
    displayName: id,
    description: '默认 Host 服务',
    targets: ['pc-host'],
    permissions: ['host.trusted'],
    engine: { moreThanChat: '^0.1.0' },
    services: { requires, provides },
  } as const
  return { manifest, trust: 'builtin', load: async () => ({ manifest, activate }) }
}
export class HostComposition {
  readonly runtime = new CordisPluginRuntime({ target: 'pc-host' })
  readonly extensions: NodePluginDirectory
  constructor(
    readonly options: {
      generation: number
      directory: string
      demo: boolean
      credentials: HostCredentialClient
    },
  ) {
    const { generation, directory, demo, credentials } = options
    const sources = [
      source('builtin.host.credentials', [], ['host.credentials'], (ctx) => {
        ctx.provideService('host.credentials', credentials)
      }),
      source('builtin.host.tools', [], ['host.plugins'], (ctx) => {
        const plugins = new HostPluginService(generation, demo ? undefined : [])
        ctx.provideService('host.plugins', plugins)
        ctx.effect(() => plugins.stop())
      }),
      source('builtin.host.tool-store', [], ['host.tool-store'], (ctx) => {
        ctx.provideService('host.tool-store', new InstalledStaticToolStore(directory))
      }),
      source('builtin.host.drafts', ['host.plugins'], ['host.drafts'], (ctx) => {
        const plugins = ctx.getService<HostPluginService>('host.plugins')
        ctx.provideService(
          'host.drafts',
          new PluginDraftService({
            dataDir: directory,
            installedPlugins: () =>
              plugins
                .catalog()
                .plugins.map((p) => ({
                  id: p.id,
                  version: p.version,
                  displayName: p.displayName,
                  status: p.status,
                })),
          }),
        )
      }),
      source(
        'builtin.host.management',
        ['host.drafts', 'host.plugins', 'host.tool-store', 'host.credentials'],
        ['host.management'],
        (ctx) => {
          ctx.provideService(
            'host.management',
            createPluginManagement(
              ctx.getService('host.drafts'),
              ctx.getService('host.plugins'),
              ctx.getService('host.tool-store'),
              (request) =>
                ctx.getService<HostCredentialClient>('host.credentials').managePlugins(request),
            ),
          )
        },
      ),
      source(
        'builtin.host.author',
        ['host.drafts', 'host.management', 'host.credentials'],
        ['host.author'],
        (ctx) => {
          ctx.provideService(
            'host.author',
            createAuthorToolExecutor(
              ctx.getService('host.drafts'),
              ctx.getService('host.management'),
              (request) =>
                ctx.getService<HostCredentialClient>('host.credentials').accessChat(request),
            ),
          )
        },
      ),
      source(
        'builtin.host.agent',
        ['host.author', 'host.credentials'],
        ['model.agent'],
        async (ctx) => {
          const model = new ModelService({
            defaultProviderMode: demo ? 'mock' : 'openai-compatible',
            dataDir: directory,
            generation,
            authorTools: ctx.getService('host.author'),
            credentials: ctx.getService('host.credentials'),
          })
          ctx.effect(() => model.close())
          await model.load()
          ctx.provideService('model.agent', model)
        },
      ),
      source('builtin.host.tools-restore', ['host.plugins', 'host.tool-store'], [], async (ctx) => {
        const plugins = ctx.getService<HostPluginService>('host.plugins')
        await plugins.start()
        await restoreInstalledStaticTools(ctx.getService('host.tool-store'), plugins)
      }),
    ]
    for (const entry of sources) this.runtime.install(entry)
    this.extensions = new NodePluginDirectory(path.join(directory, 'plugins'), this.runtime, {
      version: 1,
    })
  }
  get<T>(id: string) {
    return this.runtime.services.get<T>(id)
  }
  catalog(): HostPluginCatalog {
    const tools = this.runtime.services.has('host.plugins')
      ? this.get<HostPluginService>('host.plugins').catalog().plugins
      : []
    return {
      generation: this.options.generation,
      plugins: [
        ...tools,
        ...this.runtime
          .list()
          .map((p) => ({
            id: p.manifest.id,
            displayName: p.manifest.displayName,
            description: p.manifest.description,
            version: p.manifest.version,
            status: p.status,
            error: this.extensions.errors.get(p.manifest.id) ?? p.error,
            tools: [],
            composerActions: [],
          })),
      ],
    }
  }
  async setEnabled(id: string, enabled: boolean): Promise<HostPluginCatalog> {
    if (this.runtime.list().some((p) => p.manifest.id === id))
      await this.extensions.setEnabled(id, enabled)
    else {
      await this.get<HostPluginService>('host.plugins').setEnabled(id, enabled)
      await this.get<InstalledStaticToolStore>('host.tool-store').setEnabled(id, enabled)
    }
    return this.catalog()
  }
  async start() {
    await this.extensions.prepare()
    await this.runtime.start(this.runtime.list().map(p => p.manifest.id).filter(id => this.extensions.isEnabled(id)), true)
    await this.extensions.start()
  }
  async close() {
    await this.extensions.close()
    await this.runtime.close()
  }
}
