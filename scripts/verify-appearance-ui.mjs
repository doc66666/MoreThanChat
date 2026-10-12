import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createSeedState } from '../packages/chat-core/src/index.ts'
import { CdpClient, evaluate, waitForExpression, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root = path.resolve(import.meta.dirname, '..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const executable = process.env.MTC_TEST_PACKAGED_EXE || require('electron')
const profile = await mkdtemp(path.join(tmpdir(), 'mtc-appearance-'))
const output = path.join(root, '.artifacts')
const { ChatStore } = require(path.join(desktop, 'dist-main/chat-store.js'))
const store = await ChatStore.open(profile)
const fixture = createSeedState()
fixture.profile = { id: 'theme-reviewer', displayName: 'Mira', avatar: 'M' }
const conversation = fixture.conversations[0]
const message = (id, role, text) => ({ id, clientMessageId: id, conversationId: conversation.id,
  senderId: role === 'self' ? fixture.profile.id : 'more-ai', senderName: role === 'self' ? 'Mira' : 'More AI',
  senderAvatar: role === 'self' ? 'M' : 'AI', role, type: 'text', text, createdAt: Date.now(), status: 'sent' })
fixture.messages[conversation.id] = [
  message('theme-question', 'self', '我想把聊天空间整理得简单一点，留出专注的余地。'),
  message('theme-answer', 'peer', '可以。让常用的功能触手可及，把更多空间留给对话。\n\n### 今天，从这三件小事开始\n\n- 在侧栏保留正在进行的会话\n- 需要的时候，再打开插件和会话详情\n- 选择适合现在光线的主题\n\n> 清楚的层次、舒服的颜色，比更多装饰更有用。\n\n我们也可以一起写一个小插件，把你的习惯留在这里。'),
  message('theme-followup', 'self', '不错。白天温暖一点，夜晚安静一点。'),
]
for (const [id, title, kind, avatar, preview] of [
  ['design-studio', '设计小组', 'group', '设', '晚一点一起看看新的界面'],
  ['friend-lin', '林予', 'direct', '林', '今天的灵感，先记在这里。'],
]) {
  fixture.conversations.push({ ...conversation, id, title, kind, avatar, pinned: false, unread: 0, updatedAt: Date.now() - 600000 })
  fixture.messages[id] = [{ ...message(id + '-preview', 'peer', preview), conversationId: id }]
}
store.save(fixture)
store.close()
let session
const errors = []
async function launch() {
  const port = await reservePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '.'], {
    cwd: desktop, env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.resume()
  child.stderr.resume()
  const client = await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  client.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text))
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false })
  await waitForExpression(client, 'Boolean(document.querySelector(".composer textarea"))&&document.querySelector(".host-status")?.dataset.hostState==="ready"')
  return { child, client }
}
async function close() {
  const value = session
  session = undefined
  if (!value) return
  try { await Promise.race([value.client.send('Browser.close'), delay(500)]) } catch {}
  await waitForExit(value.child, 4000)
  value.client.close()
  if (value.child.exitCode === null) { value.child.kill(); throw new Error('Client failed to close') }
}
const run = expression => evaluate(session.client, expression)
const poll = expression => waitForExpression(session.client, expression)
async function click(selector) {
  await poll(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`)
  await run(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function capture(name) {
  await delay(240)
  const image = await session.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(path.join(output, `appearance-${name}${process.env.MTC_TEST_PACKAGED_EXE ? '-packaged' : ''}.png`), Buffer.from(image.data, 'base64'))
}
async function contrast(selectors) {
  const result = await run(`(${function (selectors) {
    const rgb = color => color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    const luminance = color => rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    return selectors.map(selector => {
      const node = document.querySelector(selector)
      if (!node) throw new Error('Missing contrast target: ' + selector)
      let surface = node, background
      while (surface) {
        background = getComputedStyle(surface).backgroundColor
        if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break
        surface = surface.parentElement
      }
      const color = getComputedStyle(node).color, a = luminance(color), b = luminance(background)
      return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), color, background }
    })
  }.toString()})(${JSON.stringify(selectors)})`)
  for (const value of result) assert(value.ratio >= 4.5, 'Text contrast: ' + JSON.stringify(value))
  return result.map(({ selector, ratio }) => ({ selector, ratio: Number(ratio.toFixed(2)) }))
}
const contrasts = {}
try {
  await mkdir(output, { recursive: true })
  session = await launch()
  if (!(await run('Boolean(document.querySelector(".details-with-plugins"))'))) await click('button[title="会话详情"]')
  await click('.details-actions button[aria-pressed="true"]')
  await poll(`document.querySelector('.details-actions button[aria-pressed="false"]')?.textContent.includes('置顶会话')`)
  await click('.details-actions button[aria-pressed="false"]')
  await poll(`document.querySelector('.details-actions button[aria-pressed="true"]')?.textContent.includes('取消置顶')`)
  for (const theme of ['light', 'dark']) {
    await click('button[title="设置"]')
    await click(`[data-theme-choice="${theme}"]`)
    await poll(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
    await poll(`document.querySelector('[data-theme-choice="${theme}"]').getAttribute('aria-pressed')==='true'`)
    await delay(200)
    contrasts[theme] = await contrast(['.settings-field span', '.settings-note', '.theme-option[aria-pressed="true"] small', '.primary-button'])
    await capture(theme + '-settings')
    await click('.settings-drawer .drawer-header button')
    contrasts[theme].push(...await contrast(['.message-row:not(.own) .bubble p', '.own .bubble p', '.conversation-preview-row > span', '.composer textarea', '.details-note p']))
    await capture(theme)
    await click('.composer-plus')
    await poll('document.querySelector(".composer-menu")?.checkVisibility()')
    await session.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await poll('!document.querySelector(".composer-menu")')
    await click('.composer-plus')
    await click('[aria-label="插入表情 🙂"]')
    assert.equal(await run('document.querySelector(".composer textarea").value'), '🙂')
    await run(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,isComposing:true}))`)
    assert.equal(await run('document.querySelector(".composer textarea").value'), '🙂')
    await run(`(()=>{const n=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'');n.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  }
  await click('button[title="插件"]')
  await contrast(['.plugin-card p', '.plugin-card small', '.plugin-toggle'])
  await capture('dark-plugins')
  await click('.plugin-drawer .drawer-header button')
  const previousChatWidth = await run('document.querySelector(".chat-panel").getBoundingClientRect().width')
  await click('.details-header button')
  assert(await run(`document.querySelector('.chat-panel').getBoundingClientRect().width>${previousChatWidth}+200`))
  await close()
  session = await launch()
  assert.equal(await run('document.documentElement.dataset.theme'), 'dark')
  assert(await run('document.body.textContent.includes("白天温暖一点，夜晚安静一点")'))
  await click('button[title="设置"]')
  await click('[data-theme-choice="system"]')
  for (const value of ['light', 'dark']) {
    await session.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] })
    await poll(`document.documentElement.dataset.theme===${JSON.stringify(value)}`)
  }
  await click('.settings-drawer .drawer-header button')
  await click('button[title="白天模式"]')
  await poll('document.documentElement.dataset.theme==="light"')
  await session.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  assert.equal(await run('document.documentElement.dataset.theme'), 'light')
  assert(Number.parseFloat(await run('getComputedStyle(document.querySelector(".message-row")).animationDuration')) < .001)
  for (const width of [1024, 900]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width, height: 680, deviceScaleFactor: 1, mobile: false })
    if (!(await run('Boolean(document.querySelector(".details-with-plugins"))'))) await click('button[title="会话详情"]')
    await poll('document.querySelector(".details-with-plugins")?.checkVisibility()')
    await click('.details-header button')
    assert(await run('document.querySelector(".chat-panel").getBoundingClientRect().right<=innerWidth+1'))
    assert(await run('document.querySelector(".rail-bottom").getBoundingClientRect().bottom<=innerHeight'))
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, packaged: Boolean(process.env.MTC_TEST_PACKAGED_EXE), themePersistence: true, followsSystem: true, quickToggle: true, menuInteraction: true, reducedMotion: true, narrowLayout: true, contrasts }))
} catch (error) {
  console.error(error)
  if (session) await capture('failure').catch(() => undefined)
  process.exitCode = 1
} finally { await close() }
