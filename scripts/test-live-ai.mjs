import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { ModelService } = require('../apps/pc-host/dist/model-service.js')
const { HostPluginService } = require('../apps/pc-host/dist/plugin-service.js')
const { PluginDraftService } = require('../apps/pc-host/dist/plugin-drafts.js')
const { createAuthorToolExecutor } = require('../apps/pc-host/dist/author-tools.js')
const { InstalledStaticToolStore, restoreInstalledStaticTools } = require('../apps/pc-host/dist/installed-static-tools.js')
const { installConfirmedTextTool } = require('../apps/pc-host/dist/static-tool-install.js')

/** No key in arguments, environment, files, output or reports. */
function readSecret() {
  return new Promise((resolve, reject) => {
    let buffered = ''
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdout.write('API test credential input ready (hidden)\n')
    const consume = chunk => {
      buffered += chunk.toString()
      if (buffered.includes('\u0003')) { cleanup(); reject(new Error('Cancelled')); return }
      if (!/[\r\n]/.test(buffered)) return
      const key = buffered.split(/[\r\n]/)[0].trim()
      buffered = ''
      cleanup()
      if (key) resolve(key); else reject(new Error('No credential supplied'))
    }
    function cleanup() {
      process.stdin.off('data', consume)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.stdin.on('data', consume)
  })
}

async function waitForReply(service, messages) {
  const events = []
  service.start({ streamId: crypto.randomUUID(), conversationId: 'live-test', assistantMessageId: crypto.randomUUID(), messages }, event => {
    events.push(event)
    if (event.event === 'model.authorTool') console.log(`${event.payload.phase}: ${event.payload.tool} (${event.payload.ok ? 'ok' : 'failed'})`)
  })
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const terminal = events.find(event => ['model.chat.completed', 'model.chat.failed', 'model.chat.cancelled'].includes(event.event))
    if (terminal?.event === 'model.chat.completed') return terminal.payload.text
    if (terminal) throw new Error(terminal.event === 'model.chat.failed' ? terminal.payload.error.message : 'Generation cancelled')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  service.close()
  throw new Error('Live model test timed out')
}

async function run() {
  const key = await readSecret()
  const modelsResponse = await fetch('https://api.deepseek.com/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(25000) })
  if (!modelsResponse.ok) throw new Error(`DeepSeek authentication/model discovery failed: HTTP ${modelsResponse.status}`)
  const data = await modelsResponse.json()
  const ids = data.data?.map(item => item.id) ?? []
  const model = process.env.MTC_TEST_MODEL || (ids.includes('deepseek-chat') ? 'deepseek-chat' : ids.find(id => id.includes('flash')) || ids[0])
  if (!model) throw new Error('No DeepSeek model available')
  console.log(`Testing provider model: ${model}`)
  const root = await mkdtemp(path.join(tmpdir(), 'mtc-live-model-'))
  let plugins = new HostPluginService(1, [])
  await plugins.start()
  const drafts = new PluginDraftService({ dataDir: root, installedPlugins: () => plugins.catalog().plugins })
  const store = new InstalledStaticToolStore(root)
  let requests = 0
  const service = new ModelService({ dataDir: root, generation: 1, authorTools: createAuthorToolExecutor(drafts),
    fetchImpl: async (url, init) => {
      requests++
      if (requests > 12) throw new Error('Live test request budget exhausted')
      return fetch(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) })
    } })
  try {
    await service.load()
    await service.setSettings({ baseUrl: 'https://api.deepseek.com', model, providerMode: 'openai-compatible', apiKey: key })
    const prompt = '实际使用作者工具创建并校验一个插件，id 必须是 example.live-uppercase，版本 0.1.0。功能是把当前输入框文字转成大写，source 为 composer-transform-action JSON，operation uppercase。不要只回答代码，不要安装。成功后用一句话告诉用户可确认安装。'
    const reply = await waitForReply(service, [{ role: 'user', content: prompt }])
    const created = await drafts.inspect()
    assert(created.drafts.some(draft => draft.id === 'example.live-uppercase' && draft.ok), 'Model did not create a valid requested draft')
    const install = await installConfirmedTextTool({ drafts, plugins, store, draftId: 'example.live-uppercase', confirmed: true })
    assert(install.installed, 'Generated plugin was not installable')
    const action = install.catalog.plugins.find(plugin => plugin.id === 'example.live-uppercase').composerActions[0]
    const output = await plugins.invoke('example.live-uppercase', action.id, 'Hello, plugin 你好!')
    assert.equal(output.text, 'HELLO, PLUGIN 你好!')
    assert.equal(output.replaceDraft, true)
    const update = '请实际用工具修订刚才 example.live-uppercase 插件。id 保持不变，版本 0.1.1；改为将输入框文字转成小写，operation lowercase。创建新草稿并校验，仍由用户确认更新。'
    await waitForReply(service, [{ role: 'user', content: prompt }, { role: 'assistant', content: reply }, { role: 'user', content: update }])
    const updated = await installConfirmedTextTool({ drafts, plugins, store, draftId: 'example.live-uppercase', confirmed: true })
    assert(updated.installed, 'Generated revision was not installable')
    const updatedAction = updated.catalog.plugins.find(plugin => plugin.id === 'example.live-uppercase').composerActions[0]
    assert.equal((await plugins.invoke('example.live-uppercase', updatedAction.id, 'Hello AI')).text, 'hello ai')
    await plugins.stop()
    plugins = new HostPluginService(2, []); await plugins.start()
    await restoreInstalledStaticTools(store, plugins)
    assert.equal((await plugins.invoke('example.live-uppercase', updatedAction.id, 'RESTORED')).text, 'restored')
    console.log(JSON.stringify({ passed: true, model, requests, generated: 'uppercase transform', updated: 'lowercase transform', restored: true, credentialPersisted: false }))
  } finally {
    service.close()
    await plugins.stop()
    assert(path.basename(root).startsWith('mtc-live-model-'))
    await rm(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error.message?.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]') || 'Live test failed'); process.exitCode = 1 })
