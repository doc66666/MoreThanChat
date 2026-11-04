import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { CdpClient, evaluate, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root = path.resolve(import.meta.dirname, '..'), desktop = path.join(root, 'apps/desktop')
const executable = createRequire(path.join(desktop, 'package.json'))('electron')
const directory = await mkdtemp(path.join(tmpdir(), 'mtc-people-ui-')), sessions = [], errors = []
const server = createCentralServer({ directory: path.join(directory, 'server'), mode: 'public', adminToken: 'qa-people-server-not-production' })
const other = createCentralServer({ directory: path.join(directory, 'other'), mode: 'public', adminToken: 'qa-other-server-not-production' })
const url = 'http://127.0.0.1:' + (await server.listen(0)).port, otherUrl = 'http://127.0.0.1:' + (await other.listen(0)).port
const run = (s, expression) => evaluate(s.client, expression)
async function poll(s, expression, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { if (await run(s, expression)) return; await delay(70) } throw Error('People UI timeout: ' + expression) }
async function launch(name) {
  const port = await reservePort(), profile = path.join(directory, name)
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '.'], { cwd: desktop, env: { ...process.env, MTC_QA_MODE: '1', MTC_QA_USER_DATA_DIR: profile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const s = { child, logs: '' }; sessions.push(s); child.stdout.resume(); child.stderr.on('data', chunk => s.logs = (s.logs + chunk).slice(-8000))
  s.client = await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  s.client.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text)); await s.client.send('Runtime.enable')
  await s.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false })
  await poll(s, `document.querySelector('.host-status')?.dataset.hostState==='ready'&&Boolean(document.querySelector('.composer textarea'))`)
  return s
}
async function close(s) {
  if (!s || s.child.exitCode !== null) return
  await run(s, 'window.moreThanChat.quitApp()').catch(() => {})
  await waitForExit(s.child, 6000); s.client?.close()
  if (s.child.exitCode === null) { s.child.kill(); throw Error('Client did not exit') }
  assert.equal(s.child.exitCode, 0)
}
async function click(s, selector) {
  await poll(s, `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`)
  await run(s, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`)
  const point = await run(s, `(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),disabled:n.disabled}})()`)
  assert(point.hit && !point.disabled, 'Control is reachable: ' + selector)
  await s.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await s.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
}
async function input(s, selector, text) { await click(s, selector); await s.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await s.client.send('Input.insertText', { text }) }
const state = s => run(s, 'window.moreThanChat.getServerState()')
async function capture(s, name) { await delay(200); await mkdir(path.join(root, '.artifacts'), { recursive: true }); const result = await s.client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(root, '.artifacts', `people-${name}.png`), Buffer.from(result.data, 'base64')) }
const action = (s, route, data) => run(s, `window.moreThanChat.serverAction(${JSON.stringify(route)},${JSON.stringify(data)})`)
let result
try {
  let a = await launch('a'); const b = await launch('b'), c = await launch('c')
  for (const [s, name] of [[a,'林予'],[b,'陈晓'],[c,'阿澄']]) await run(s, `window.moreThanChat.connectServer(${JSON.stringify(url)},${JSON.stringify(name)})`)
  const aid = (await state(a)).userId, bid = (await state(b)).userId, cid = (await state(c)).userId, sid = (await state(a)).serverId
  for (const [s, id] of [[b,bid],[c,cid]]) { await action(a, 'friends/request', { userId: id }); await action(s, 'friends/accept', { userId: aid }) }
  await action(a, 'groups', { name: '周末创作小组', memberIds: [bid,cid] })
  await poll(b, `window.moreThanChat.getServerState().then(s=>s.directory?.groups.length===1)`)
  const groupId = (await state(a)).directory.groups[0].id
  await click(a, '.profile-avatar'); await click(a, '[data-edit-profile]')
  await input(a, '[data-profile-name]', '林予 · 创作中'); await input(a, '[data-profile-bio]', '喜欢摄影、桌游，也喜欢把聊天里的想法做成小工具。')
  await click(a, '[data-profile-color="3"]'); await click(a, '[data-save-profile]')
  await poll(a, `document.querySelector('.user-profile .network-notice')?.textContent.includes('已保存')`)
  await poll(b, `window.moreThanChat.getServerState().then(s=>s.directory?.friends.find(f=>f.id===${JSON.stringify(aid)})?.avatarColor===3)`)
  await capture(a, 'self-light')
  await click(a, '[aria-label="关闭个人主页"]')
  await click(b, 'button[title="联系人"]'); await input(b, '[aria-label="搜索好友或群聊"]', '创作中')
  await poll(b, 'document.querySelectorAll("[data-contact-user]").length===1')
  await click(b, `[data-contact-profile="${aid}"]`)
  assert((await run(b, 'document.querySelector(".profile-bio").textContent')).includes('摄影'))
  assert.equal(await run(b, 'document.querySelector(".profile-large").dataset.avatarTone'), '3')
  await click(b, '[data-profile-copy]'); await poll(b, `document.querySelector('.user-profile .network-notice')?.textContent.includes('已复制')`)
  await capture(b, 'friend-light')
  const conversation = (await run(a, 'window.moreThanChat.loadState()')).conversations.find(item => item.targetId === bid).id
  await run(a, `window.moreThanChat.sendCentralMessage(${JSON.stringify({ conversationId: conversation, clientMessageId: 'profile-covered', text: '主页打开时，这条消息应保持未读。' })})`)
  await poll(b, `window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.targetId===${JSON.stringify(aid)})?.unread===1)`)
  await click(b, `[data-profile-group="${groupId}"]`)
  await click(b, 'button[title="会话详情"]'); await click(b, '[data-group-management] summary')
  await click(b, `[data-member-profile="${cid}"]`); await click(b, '[data-profile-add]')
  await poll(b, 'Boolean(document.querySelector("[data-profile-cancel]"))')
  await click(c, 'button[title="联系人"]'); await click(c, '[data-contacts-tab="requests"]')
  await click(c, `[data-contact-accept="${bid}"]`)
  await poll(b, 'Boolean(document.querySelector("[data-profile-chat]"))')
  await click(b, '[data-profile-chat]'); await input(b, '.composer textarea', '从共同群聊认识，很高兴成为好友！'); await click(b, '.send-button')
  await poll(c, `window.moreThanChat.searchChatMessages('很高兴成为好友').then(rows=>rows.length===1)`)
  await click(c, '[aria-label="关闭通讯录"]')
  // Enter the new direct conversation through the independent address book.
  await click(c, 'button[title="联系人"]'); await click(c, `[data-contact-chat="${bid}"]`)
  await click(c, '[data-header-profile]')
  assert.equal(await run(c, 'document.querySelector(".user-profile").dataset.userProfile'), bid)
  await capture(c, 'friend-from-chat')
  await click(c, '[aria-label="关闭个人主页"]'); await click(c, 'button[title="夜间模式"]')
  await click(c, 'button[title="联系人"]'); await capture(c, 'contacts-dark')
  await click(c, `[data-contact-profile="${bid}"]`); await capture(c, 'friend-dark')
  await click(c, '[aria-label="关闭个人主页"]'); await click(c, '[aria-label="关闭通讯录"]')
  // Draft editing can be cancelled with Escape without closing the profile or saving.
  await click(a, '.profile-avatar'); await click(a, '[data-edit-profile]'); await input(a, '[data-profile-bio]', '不应保存的草稿')
  await a.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await poll(a, '!document.querySelector("[data-profile-bio]")&&Boolean(document.querySelector(".user-profile"))')
  assert((await run(a, 'document.querySelector(".profile-bio").textContent')).includes('摄影'))
  await click(a, '[data-edit-profile]'); await a.client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false })
  await capture(a, 'editor-narrow'); await click(a, '[data-save-profile]')
  await poll(a, 'Boolean(document.querySelector("[data-edit-profile]"))')
  // A page/action scoped to the previous server cannot affect another server.
  await click(b, '[data-header-profile]'); await run(b, `window.moreThanChat.connectServer(${JSON.stringify(otherUrl)},'另一个空间')`)
  await poll(b, '!document.querySelector(".user-profile")')
  const blocked = await run(b, `window.moreThanChat.serverAction('friends/request',{userId:${JSON.stringify(aid)}},${JSON.stringify(sid)}).then(()=>false,()=>true)`)
  assert(blocked)
  assert.equal((await state(b)).directory.friends.length, 0)
  await close(a); a = await launch('a')
  await poll(a, `window.moreThanChat.getServerState().then(s=>s.status==='connected')`)
  await click(a, '.profile-avatar')
  assert((await run(a, 'document.querySelector(".profile-bio").textContent')).includes('摄影'))
  assert.equal(await run(a, 'document.querySelector(".profile-large").dataset.avatarTone'), '3')
  assert.deepEqual(errors, [])
  result = { passed: true, profile: directory, checks: ['self profile editing + two-client propagation', 'address-book search + profile + ID copy', 'profile covers messages without reading', 'common group navigation', 'group member to friend application + acceptance', 'new friend direct messaging', 'chat avatar opens correct user', 'light/dark + narrow profile layout', 'Escape cancels unsaved edit', 'server switch rejects stale actions', 'restart restores profile'] }
} catch (error) { for (const s of sessions) if (s.child.exitCode === null) await capture(s, 'failure-' + sessions.indexOf(s)).catch(() => {}); throw error }
finally { await Promise.all(sessions.map(close)); await server.close(); await other.close() }
console.log(JSON.stringify(result, null, 2))
