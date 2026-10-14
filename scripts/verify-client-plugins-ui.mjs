import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CdpClient, evaluate, reservePort, waitForTarget, waitForExit, delay } from './verify-plugin-ui.mjs'

// Real Electron + actual preload/IPC/Host/store/Blob modules. No mocked permission
// dialogs or privileged test-install channel; clicks use the normal draft UI.
const root = path.resolve(import.meta.dirname, '..'), desktop = path.join(root, 'apps/desktop')
await mkdir(path.join(root, '.artifacts'), {recursive: true})
const profile = await mkdtemp(path.join(root, '.artifacts/client-plugin-flow-'))
const executable = process.env.MTC_TEST_PACKAGED_EXE || createRequire(path.join(desktop, 'package.json'))('electron')
const original = JSON.parse(await readFile(path.join(root, 'examples/client-desktop.mtcplugin'), 'utf8'))
const id = original.manifest.id, evidence = [], errors = []
let session, passed = false
const limit = (promise, ms = 15000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Client plugin test timeout')), ms)})]).finally(() => clearTimeout(timer))
}
async function value(expression) {return limit(evaluate(session.client, expression))}
async function poll(expression) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {if (await value(expression)) return; await delay(80)}
  throw new Error('UI did not reach: ' + expression)
}
async function launch() {
  const port = await reservePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '.'], {cwd: desktop, env: {...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
  child.stdout.resume(); child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => errors.push(chunk))
  session = {child, port}
  const target = await waitForTarget(port)
  session.target = target.id; session.client = await CdpClient.connect(target.webSocketDebuggerUrl)
  await poll('Boolean(window.moreThanChat)')
}
async function close() {
  if (!session) return
  try {if (session.client) await limit(session.client.send('Browser.close'), 1000)} catch {}
  session.client?.close(); await waitForExit(session.child, 5000)
  if (session.child.exitCode === null) session.child.kill()
  session = undefined
}
async function click(selector) {
  await poll(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).disabled`)
  await value(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function textButton(text) {
  // The drawer mounts before its asynchronous installed-plugin query finishes.
  // Wait for the actual enabled action, not merely the section container.
  await poll(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`)
  await value(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b)throw Error('Missing button'); b.click()})()`)
}
async function showChat() {
  if (await value(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='显示默认聊天'))`)) await textButton('显示默认聊天')
  await poll(`document.querySelector('.host-status')?.dataset.hostState==='ready'`)
}
async function plugins() {
  await showChat()
  if (await value(`Boolean(document.querySelector('.plugin-drawer'))`)) await click('.plugin-drawer .drawer-header button')
  await click('button[title="插件"]')
  await poll(`Boolean(document.querySelector('[data-client-plugins]'))`)
}
function pack(version, broken = false) {
  const p = structuredClone(original)
  p.manifest.version = version
  p.program.code = p.program.code.replace('我的插件工作台', `我的插件工作台 ${version}`)
    .replace('ctx.contribute(', `globalThis.__clientLive=(globalThis.__clientLive||0)+1;ctx.effect(()=>{globalThis.__clientLive--;globalThis.__clientDisposed=(globalThis.__clientDisposed||0)+1});${broken ? 'throw new Error("qa activation failed");' : ''}ctx.contribute(`)
  return p
}
async function draftInstall(p) {
  await value(`window.moreThanChat.createPluginDraft(${JSON.stringify({manifestJson: JSON.stringify(p.manifest), source: JSON.stringify(p.program)})})`)
  const revision = (await value('window.moreThanChat.inspectPluginDrafts()')).drafts.find(d => d.id === id).revision
  await plugins()
  await poll(`document.querySelector('[data-draft-id="${id}"] small')?.textContent.includes('r${revision} ·')`)
  await click(`[data-draft-id="${id}"] [data-client-install]`)
}
async function installed() {return (await value('window.moreThanChat.getClientPlugins()')).find(p => p.manifest.id === id)}
async function reconnectReplacement() {
  const oldId = session.target, deadline = Date.now() + 15000
  let next
  while (Date.now() < deadline) {
    const targets = await (await fetch(`http://127.0.0.1:${session.port}/json/list`)).json()
    next = targets.find(t => t.type === 'page' && t.id !== oldId && t.webSocketDebuggerUrl)
    if (next) break
    await delay(100)
  }
  assert(next, 'No replacement WebContents appeared')
  session.client.close(); session.client = await CdpClient.connect(next.webSocketDebuggerUrl); session.target = next.id
  await poll(`document.querySelector('.host-status')?.dataset.hostState==='ready'`)
  await poll(`!document.querySelector('[data-custom-desktop]')`)
  assert.equal((await installed()).enabled, false)
}
try {
  await launch(); await showChat()
  const originalConversation = await value(`document.querySelector('.conversation-item')?.textContent`)
  const generation = await value(`document.querySelector('.host-status').dataset.hostGeneration`)
  await draftInstall(pack('0.1.0'))
  await poll(`document.body.innerText.includes('我的插件工作台 0.1.0')`)
  await poll(`window.moreThanChat.getClientPlugins().then(p=>p.some(p=>p.manifest.id===${JSON.stringify(id)}&&p.enabled))`)
  assert.equal(await value('globalThis.__clientLive'), 1)
  await textButton('交互计数：0'); await poll(`document.body.innerText.includes('交互计数：1')`)
  evidence.push('draft UI: one-click install/enable, real Blob ESM root and counter')
  const originalTarget = session.target
  await draftInstall(pack('0.2.0'))
  await poll(`document.body.innerText.includes('我的插件工作台 0.2.0')`)
  await poll(`window.moreThanChat.getClientPlugins().then(p=>p.some(p=>p.manifest.version==='0.2.0'))`)
  assert.equal(session.target, originalTarget)
  assert.equal(await value('globalThis.__clientLive'), 1)
  assert.equal(await value('globalThis.__clientDisposed'), 1)
  evidence.push('hot update: same window, old effects removed, exactly one active contribution')
  await draftInstall(pack('0.3.0', true))
  await poll('globalThis.__clientDisposed >= 3 && globalThis.__clientLive === 1')
  await poll(`document.body.innerText.includes('我的插件工作台 0.2.0')`)
  assert.equal((await installed()).manifest.version, '0.2.0')
  assert.equal(await value('globalThis.__clientLive'), 1)
  evidence.push('failed activation: old running AND on-disk version retained')
  await close(); await launch()
  await poll(`document.body.innerText.includes('我的插件工作台 0.2.0')`)
  evidence.push('process restart: enabled plugin loads without prompts')
  await plugins(); await textButton('停用界面插件')
  await poll(`!document.querySelector('[data-custom-desktop]')`)
  await poll(`window.moreThanChat.getClientPlugins().then(p=>p.every(p=>!p.enabled))`)
  await close(); await launch(); await showChat()
  assert.equal(await value(`Boolean(document.querySelector('[data-custom-desktop]'))`), false)
  assert.equal((await installed()).enabled, false)
  evidence.push('disable persists across process restart')
  await plugins(); await click(`[data-client-plugin="${id}"] .draft-actions button`)
  await poll(`Boolean(document.querySelector('[data-custom-desktop]'))`)
  await textButton('恢复原界面'); await reconnectReplacement()
  assert.equal(await value(`document.querySelector('.conversation-item')?.textContent`), originalConversation)
  assert.equal(await value(`document.querySelector('.host-status').dataset.hostGeneration`), generation)
  evidence.push('plugin recovery API: fresh window, original conversation retained, Host generation unchanged, no white screen')
  await plugins(); await click(`[data-client-plugin="${id}"] .draft-actions button`)
  await poll(`Boolean(document.querySelector('[data-custom-desktop]'))`)
  // DevTools key injection does not exercise Electron's native menu accelerators.
  // A real renderer process crash does exercise the main-process failure handler.
  void limit(session.client.send('Page.crash'), 15000).catch(() => {})
  await reconnectReplacement()
  evidence.push('actual renderer crash: main process reopens default chat and disables the crashing selection')
  const capture = await session.client.send('Page.captureScreenshot', {format: 'png', fromSurface: true})
  await writeFile(path.join(root, '.artifacts/client-plugin-flow.png'), Buffer.from(capture.data, 'base64'))
  passed = true
  console.log(JSON.stringify({passed, packaged: Boolean(process.env.MTC_TEST_PACKAGED_EXE), evidence, profile}, null, 2))
} catch (error) {
  console.error(errors.join('').slice(-12000)); throw error
} finally {
  await writeFile(path.join(root, '.artifacts/client-plugin-acceptance.json'), JSON.stringify({passed, packaged: Boolean(process.env.MTC_TEST_PACKAGED_EXE), evidence, profile}, null, 2))
  await close()
}
