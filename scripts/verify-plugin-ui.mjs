import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'

const workspaceDir = path.resolve(import.meta.dirname, '..')
const desktopDir = path.join(workspaceDir, 'apps', 'desktop')
const artifactDir = path.join(workspaceDir, '.artifacts')
const verifyHost = process.argv.includes('--host')
const screenshotPath = path.join(artifactDir, verifyHost ? 'host-supervision-e2e.png' : 'plugin-panel-e2e.png')
const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'))
const electronPath = requireFromDesktop('electron')
let stderr = ''

async function run() {
  const port = await reservePort()
  const electron = spawn(electronPath, [`--remote-debugging-port=${port}`, '.'], {
    cwd: desktopDir,
    env: {
      ...process.env,
      MTC_QA_MODE: '1',
      ...(verifyHost ? { MTC_QA_HOST_CRASH_ONCE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  stderr = ''
  electron.stderr.setEncoding('utf8')
  electron.stderr.on('data', chunk => { stderr += chunk })

  let client
  let verificationFailed = false
  try {
    const target = await waitForTarget(port)
    client = await CdpClient.connect(target.webSocketDebuggerUrl)
    if (verifyHost) await verifyHostSupervision(client)
    else await verifyPluginUi(client)

    const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await mkdir(artifactDir, { recursive: true })
    await writeFile(screenshotPath, Buffer.from(capture.data, 'base64'))
    console.log(`${verifyHost ? 'Host supervision' : 'Plugin UI'} verification passed. Screenshot: ${screenshotPath}`)
  }
  catch (error) {
    verificationFailed = true
    throw error
  }
  finally {
    try {
      if (client) await Promise.race([client.send('Browser.close'), delay(500)])
    }
    catch {
      // The browser may already have closed after a failed assertion.
    }
    client?.close()
    await waitForExit(electron, 4_000)
    if (electron.exitCode === null) electron.kill()
    if (stderr && verificationFailed) console.error(stderr)
  }
}

async function verifyPluginUi(client) {
  await waitForExpression(client, `Boolean(document.querySelector('.plugin-composer-action:not(.host-tool-action)'))`)
  await evaluate(client, `document.querySelector('button[title="插件"]')?.click()`)
  await waitForExpression(client, `Boolean([...document.querySelectorAll('.plugin-card')].find(card => card.textContent?.includes('快捷问候')))`)

  const listedPlugins = await evaluate(client, `[...document.querySelectorAll('.plugin-card strong')].map(node => node.textContent)`)
  assert(listedPlugins.includes('本地演示传输'), 'The local transport plugin is missing from the plugin panel.')
  assert(listedPlugins.includes('快捷问候'), 'The quick greeting plugin is missing from the plugin panel.')

  await clickGreetingToggle(client)
  await waitForExpression(client, `!document.querySelector('.plugin-composer-action:not(.host-tool-action)')`)
  const disabledLabel = await greetingToggleLabel(client)
  assert(disabledLabel === '启用', `Expected disabled plugin label, received '${disabledLabel}'.`)

  await clickGreetingToggle(client)
  await waitForExpression(client, `document.querySelectorAll('.plugin-composer-action:not(.host-tool-action)').length === 1`)
  const enabledLabel = await greetingToggleLabel(client)
  assert(enabledLabel === '停用', `Expected enabled plugin label, received '${enabledLabel}'.`)

  await evaluate(client, `document.querySelector('.plugin-composer-action:not(.host-tool-action)')?.click()`)
  await waitForExpression(client, `document.querySelector('.composer textarea')?.value === '你好，插件！ 👋'`)
  const draft = await evaluate(client, `document.querySelector('.composer textarea')?.value`)
  assert(draft === '你好，插件！ 👋', 'The plugin did not write the expected greeting into the composer.')
}

async function verifyHostSupervision(client) {
  await waitForExpression(client, `document.querySelector('.host-status')?.dataset.hostState === 'ready'`)
  const initial = await evaluate(client, `window.moreThanChat.getHostPlugins()`)
  assert(initial.generation === 1, 'Could not control the first Host before the injected crash.')
  assert(initial.plugins.some(plugin => plugin.id === 'builtin.time-tool' && plugin.status === 'active'), 'Host time plugin did not start.')
  await evaluate(client, `window.moreThanChat.setHostPluginEnabled('builtin.time-tool', false)`)
  try {
    await waitForExpression(client, `(() => {
      const node = document.querySelector('.host-status')
      return node?.dataset.hostState === 'ready' && Number(node?.dataset.hostGeneration) >= 2
    })()`)
  }
  catch (error) {
    const debugState = await evaluate(client, `(() => {
      const node = document.querySelector('.host-status')
      return { state: node?.dataset.hostState, generation: node?.dataset.hostGeneration, text: node?.textContent, title: node?.title, body: document.body.innerText, html: document.querySelector('#root')?.innerHTML, url: location.href, readyState: document.readyState }
    })()`)
    throw new Error(`${error.message}\nHost UI state: ${JSON.stringify(debugState)}`)
  }
  const state = await evaluate(client, `(() => {
    const node = document.querySelector('.host-status')
    return { state: node?.dataset.hostState, generation: Number(node?.dataset.hostGeneration), text: node?.textContent }
  })()`)
  assert(state.state === 'ready', `Expected a ready host, received '${state.state}'.`)
  assert(state.generation >= 2, `Expected the crashed host to restart, received generation ${state.generation}.`)
  const recovered = await evaluate(client, `window.moreThanChat.getHostPlugins()`)
  assert(recovered.plugins.find(plugin => plugin.id === 'builtin.time-tool')?.status === 'inactive', 'Host restart lost the disabled plugin preference.')
  const disabledToolRejected = await evaluate(client, `window.moreThanChat.invokeHostTool('builtin.time-tool', 'current-time').then(() => false, () => true)`)
  assert(disabledToolRejected, 'A disabled Host plugin tool was callable.')

  await evaluate(client, `document.querySelector('button[title="插件"]')?.click()`)
  await waitForExpression(client, `document.querySelector('.host-plugin-card .plugin-toggle')?.textContent?.trim() === '启用'`)
  await evaluate(client, `document.querySelector('.host-plugin-card .plugin-toggle')?.click()`)
  await waitForExpression(client, `document.querySelectorAll('.host-tool-action').length === 1`)
  await evaluate(client, `document.querySelector('.host-tool-action')?.click()`)
  await waitForExpression(client, `document.querySelector('.composer textarea')?.value?.includes('当前时间：')`)
  await evaluate(client, `document.querySelector('.host-plugin-card .plugin-toggle')?.click()`)
  await waitForExpression(client, `document.querySelectorAll('.host-tool-action').length === 0`)
  await evaluate(client, `document.querySelector('.host-plugin-card .plugin-toggle')?.click()`)
  await waitForExpression(client, `document.querySelectorAll('.host-tool-action').length === 1`)

  const sandbox = await evaluate(client, `({ requireType: typeof window.require, processType: typeof window.process })`)
  assert(sandbox.requireType === 'undefined', 'Renderer unexpectedly exposes window.require.')
  assert(sandbox.processType === 'undefined', 'Renderer unexpectedly exposes window.process.')

  await evaluate(client, `document.querySelector('.host-status')?.click()`)
  await waitForExpression(client, `document.querySelector('.toast')?.textContent?.includes('响应正常')`)
}

async function clickGreetingToggle(client) {
  const clicked = await evaluate(client, `(() => {
    const card = [...document.querySelectorAll('.plugin-card')].find(node => node.textContent?.includes('快捷问候'))
    const button = card?.querySelector('.plugin-toggle')
    button?.click()
    return Boolean(button)
  })()`)
  assert(clicked, 'Could not find the quick greeting plugin toggle.')
}

function greetingToggleLabel(client) {
  return evaluate(client, `(() => {
    const card = [...document.querySelectorAll('.plugin-card')].find(node => node.textContent?.includes('快捷问候'))
    return card?.querySelector('.plugin-toggle')?.textContent?.trim()
  })()`)
}

async function waitForTarget(port) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const target = targets.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
      if (target) return target
    }
    catch {
      // Electron has not opened its debugging endpoint yet.
    }
    await delay(80)
  }
  throw new Error(`Electron debugging target did not appear on port ${port}.${stderr ? `\n${stderr}` : ''}`)
}

async function waitForExpression(client, expression) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

class CdpClient {
  #socket
  #sequence = 0
  #pending = new Map()
  #events = new Map()

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to Electron CDP.')), 5_000)
      socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('Failed to connect to Electron CDP.'))
      }, { once: true })
    })
    return new CdpClient(socket)
  }

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (!message.id) {
        for (const listener of this.#events.get(message.method) ?? []) listener(message.params)
        return
      }
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    const listeners = this.#events.get(method) ?? new Set()
    listeners.add(listener)
    this.#events.set(method, listeners)
    return () => listeners.delete(listener)
  }

  close() {
    this.#socket.close()
  }
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a debugging port.'))
        return
      }
      const port = address.port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

await run()
