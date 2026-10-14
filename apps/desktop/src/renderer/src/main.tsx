import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { startBundledPlugins } from './plugin-host'
import { getClientPluginController } from './ClientPlugins'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Start once outside React StrictMode and independently of the plugin panel.
void startBundledPlugins().then(() => getClientPluginController().start()).catch(error => {
  console.error('本机插件加载失败', error)
})
