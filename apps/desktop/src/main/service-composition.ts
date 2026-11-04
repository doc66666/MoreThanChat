import path from 'node:path'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { NodePluginDirectory } from '@more-than-chat/runtime-cordis/node'
import type { PluginContext, PluginSource } from '@more-than-chat/plugin-runtime'
import { ChatStore } from './chat-store'
import { AttachmentStore } from './attachments'
import { ClientIdentity } from './identity-store'
import { CentralClient } from './central-client'
import { DesktopIntegration } from './desktop-integration'

export function mainSource(
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
    description: '桌面默认服务',
    targets: ['pc-host'],
    permissions: ['host.trusted'],
    engine: { moreThanChat: '^0.1.0' },
    services: { requires, provides },
  } as const
  return { manifest, trust: 'builtin', load: async () => ({ manifest, activate }) }
}
export function createMainComposition(options: {
  directory: string
  cipher: Parameters<typeof ClientIdentity.load>[1]
  confirmOrigin: ConstructorParameters<typeof CentralClient>[4]
  ports: ConstructorParameters<typeof DesktopIntegration>[1]
  broadcast: (channel: string, value: unknown) => void
}) {
  const runtime = new CordisPluginRuntime({ target: 'pc-host' }),
    { directory, cipher, ports, broadcast } = options
  let ready = false
  const sources = [
    mainSource('builtin.main.store', [], ['chat.store'], async (ctx) => {
      const store = await ChatStore.open(directory)
      ctx.effect(() => store.close())
      ctx.provideService('chat.store', store)
    }),
    mainSource('builtin.main.attachments', [], ['chat.attachments'], (ctx) => {
      ctx.provideService(
        'chat.attachments',
        new AttachmentStore(path.join(directory, 'attachments')),
      )
    }),
    mainSource('builtin.main.identity', [], ['chat.identity'], async (ctx) => {
      let identity: ClientIdentity | null = null
      try {
        identity = await ClientIdentity.load(path.join(directory, 'host-private'), cipher)
      } catch {
        console.error('[identity] System encryption unavailable; local mode remains available')
      }
      ctx.provideService('chat.identity', identity)
    }),
    mainSource(
      'builtin.main.central',
      ['chat.identity', 'chat.store', 'chat.attachments'],
      ['central.client'],
      async (ctx) => {
        const identity = ctx.getService<ClientIdentity | null>('chat.identity')
        if (!identity) {
          ctx.provideService('central.client', null)
          return
        }
        const central = new CentralClient(
          identity,
          ctx.getService('chat.store'),
          ctx.getService('chat.attachments'),
          directory,
          options.confirmOrigin,
        )
        ctx.effect(() => central.disconnect(false))
        await central.load()
        ctx.provideService('central.client', central)
        if (ready) void central.restore()
      },
    ),
    mainSource(
      'builtin.main.desktop',
      ['chat.store', 'central.client'],
      ['desktop.integration'],
      async (ctx) => {
        const desktop = new DesktopIntegration(directory, ports)
        ctx.effect(async () => {
          await desktop.preferences.flush()
          desktop.dispose()
        })
        await desktop.initialize()
        ctx.provideService('desktop.integration', desktop)
      },
    ),
    mainSource(
      'builtin.main.synchronization',
      ['chat.store', 'central.client', 'desktop.integration'],
      [],
      (ctx) => {
        const central = ctx.getService<CentralClient | null>('central.client'),
          desktop = ctx.getService<DesktopIntegration>('desktop.integration')
        if (!central) return
        ctx.effect(
          central.subscribe((snapshot) => {
            desktop.notifications.reconcile()
            broadcast('central:changed', snapshot)
          }),
        )
        ctx.effect(
          central.onChat((state) => {
            desktop.update(state)
            broadcast('central:chat', state)
          }),
        )
        ctx.effect(central.onIncomingMessage((notice) => desktop.incoming(notice)))
        ctx.effect(central.onPlugin((event) => broadcast('central:plugin', event)))
        // A reconnect can finish while another dependency is still activating.
        // Publish the selected service's current projection as well as future events.
        broadcast('central:changed', central.snapshot())
        const state=ctx.getService<ChatStore>('chat.store').load()
        if(state){desktop.update(state);broadcast('central:chat',state)}
      },
    ),
  ]
  for (const source of sources) runtime.install(source)
  const extensions = new NodePluginDirectory(path.join(directory, 'main-plugins'), runtime, {
    version: 1,
  })
  return {
    runtime,
    extensions,
    markReady() {
      ready = true
    },
    async close() {
      await extensions.close()
      await runtime.close()
    },
  }
}
