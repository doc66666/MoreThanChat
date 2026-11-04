import { useLayoutEffect, useState } from 'react'
import type { ComposedPluginRuntime } from '@more-than-chat/plugin-runtime'
let composition: ComposedPluginRuntime | undefined
export function bindAppComposition(runtime: ComposedPluginRuntime) {
  composition = runtime
}
function selectedApi(): Window['moreThanChat'] {
  return composition ? composition.services.get('desktop.api') : window.moreThanChat
}

/** Commit subscriptions after a whole provider transaction, preserving hook state. */
export function useDesktopApi(): Window['moreThanChat'] {
  const [api, setApi] = useState(selectedApi)
  useLayoutEffect(() => {
    const sync = () => {
      if (composition?.services.has('desktop.api')) setApi(selectedApi())
    }
    const dispose = composition?.subscribeComposition(sync)
    sync()
    return () => {
      void dispose?.()
    }
  }, [])
  return api
}

/** Product code consumes the selected provider. The native preload is only the
 * default provider, not a second path privileged over installed plugins. */
export const appApi = new Proxy({} as Window['moreThanChat'], {
  get(_target, key) {
    const api = selectedApi()
    const value = Reflect.get(api, key)
    return typeof value === 'function' ? value.bind(api) : value
  },
})
