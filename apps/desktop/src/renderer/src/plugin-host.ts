import { TransportRegistry, chatTransportsServiceId } from '@more-than-chat/chat-core'
import { helloWorldManifest } from '@more-than-chat/plugin-hello-world/manifest'
import {
  ContributionRegistry,
  PluginRuntime,
  composerActionsServiceId,
  type ComposerAction,
  type PluginSource,
} from '@more-than-chat/plugin-runtime'
import { localTransportManifest, localTransportRuntimePlugin } from './local-transport'

export const transportRegistry = new TransportRegistry()
export const composerActionRegistry = new ContributionRegistry<ComposerAction>()
export const pluginRuntime = new PluginRuntime({
  target: 'pc-ui',
  services: {
    [chatTransportsServiceId]: transportRegistry,
    [composerActionsServiceId]: composerActionRegistry,
  },
})

const bundledPlugins: readonly PluginSource[] = [
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
  startPromise = Promise.all(bundledPlugins.map(source => pluginRuntime.activate(source.manifest.id)))
    .then(() => undefined)
    .catch(error => {
      startPromise = undefined
      throw error
    })
  return startPromise
}
