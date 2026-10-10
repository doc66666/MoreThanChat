import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { readSecret } from './live-test-input.mjs'
import { CdpClient, evaluate, waitForExpression, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root = path.resolve(import.meta.dirname, '..'), desktop = path.join(root, 'apps', 'desktop')
const executable = process.env.MTC_TEST_PACKAGED_EXE || createRequire(path.join(desktop, 'package.json'))('electron')
const packaged = Boolean(process.env.MTC_TEST_PACKAGED_EXE)
const live = process.argv.includes('--live'), profile = await mkdtemp(path.join(tmpdir(), 'mtc-ai-ui-'))
const pluginId = 'example.ui-uppercase', key = live ? await readSecret() : 'qa-only-test-token'
let server, requests = 0, baseUrl = 'https://api.deepseek.com', session
const model = live ? (process.env.MTC_TEST_MODEL || 'deepseek-flash') : 'qa-model'
if (!live) {
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const parsed = JSON.parse(body), round = parsed.messages.filter(message => message.role === 'tool').length; requests++
    const updating = parsed.messages.findLast(message => message.role === 'user')?.content.includes('0.1.1')
    const operation = updating ? 'lowercase' : 'uppercase', label = updating ? '英文小写' : '英文大写'
    const args = { manifestJson: JSON.stringify({ manifestVersion: 1, id: pluginId, version: updating ? '0.1.1' : '0.1.0', displayName: label, description: '转换输入框文字', targets: ['pc-host'], engine: { moreThanChat: '^0.1.0' }, permissions: [], services: { requires: ['host.tools'] } }),
      source: JSON.stringify({ kind: 'composer-transform-action', actionId: operation, label, operation }) }
    const delta = round < 2 ? { tool_calls: [{ index: 0, id: `call-${round}`, function: { name: round === 0 ? 'create_draft' : 'validate_draft', arguments: JSON.stringify(round === 0 ? args : { draftId: pluginId }) } }] } : { content: '草稿已校验，请确认安装。' }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: round < 2 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`
}
async function launch() {
  const port = await reservePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '.'], { cwd: desktop, env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  const client = await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  await waitForExpression(client, `document.querySelector('.host-status')?.dataset.hostState === 'ready'`)
  return { child, client }
}
async function close(value) {
  try { await Promise.race([value.client.send('Browser.close'), delay(500)]) } catch {}
  value.client.close(); await waitForExit(value.child, 4000); if (value.child.exitCode === null) value.child.kill()
}
async function poll(client, expression, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await evaluate(client, expression)) return; await delay(100) }
  throw new Error('AI UI verification timed out')
}
async function input(client, text) {
  await evaluate(client, `(() => { const i=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(i,${JSON.stringify(text)}); i.dispatchEvent(new Event('input',{bubbles:true})); })()`)
}
async function author(prompt) {
  await evaluate(session.client, `window.__qaTerminal=null`)
  await input(session.client, prompt)
  await poll(session.client, `!document.querySelector('.send-button')?.disabled`)
  await evaluate(session.client, `document.querySelector('.send-button')?.click()`)
  await poll(session.client, `Boolean(window.__qaTerminal)`, live ? 120000 : 15000)
  const terminal = await evaluate(session.client, `window.__qaTerminal`)
  if (terminal.type !== 'completed') throw new Error(`AI reply ${terminal.type}: ${terminal.error || 'incomplete'}`)
  await poll(session.client, `!document.querySelector('.send-button.stop')`, live ? 120000 : 15000)
}
async function installedPlugin() {
  return (await evaluate(session.client, `window.moreThanChat.getHostPlugins()`)).plugins.find(p => p.id === pluginId)
}
async function click(selector) {
  await poll(session.client, `Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).disabled`)
  await evaluate(session.client, `document.querySelector(${JSON.stringify(selector)})?.click()`)
}
try {
  session = await launch()
  await evaluate(session.client, `document.querySelector('button[title="设置"]')?.click()`)
  await poll(session.client, `Boolean(document.querySelector('.settings-drawer'))`)
  for (const [field, value] of Object.entries({ provider: 'openai-compatible', 'base-url': baseUrl, model, key })) {
    await evaluate(session.client, `(() => { const i=document.querySelector('[data-model-field="${field}"]'); const p=i.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(i,${JSON.stringify(value)}); i.dispatchEvent(new Event(i.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`)
  }
  await poll(session.client, `!document.querySelector('.settings-drawer .primary-button')?.disabled`)
  await evaluate(session.client, `document.querySelector('.settings-drawer .primary-button')?.click()`)
  await poll(session.client, `document.querySelector('.settings-drawer')?.dataset.hasApiKey==='true' && document.querySelector('[data-model-field="key"]')?.value === ''`)
  await evaluate(session.client, `document.querySelector('.settings-drawer .drawer-header button')?.click()`)
  assert(!(await readFile(path.join(profile, 'host-private', 'model-secret.bin'))).includes(Buffer.from(key)), 'Plaintext credential persisted')
  await assert.rejects(readFile(path.join(profile, 'host-private', 'model-credentials.json')), { code: 'ENOENT' })
  await evaluate(session.client, `[...document.querySelectorAll('.conversation-item')].find(n=>n.textContent.includes('More AI'))?.click()`)
  await evaluate(session.client, `(() => { window.__qaAuthorEvents=[]; window.moreThanChat.onModelChatEvent(e=>{ if(e.type==='author-tool')window.__qaAuthorEvents.push({tool:e.tool,phase:e.phase,ok:e.ok,summary:e.summary}); if(['completed','failed','cancelled'].includes(e.type))window.__qaTerminal={type:e.type,error:e.errorMessage}; }); })()`)
  await author(`实际使用作者工具创建并校验 ${pluginId} 插件，版本 0.1.0。将输入框文本转为大写，source 是 composer-transform-action JSON、operation uppercase。不要安装，只创建草稿供我确认。`)
  assert((await evaluate(session.client, `window.moreThanChat.inspectPluginDrafts()`)).drafts.some(draft => draft.id === pluginId && draft.ok), 'AI did not create the draft')
  assert.equal(await installedPlugin(), undefined, 'Model installed the plugin without confirmation')
  await evaluate(session.client, `document.querySelector('button[title="插件"]')?.click()`)
  const card = `.draft-card[data-draft-id="${pluginId}"]`
  await poll(session.client, `Boolean(document.querySelector(${JSON.stringify(card)}))`)
  await click(card + ' [data-draft-install]')
  await click(card + ' [data-draft-confirm-cancel]')
  assert.equal(await installedPlugin(), undefined, 'Cancelled confirmation installed the plugin')
  await click(card + ' [data-draft-install]')
  await click(card + ' [data-draft-confirm-ok]')
  const action = `.declarative-composer-action[data-plugin-id="${pluginId}"]`
  await poll(session.client, `Boolean(document.querySelector(${JSON.stringify(action)}))`)
  await input(session.client, 'Hello, plugin 你好!'); await evaluate(session.client, `document.querySelector(${JSON.stringify(action)})?.click()`)
  await poll(session.client, `document.querySelector('.composer textarea')?.value === 'HELLO, PLUGIN 你好!'`)
  if (!live) {
    await click('.plugin-drawer .drawer-header button')
    await author(`请用工具修订 ${pluginId}，版本 0.1.1，operation lowercase，生成并校验小写转换草稿，等我确认更新。`)
    assert.equal((await installedPlugin()).version, '0.1.0', 'AI activated an unconfirmed update')
    await click('button[title="插件"]')
    await click(card + ' [data-draft-update]')
    await click(card + ' [data-draft-confirm-cancel]')
    await input(session.client, 'Still Old')
    await click(action)
    await poll(session.client, `document.querySelector('.composer textarea')?.value === 'STILL OLD'`)
    const toggle = `.host-plugin-card[data-plugin-id="${pluginId}"] .plugin-toggle`
    await click(toggle)
    await poll(session.client, `!document.querySelector(${JSON.stringify(action)})`)
    await click(card + ' [data-draft-update]')
    await click(card + ' [data-draft-confirm-ok]')
    await poll(session.client, `document.querySelector(${JSON.stringify(`.host-plugin-card[data-plugin-id="${pluginId}"] small`)})?.textContent.includes('0.1.1') && document.querySelector(${JSON.stringify(toggle)})?.textContent==='启用'`)
    const updated = await installedPlugin()
    assert.equal(updated.version, '0.1.1')
    assert.equal(updated.status, 'inactive', 'Updating a disabled plugin enabled it')
    assert.equal(await evaluate(session.client, `Boolean(document.querySelector(${JSON.stringify(action)}))`), false)
    const versions = path.join(profile, 'host-private', 'installed-static-tools', 'versions', pluginId)
    assert.equal(JSON.parse(await readFile(path.join(versions, 'version-1.json'), 'utf8')).tool.transform, 'uppercase')
    assert.equal(JSON.parse(await readFile(path.join(versions, 'version-2.json'), 'utf8')).tool.transform, 'lowercase')
  }
  const capture = await session.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await mkdir(path.join(root, '.artifacts'), { recursive: true })
  await writeFile(path.join(root, '.artifacts', live ? 'ai-plugin-live-e2e.png' : packaged ? 'ai-plugin-packaged-e2e.png' : 'ai-plugin-e2e.png'), Buffer.from(capture.data, 'base64'))
  await close(session); session = await launch()
  assert((await evaluate(session.client, `window.moreThanChat.getModelSettings()`)).hasApiKey, 'Credential did not restore')
  const savedChat = JSON.parse(await readFile(path.join(profile, 'chat-state.json'), 'utf8'))
  assert(!JSON.stringify(savedChat).includes(key), 'Credential entered chat history')
  assert(Object.values(savedChat.messages).flat().some(message => message.status === 'sent' && message.authorNotes?.length), 'Authored chat did not persist')
  let installed = await installedPlugin()
  assert.equal(installed?.status, live ? 'active' : 'inactive', 'Plugin enable choice did not restore')
  if (!live) {
    assert.equal(installed.version, '0.1.1')
    assert.equal(await evaluate(session.client, `Boolean(document.querySelector(${JSON.stringify(action)}))`), false)
    await click('button[title="插件"]')
    await click(`.host-plugin-card[data-plugin-id="${pluginId}"] .plugin-toggle`)
    await poll(session.client, `Boolean(document.querySelector(${JSON.stringify(action)}))`)
    installed = await installedPlugin()
    await input(session.client, 'Hello Updated')
    await click(action)
    await poll(session.client, `document.querySelector('.composer textarea')?.value === 'hello updated'`)
  }
  assert.equal((await evaluate(session.client, `window.moreThanChat.invokeHostTool(${JSON.stringify(pluginId)},${JSON.stringify(installed.composerActions[0].id)},'restored')`)).text, live ? 'RESTORED' : 'restored')
  await evaluate(session.client, `window.moreThanChat.setModelSettings({clearApiKey:true})`)
  await assert.rejects(readFile(path.join(profile, 'host-private', 'model-secret.bin')), { code: 'ENOENT' })
  console.log(JSON.stringify({ passed: true, live, packaged, model, generatedByChat: true, userConfirmed: true, transformExecuted: true, credentialEncrypted: true, credentialRestored: true, pluginRestored: true, ...(live ? {} : { requests, updatedByChat: true, cancelledConfirmation: true, disabledUpdateRestored: true, immutableVersions: true }) }))
} catch (error) {
  console.error(String(error.message).split(key).join('[redacted]'))
  if (session) {
    const diagnostic = await evaluate(session.client, `({host:document.querySelector('.host-status')?.dataset.hostState,terminal:window.__qaTerminal,tools:window.__qaAuthorEvents})`).catch(() => null)
    console.error(JSON.stringify(diagnostic).split(key).join('[redacted]'))
  }
  process.exitCode = 1
}
finally {
  if (session) { try { await evaluate(session.client, `window.moreThanChat.setModelSettings({clearApiKey:true})`) } catch {}; await close(session) }
  if (server) await new Promise(resolve => server.close(resolve))
}
