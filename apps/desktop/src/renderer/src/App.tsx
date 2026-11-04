import { useState } from 'react'
import { UiSurface } from './UiSurface'
import { pluginRuntime, uiSurfaceRegistry } from './plugin-host'
import { restoreDefaultComposition } from './app-composition'

// The desktop shell mounts a composition, never imports product pages.
export function App() {
  const [error,setError]=useState('')
  return <UiSurface registry={uiSurfaceRegistry} name="application" context={{}} composition={pluginRuntime}>
    <div className="loading-screen"><p>{error||'正在加载应用插件…'}</p><button className="secondary-button" onClick={()=>void restoreDefaultComposition().catch(e=>setError(String(e)))}>恢复默认功能</button></div>
  </UiSurface>
}

// Source compatibility for the existing component contract tests.
export { MessageBubble, ModelSettingsPanel } from './workspace-components'
