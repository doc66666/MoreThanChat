import {
  TransportRegistry,
  chatTransportsServiceId,
} from '@more-than-chat/chat-core'
import { helloWorldManifest } from '@more-than-chat/plugin-hello-world/manifest'
import {
  ContributionRegistry,
  PluginRuntime,
  composerActionsServiceId,
  type ComposerAction,
  type PluginSource,
  uiSlotsServiceId,
  type UiSlotContribution,
} from '@more-than-chat/plugin-runtime'
import {
  localTransportManifest,
  localTransportRuntimePlugin,
} from './local-transport'
import {
  centralTransportManifest,
  centralTransportPlugin,
} from './central-transport'
import { slotDemoManifest, slotDemoPlugin } from './slot-demo'

export const transportRegistry = new TransportRegistry()
export const composerActionRegistry = new ContributionRegistry<ComposerAction>()
export const uiSlotRegistry = new ContributionRegistry<UiSlotContribution>()
/** Narrow group transport shared by trusted UI plugins and the data-only runtime. */
export const chatNetworkService = {
  forPlugin: (pluginId: string) => ({
    send: (groupId: string, channel: string, payload: unknown, stateVersion?: {digest:string;expectedRevision:number}) =>
      window.moreThanChat.serverAction('plugins/event', {groupId,pluginId,channel,payload,...stateVersion}).then(() => undefined),
    history: (groupId: string) => window.moreThanChat.getPluginInbox(groupId, pluginId),
    subscribe: (groupId: string, listener: (event: unknown) => void) =>
      window.moreThanChat.onPluginEvent((event) => {
        if (event.pluginId === pluginId && event.groupId === groupId) listener(event)
      }),
  }),
}
export const pluginRuntime = new PluginRuntime({
  target: 'pc-ui',
  services: {
    [chatTransportsServiceId]: transportRegistry,
    [composerActionsServiceId]: composerActionRegistry,
    [uiSlotsServiceId]: uiSlotRegistry,
    'chat.network': chatNetworkService,
  },
})

const bundledPlugins: readonly PluginSource[] = [
  {
    manifest: centralTransportManifest,
    trust: 'builtin',
    load: async () => ({ default: centralTransportPlugin }),
  },
  {
    manifest: slotDemoManifest,
    trust: 'builtin',
    load: async () => ({ default: slotDemoPlugin }),
  },
  {
    manifest: localTransportManifest,
    trust: 'builtin',
    load: async () => ({ default: localTransportRuntimePlugin }),
  },
  {
    manifest: helloWorldManifest,
    trust: 'builtin',
    load: () => import('@more-than-chat/plugin-hello-world'),
  },
]

for (const source of bundledPlugins) pluginRuntime.install(source)

let startPromise: Promise<void> | undefined

export function startBundledPlugins(): Promise<void> {
  if (startPromise) return startPromise
  startPromise = Promise.all(
    bundledPlugins.map((source) => pluginRuntime.activate(source.manifest.id)),
  )
    .then(() => undefined)
    .catch((error) => {
      startPromise = undefined
      throw error
    })
  return startPromise
}
