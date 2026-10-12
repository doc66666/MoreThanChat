import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import {
  CdpClient,
  evaluate,
  waitForTarget,
  reservePort,
  waitForExit,
  delay,
} from './verify-plugin-ui.mjs'
const root = path.resolve(import.meta.dirname, '..'),
  desktop = path.join(root, 'apps', 'desktop'),
  require = createRequire(path.join(desktop, 'package.json')),
  executable = process.env.MTC_TEST_PACKAGED_EXE || require('electron'),
  packaged = Boolean(process.env.MTC_TEST_PACKAGED_EXE)
const data = await mkdtemp(path.join(tmpdir(), 'mtc-central-ui-')),
  profiles = { a: path.join(data, 'a'), b: path.join(data, 'b') }
const relay = createCentralServer({
    directory: path.join(data, 'server'),
    mode: 'public',
    adminToken: 'qa-only-central-admin-token-0001',
  }),
  address = await relay.listen(0),
  url = 'http://127.0.0.1:' + address.port
let a, b
async function launch(profile) {
  const port = await reservePort(),
    child = spawn(
      executable,
      [
        `--remote-debugging-port=${port}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '.',
      ],
      {
        cwd: desktop,
        env: {
          ...process.env,
          MTC_QA_MODE: '1',
          MTC_QA_USER_DATA_DIR: profile,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  child.stdout.resume()
  child.stderr.resume()
  const client = await CdpClient.connect(
    (await waitForTarget(port)).webSocketDebuggerUrl,
  )
  const session = { child, client }
  await poll(
    session,
    `document.querySelector('.host-status')?.dataset.hostState==='ready'&&Boolean(document.querySelector('.composer textarea'))`,
  )
  return session
}
async function poll(session, expression, ms = 15000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await evaluate(session.client, expression)) return
    await delay(80)
  }
  throw new Error('Central UI timeout: ' + expression)
}
async function click(session, selector) {
  await poll(
    session,
    `Boolean(document.querySelector(${JSON.stringify(selector)}))&&document.querySelector(${JSON.stringify(selector)}).checkVisibility()&&!document.querySelector(${JSON.stringify(selector)}).disabled`,
  )
  await evaluate(
    session.client,
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  )
}
async function input(session, selector, value) {
  await evaluate(
    session.client,
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});const prototype=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  )
}
async function state(session) {
  return evaluate(session.client, 'window.moreThanChat.getServerState()')
}
async function connect(session, name) {
  await click(session, 'button[title="联系人"]')
  await poll(session, 'Boolean(document.querySelector(".network-drawer"))')
  await input(session, '[data-server-field="address"]', url)
  await input(session, '[data-server-field="name"]', name)
  await click(session, '[data-connect-server]')
  await poll(
    session,
    'document.querySelector("[data-server-status]")?.dataset.serverStatus==="connected"',
  )
}
async function close(session) {
  if (!session) return
  try {
    await Promise.race([session.client.send('Browser.close'), delay(500)])
  } catch {}
  await waitForExit(session.child, 4000)
  session.client.close()
  if (session.child.exitCode === null) {
    session.child.kill()
    throw new Error('Client failed to flush on exit')
  }
}
async function send(session, text) {
  await input(session, '.composer textarea', text)
  await click(session, '.send-button')
}
async function openNetwork(session) {
  if (
    !(await evaluate(
      session.client,
      'Boolean(document.querySelector(".network-drawer"))',
    ))
  )
    await click(session, 'button[title="联系人"]')
}
async function openDetails(session) {
  if (!(await evaluate(session.client, 'Boolean(document.querySelector(".details-with-plugins"))')))
    await click(session, 'button[title="会话详情"]')
  await poll(session, 'document.querySelector(".details-with-plugins")?.checkVisibility()')
}
async function approve(pluginId) {
  await openNetwork(a)
  await click(
    a,
    `[data-group-plugin-review="${pluginId}"] [data-approve-group-plugin]`,
  )
  await click(a, '.network-drawer .drawer-header button')
}
async function verifyHumanWorkflow(aid,bid,group) {
  await openNetwork(a)
  await click(a,'[data-disconnect-server]')
  await poll(a,'window.moreThanChat.getServerState().then(s=>s.status==="disconnected")')
  await click(a,'.network-drawer .drawer-header button')
  await send(a,'offline-queued-durable-marker')
  await poll(a,'document.querySelector(".status-queued")?.textContent.includes("offline-queued-durable-marker")')
  await close(a);a=undefined;a=await launch(profiles.a)
  await connect(a,'验收用户 A')
  await click(a,'.network-drawer .drawer-header button')
  await poll(b,'document.body.innerText.includes("offline-queued-durable-marker")')
  assert.equal(await evaluate(b.client,'[...document.querySelectorAll("[data-message-id]")].filter(n=>n.textContent.includes("offline-queued-durable-marker")).length'),1)
  await b.client.send('Page.bringToFront')
  await evaluate(b.client,'window.moreThanChat.focusChatWindow()')
  await poll(b,'window.moreThanChat.getWindowFocus()')
  await poll(a,'window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==="offline-queued-durable-marker"&&m.receipt?.readCount===1))')
  const groupConversation=(await evaluate(b.client,'window.moreThanChat.loadState()')).conversations.find(c=>c.targetId===group.id).id
  const aGroupConversation=(await evaluate(a.client,'window.moreThanChat.loadState()')).conversations.find(c=>c.targetId===group.id).id
  await evaluate(a.client,`Promise.all(Array.from({length:35},(_,index)=>window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(aGroupConversation)},clientMessageId:crypto.randomUUID(),text:'历史阅读测试 '+index+'：'+('这是一段用于测试滚动位置的消息。'.repeat(8))})))`)
  await poll(b,'document.body.innerText.includes("历史阅读测试 34：")')
  await evaluate(b.client,'(()=>{const n=document.querySelector(".message-scroll");n.scrollTop=0;n.dispatchEvent(new Event("scroll"))})()')
  await evaluate(b.client,'window.moreThanChat.setReadingConversation(null)')
  await send(a,'unread-off-bottom-marker')
  await poll(b,`window.moreThanChat.loadState().then(s=>s.messages[${JSON.stringify(groupConversation)}].some(m=>m.text==='unread-off-bottom-marker')&&s.conversations.find(c=>c.id===${JSON.stringify(groupConversation)}).unread>0)`)
  assert((await evaluate(b.client,'document.querySelector(".message-scroll").scrollTop'))<100)
  await click(b,'.jump-latest')
  await poll(a,'window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==="unread-off-bottom-marker"&&m.receipt?.readCount===1))')
  await openDetails(b)
  await click(b,'[data-mute-conversation]')
  await poll(b,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(groupConversation)}).muted)`)
  await click(b,'[data-archive-conversation]')
  await poll(b,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(groupConversation)}).archived)`)
  await click(b,'[data-conversation-id="conversation-assistant"]')
  await send(a,'muted-archive-arrival')
  await poll(b,`window.moreThanChat.loadState().then(s=>{const c=s.conversations.find(c=>c.id===${JSON.stringify(groupConversation)});return c.archived&&c.muted&&c.unread>0})`)
  await click(b,'button[title="归档"]')
  await click(b,`[data-conversation-id="${groupConversation}"]`)
  await click(b,'[data-archive-conversation]')
  await click(b,'button[title="归档"]')
  await input(a,'.composer textarea','group-draft-survives-restart')
  await openNetwork(a);await click(a,`[data-friend="${bid}"]`)
  await input(a,'.composer textarea','friend-draft-survives-switch')
  await openNetwork(a);await click(a,`[data-group="${group.id}"]`)
  await poll(a,'document.querySelector(".composer textarea").value==="group-draft-survives-restart"')
  await close(a);a=undefined;a=await launch(profiles.a)
  await poll(a,'document.querySelector(".composer textarea").value==="group-draft-survives-restart"')
  await input(a,'.composer textarea','')
  await click(b,'button[title="搜索聊天记录"]')
  await input(b,'[data-message-search]','offline-queued-durable-marker')
  await click(b,'.search-result')
  await poll(b,'document.querySelector(".message-highlight")?.textContent.includes("offline-queued-durable-marker")')
  await click(b,'.message-highlight .message-copy')
  await poll(b,'document.querySelector(".toast")?.textContent.includes("已复制")')
  await openDetails(a)
  await click(a,'.group-manager summary')
  await input(a,'[data-rename-group-field]','可靠聊天验收群')
  await click(a,'[data-rename-group]')
  await poll(b,'document.querySelector(".chat-identity h1").textContent==="可靠聊天验收群"')
  for(const [label,session] of [['a',a],['b',b]]) {
    const capture=await session.client.send('Page.captureScreenshot',{format:'png',fromSurface:true})
    await writeFile(path.join(root,'.artifacts',`chat-workflow-${packaged?'packaged-':''}${label}.png`),Buffer.from(capture.data,'base64'))
  }
  await click(a,`[data-transfer-owner="${bid}"]`)
  await click(a,'[data-confirm-group-action]')
  await poll(a,`window.moreThanChat.getServerState().then(s=>s.directory.groups.find(g=>g.id===${JSON.stringify(group.id)}).ownerId===${JSON.stringify(bid)})`)
  await click(a,'[data-leave-group]');await click(a,'[data-confirm-group-action]')
  await poll(a,'window.moreThanChat.getServerState().then(s=>s.directory.groups.length===0)')
  await click(b,'.group-manager summary')
  await click(b,'[data-dissolve-group]');await click(b,'[data-confirm-group-action]')
  await poll(b,'window.moreThanChat.getServerState().then(s=>s.directory.groups.length===0)')
  await openNetwork(b);await click(b,`[data-remove-friend="${aid}"]`);await click(b,'[data-confirm-remove-friend]')
  await poll(a,'window.moreThanChat.getServerState().then(s=>s.directory.friends.length===0)')
  await openNetwork(a);await input(a,'[data-friend-id]',bid);await click(a,'[data-request-friend]')
  await click(b,`[data-reject-friend="${aid}"]`)
  await poll(a,'window.moreThanChat.getServerState().then(s=>s.directory.outgoingRequests.length===0)')
  await click(a,'[data-request-friend]');await click(a,`[data-cancel-friend="${bid}"]`)
  await poll(b,'window.moreThanChat.getServerState().then(s=>s.directory.requests.length===0)')
  await click(a,'[data-request-friend]');await click(b,`[data-accept-friend="${aid}"]`)
}
try {
  a = await launch(profiles.a)
  b = await launch(profiles.b)
  await connect(a, '验收用户 A')
  await connect(b, '验收用户 B')
  const aid = (await state(a)).userId,
    bid = (await state(b)).userId
  assert.notEqual(aid, bid)
  await input(a, '[data-friend-id]', bid)
  await click(a, '[data-request-friend]')
  await click(b, `[data-accept-friend="${aid}"]`)
  await click(a, `[data-friend="${bid}"]`)
  await click(b, `[data-friend="${aid}"]`)
  await send(a, '中心服务器真实消息 A→B')
  await poll(b, 'document.body.innerText.includes("中心服务器真实消息 A→B")')
  await send(b, '中心服务器真实消息 B→A')
  await poll(a, 'document.body.innerText.includes("中心服务器真实消息 B→A")')
  await close(b)
  b = undefined
  await send(a, 'offline-delivery-unique-test')
  const deadline = Date.now() + 10000
  while (
    Date.now() < deadline &&
    !relay.db
      .prepare('SELECT 1 FROM queue WHERE recipient=? AND payload LIKE ?')
      .get(bid, '%offline-delivery-unique-test%')
  )
    await delay(80)
  assert(
    relay.db
      .prepare('SELECT 1 FROM queue WHERE recipient=? AND payload LIKE ?')
      .get(bid, '%offline-delivery-unique-test%'),
  )
  b = await launch(profiles.b)
  await poll(
    b,
    'document.body.innerText.includes("offline-delivery-unique-test")',
  )
  assert.equal((await state(b)).userId, bid)
  const ackDeadline = Date.now() + 5000
  while (
    Date.now() < ackDeadline &&
    relay.db
      .prepare('SELECT 1 FROM queue WHERE recipient=? AND payload LIKE ?')
      .get(bid, '%offline-delivery-unique-test%')
  )
    await delay(80)
  assert.equal(
    relay.db
      .prepare('SELECT 1 FROM queue WHERE recipient=? AND payload LIKE ?')
      .get(bid, '%offline-delivery-unique-test%'),
    undefined,
  )
  await openNetwork(a)
  await input(a, '[data-group-name]', '同步联调群')
  await click(a, '.group-member-option input')
  await click(a, '[data-create-group]')
  await poll(a, 'document.querySelectorAll("[data-group]").length>0')
  const group = (await state(a)).directory.groups[0]
  await click(a, `[data-group="${group.id}"]`)
  await openNetwork(b)
  await click(b, `[data-group="${group.id}"]`)
  await openDetails(a)
  await openDetails(b)
  await click(b, '[data-submit-plugin="chain"]')
  await poll(b, 'document.body.innerText.includes("等待管理员批准")')
  const chain = (await state(b)).directory.plugins.find(
    (plugin) => plugin.pack.kind === 'chain',
  )
  assert.equal(
    await evaluate(
      a.client,
      `Boolean(document.querySelector('[data-group-plugin="${chain.pack.id}"]'))`,
    ),
    false,
  )
  await approve(chain.pack.id)
  await poll(
    b,
    `Boolean(document.querySelector('[data-group-plugin="${chain.pack.id}"]'))`,
  )
  await input(
    b,
    `[data-group-plugin="${chain.pack.id}"] [data-chain-entry]`,
    'B 的接龙内容',
  )
  await click(b, `[data-group-plugin="${chain.pack.id}"] [data-chain-join]`)
  await poll(a, 'document.body.innerText.includes("B 的接龙内容")')
  await input(
    a,
    `[data-group-plugin="${chain.pack.id}"] [data-chain-entry]`,
    'A 的接龙内容',
  )
  await click(a, `[data-group-plugin="${chain.pack.id}"] [data-chain-join]`)
  await poll(b, 'document.body.innerText.includes("A 的接龙内容")')
  await click(
    a,
    `[data-group-plugin="${chain.pack.id}"] [data-disable-group-plugin]`,
  )
  await poll(
    a,
    `Boolean(document.querySelector('[data-group-plugin="${chain.pack.id}"] [data-enable-group-plugin]'))`,
  )
  await click(
    a,
    `[data-group-plugin="${chain.pack.id}"] [data-enable-group-plugin]`,
  )
  await poll(
    a,
    `document.querySelector('[data-group-plugin="${chain.pack.id}"]').innerText.includes('B 的接龙内容')`,
  )
  const channelId = 'gplugin_' + crypto.randomUUID()
  await evaluate(
    b.client,
    `window.moreThanChat.serverAction('plugins/submit',{groupId:${JSON.stringify(group.id)},pack:{id:${JSON.stringify(channelId)},version:1,displayName:'通用同步示例',kind:'channel',slot:'app.sidebar'}})`,
  )
  await approve(channelId)
  await poll(
    b,
    `Boolean(document.querySelector('[data-ui-slot-surface="app.sidebar"] [data-group-plugin="${channelId}"]'))`,
  )
  await evaluate(
    b.client,
    `window.moreThanChat.serverAction('plugins/event',{groupId:${JSON.stringify(group.id)},pluginId:${JSON.stringify(channelId)},channel:'custom',payload:{position:42}})`,
  )
  await poll(
    a,
    `window.moreThanChat.getPluginInbox(${JSON.stringify(group.id)},${JSON.stringify(channelId)}).then(events=>events.some(e=>e.channel==='custom'&&e.payload.position===42))`,
  )
  await click(b, '[data-submit-plugin="tic-tac-toe"]')
  await poll(
    b,
    'window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.pack.kind==="tic-tac-toe"))',
  )
  const game = (await state(b)).directory.plugins.find(
    (plugin) => plugin.pack.kind === 'tic-tac-toe',
  )
  await approve(game.pack.id)
  await click(a, `[data-group-plugin="${game.pack.id}"] [data-game-cell="0"]`)
  await poll(
    b,
    `document.querySelector('[data-group-plugin="${game.pack.id}"] [data-game-cell="0"]')?.textContent==='X'`,
  )
  await click(b, `[data-group-plugin="${game.pack.id}"] [data-game-cell="1"]`)
  await poll(
    a,
    `document.querySelector('[data-group-plugin="${game.pack.id}"] [data-game-cell="1"]')?.textContent==='O'`,
  )
  await click(a, 'button[title="插件"]')
  await poll(a, 'Boolean(document.querySelector("[data-plugin-slot-owner]"))')
  const card = `[...document.querySelectorAll('.plugin-card')].find(n=>n.textContent.includes('工作区卡片'))`
  await evaluate(a.client, `${card}.querySelector('.plugin-toggle').click()`)
  await poll(a, '!document.querySelector("[data-plugin-slot-owner]")')
  await evaluate(a.client, `${card}.querySelector('.plugin-toggle').click()`)
  await poll(a, 'Boolean(document.querySelector("[data-plugin-slot-owner]"))')
  await click(a, '.plugin-drawer .drawer-header button')
  // Exercise the real narrow-window details toggle, not hidden DOM controls.
  await a.client.send('Emulation.setDeviceMetricsOverride', {width:1024,height:768,deviceScaleFactor:1,mobile:false})
  await click(a, '.details-header button')
  await poll(a, '!document.querySelector(".details-with-plugins")')
  await openDetails(a)
  await poll(a, `document.querySelector('[data-group-plugin="${chain.pack.id}"]')?.checkVisibility()`)
  await click(a, '.details-header button')
  // The drawer must not cover the microphone during a real pointer gesture.
  if (await evaluate(b.client, 'innerWidth<=1080&&Boolean(document.querySelector(".details-with-plugins"))'))
    await click(b, '.details-header button')
  const { AttachmentStore } = require(
      path.join(desktop, 'dist-main', 'attachments.js'),
    ),
    files = new AttachmentStore(path.join(profiles.a, 'attachments')),
    ref = await files.put(
      Buffer.from('central attachment payload'),
      'relay-test.txt',
      'text/plain',
    )
  const localConversation = await evaluate(
    a.client,
    'window.moreThanChat.loadState().then(s=>s.activeConversationId)',
  )
  await evaluate(
    a.client,
    `window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(localConversation)},clientMessageId:crypto.randomUUID(),text:'文件联调',attachmentId:${JSON.stringify(ref.id)}})`,
  )
  await poll(
    b,
    `Boolean(document.querySelector('[data-attachment-id="${ref.id}"]'))`,
  )
  assert.equal(
    Buffer.from(
      (
        await evaluate(
          b.client,
          `window.moreThanChat.readAttachment(${JSON.stringify(ref.id)})`,
        )
      ).data,
      'base64',
    ).toString(),
    'central attachment payload',
  )
  const bounds = await evaluate(
    a.client,
    '(()=>{const r=document.querySelector(".voice-button").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()',
  )
  await a.client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...bounds,
    button: 'left',
    clickCount: 1,
  })
  await poll(a, 'Boolean(document.querySelector(".voice-button.recording"))')
  await delay(900)
  await a.client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...bounds,
    button: 'left',
    clickCount: 1,
  })
  await poll(b, 'Boolean(document.querySelector(".message-attachment audio"))')
  await poll(
    b,
    '(()=>{const audio=document.querySelector(".message-attachment audio");return audio&&audio.readyState>=1&&!audio.error})()',
  )
  await mkdir(path.join(root, '.artifacts'), { recursive: true })
  await openDetails(a)
  await openDetails(b)
  for (const [label, session] of [
    ['a', a],
    ['b', b],
  ]) {
    const capture = await session.client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    await writeFile(
      path.join(
        root,
        '.artifacts',
        `central-${packaged ? 'packaged-' : ''}${label}-e2e.png`,
      ),
      Buffer.from(capture.data, 'base64'),
    )
  }
  await verifyHumanWorkflow(aid,bid,group)
  console.log(
    JSON.stringify({
      passed: true,
      packaged,
      friendship: true,
      bidirectionalMessages: true,
      offlineDeliveryAndPurge: true,
      globalIdentityRestored: true,
      groupPluginApproval: true,
      chainSynchronized: true,
      gameSynchronized: true,
      sidebarPluginLifecycle: true,
      reviewedSidebarPlacement: true,
      customNetworkChannel: true,
      localGroupPluginToggle: true,
      narrowWindowPluginAccess: true,
      fileRelay: true,
      holdVoiceRelay: true,
      durableOfflineOutbox:true,deliveryAndReadReceipts:true,unreadReadingPosition:true,archivingAndMute:true,draftPersistence:true,localHistorySearch:true,messageCopy:true,groupAdministration:true,friendRequestManagement:true,
    }),
  )
} catch (e) {
  console.error(String(e.stack ?? e.message))
  await mkdir(path.join(root, '.artifacts'), { recursive: true })
  for (const [label, session] of [['a', a], ['b', b]]) {
    if (!session) continue
    try {
      console.error('Failure client ' + label + ': ' + JSON.stringify(await evaluate(session.client, `window.moreThanChat.getServerState().then(s=>({status:s.status,error:s.error,plugins:s.directory?.plugins,widgets:[...document.querySelectorAll('[data-group-plugin]')].map(n=>({text:n.innerText,entry:n.querySelector('[data-chain-entry]')?.value})),toast:document.querySelector('.toast')?.innerText}))`)))
      const capture = await session.client.send('Page.captureScreenshot', {format:'png',fromSurface:true})
      await writeFile(path.join(root,'.artifacts',`central-${packaged ? 'packaged-' : ''}${label}-failure.png`),Buffer.from(capture.data,'base64'))
    } catch (diagnosticError) { console.error('Failure capture: ' + String(diagnosticError)) }
  }
  console.error('Failure relay plugins: ' + JSON.stringify(relay.db.prepare('SELECT id,status,revision,state FROM plugins').all()))
  process.exitCode = 1
} finally {
  await close(a).catch(() => undefined)
  await close(b).catch(() => undefined)
  await relay.close()
}
