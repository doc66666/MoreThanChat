import {
  TransportRegistry,
  chatTransportsServiceId,
} from '@more-than-chat/chat-core'
import { helloWorldManifest } from '@more-than-chat/plugin-hello-world/manifest'
import {
  ContributionRegistry,
  UiSurfaceRegistry,
  uiSurfacesServiceId,
  composerActionsServiceId,
  type ComposerAction,
  type PluginSource,
  uiSlotsServiceId,
  type UiSlotContribution,
} from '@more-than-chat/plugin-runtime'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import {
  localTransportManifest,
  localTransportRuntimePlugin,
} from './local-transport'
import {
  centralTransportManifest,
  centralTransportPlugin,
} from './central-transport'
import { slotDemoManifest, slotDemoPlugin } from './slot-demo'
import { bindAppComposition } from './app-api'

export const transportRegistry = new TransportRegistry()
export const composerActionRegistry = new ContributionRegistry<ComposerAction>()
export const uiSlotRegistry = new ContributionRegistry<UiSlotContribution>()
export const uiSurfaceRegistry = new UiSurfaceRegistry()
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
export const pluginRuntime = new CordisPluginRuntime({
  target: 'pc-ui',
  services: {
    [chatTransportsServiceId]: transportRegistry,
    [composerActionsServiceId]: composerActionRegistry,
    [uiSlotsServiceId]: uiSlotRegistry,
    [uiSurfacesServiceId]: uiSurfaceRegistry,
    'chat.network': chatNetworkService,
  },
})
bindAppComposition(pluginRuntime)

const demoPlugins: readonly PluginSource[] = [
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

const bundledPlugins: readonly PluginSource[] = [
  { manifest: centralTransportManifest, trust: 'builtin', load: async () => ({ default: centralTransportPlugin }) },
  ...(window.moreThanChat.demoPluginsEnabled ? demoPlugins : []),
]

for (const source of bundledPlugins) pluginRuntime.install(source)

let startPromise: Promise<void> | undefined

export function startBundledPlugins(): Promise<void> {
  if (startPromise) return startPromise
  startPromise = import('./app-composition').then(async ({appSources,disabledBuiltins}) => {
    const disabled=disabledBuiltins()
    for(const source of appSources)if(!pluginRuntime.list().some(p=>p.manifest.id===source.manifest.id))pluginRuntime.install(source)
    await pluginRuntime.start([...bundledPlugins,...appSources].filter(source=>!disabled.has(source.manifest.id)).map(source=>source.manifest.id),true)
  })
    .then(() => undefined)
    .catch((error) => {
      startPromise = undefined
      throw error
    })
  return startPromise
}
