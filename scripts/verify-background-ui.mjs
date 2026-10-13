import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { CdpClient, evaluate, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps','desktop'),require=createRequire(path.join(desktop,'package.json'))
const executable=process.env.MTC_TEST_PACKAGED_EXE||require('electron'),packaged=Boolean(process.env.MTC_TEST_PACKAGED_EXE)
const data=await mkdtemp(path.join(tmpdir(),'mtc-background-ui-')),sessions=[]
const relay=createCentralServer({directory:path.join(data,'server'),mode:'public',adminToken:'qa-only-background-admin-token-0001'})
const url='http://127.0.0.1:'+(await relay.listen(0)).port
async function poll(client,expression,ms=15000){
  const end=Date.now()+ms
  while(Date.now()<end){if(await evaluate(client,expression))return;await delay(80)}
  throw new Error('Background UI timeout: '+expression)
}
async function launch(name){
  const port=await reservePort(),inspector=await reservePort()
  const child=spawn(executable,[`--remote-debugging-port=${port}`,`--inspect=127.0.0.1:${inspector}`,'.'],{
    cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:path.join(data,name)},windowsHide:true,stdio:['ignore','pipe','pipe']})
  const session={child,logs:''};sessions.push(session)
  child.stdout.resume();child.stderr.on('data',chunk=>{session.logs=(session.logs+chunk.toString()).slice(-12000)})
  session.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  await poll(session.client,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&Boolean(document.querySelector('.composer textarea'))`)
  const target=(await (await fetch(`http://127.0.0.1:${inspector}/json/list`)).json())[0]
  session.main=await CdpClient.connect(target.webSocketDebuggerUrl)
  // Inspector exists only on these temporary test processes, never a production IPC hook.
  // Observe actual Electron Notification instances. Click dispatch below tests the app's
  // native event handler, not physical interaction with the operating-system toast UI.
  await evaluate(session.main,`(()=>{
    globalThis.qaElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');
    globalThis.qaWindow=()=>qaElectron.BrowserWindow.getAllWindows()[0];globalThis.qaNotices=[];
    const proto=qaElectron.Notification.prototype,show=proto.show,close=proto.close;
    proto.show=function(){if(globalThis.qaFailNotifications)throw new Error('Injected native notification failure');const entry={instance:this,title:this.title,body:this.body,silent:this.silent,closed:false,shown:false,failed:false};qaNotices.push(entry);this.on('show',()=>entry.shown=true);this.on('failed',()=>entry.failed=true);return show.call(this)};
    proto.close=function(){for(const n of qaNotices)if(n.instance===this)n.closed=true;return close.call(this)};
  })()`)
  await poll(session.client,'window.moreThanChat.getDesktopSettings().then(s=>s.trayAvailable)')
  return session
}
async function close(session){
  if(!session||session.child.exitCode!==null)return
  // Disconnect Node inspector before exit: Node otherwise waits for its debugger.
  session.main?.close();session.main=null
  await evaluate(session.client,'window.moreThanChat.quitApp()').catch(()=>undefined)
  await waitForExit(session.child,6000);session.client?.close()
  assert.notEqual(session.child.exitCode,null,'Explicit quit must flush and terminate, even when close-to-tray is enabled')
  assert.equal(session.child.exitCode,0)
}
async function send(session,conversationId,text){
  await evaluate(session.client,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(conversationId)},clientMessageId:crypto.randomUUID(),text:${JSON.stringify(text)}})`)
}
async function received(session,text){await poll(session.client,`window.moreThanChat.searchChatMessages(${JSON.stringify(text)}).then(m=>m.length===1)`)}
const notices=session=>evaluate(session.main,'qaNotices.map(({title,body,silent,closed,shown,failed})=>({title,body,silent,closed,shown,failed}))')
let a,b,result
try{
  a=await launch('a');b=await launch('b')
  const initial=await evaluate(b.client,'window.moreThanChat.getDesktopSettings()')
  assert.deepEqual(initial.preferences,{notifications:true,preview:false,sound:false,closeToTray:false})
  assert.equal(initial.notificationsSupported,true)
  const aid=(await evaluate(a.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'后台验收 A')`)).userId
  const bid=(await evaluate(b.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'后台验收 B')`)).userId
  await evaluate(a.client,`window.moreThanChat.serverAction('friends/request',{userId:${JSON.stringify(bid)}})`)
  await evaluate(b.client,`window.moreThanChat.serverAction('friends/accept',{userId:${JSON.stringify(aid)}})`)
  for(const [session,target] of [[a,bid],[b,aid]])await poll(session.client,`window.moreThanChat.loadState().then(s=>s.conversations.some(c=>c.targetId===${JSON.stringify(target)}))`)
  const conversation=async(session,target)=>(await evaluate(session.client,'window.moreThanChat.loadState()')).conversations.find(c=>c.targetId===target).id
  const ac=await conversation(a,bid),bc=await conversation(b,aid)
  // Use the real settings controls, then close the native window (not Browser.close).
  await evaluate(b.client,`[...document.querySelectorAll('button')].find(b=>b.title==='设置').click()`)
  await poll(b.client,'Boolean(document.querySelector("[data-desktop-option=closeToTray]"))')
  await evaluate(b.client,'document.querySelector("[data-desktop-option=closeToTray]").click()')
  await poll(b.client,'window.moreThanChat.getDesktopSettings().then(s=>s.preferences.closeToTray)')
  await evaluate(b.main,'qaWindow().close()')
  await poll(b.main,'!qaWindow().isVisible()')
  assert.equal(b.child.exitCode,null)
  await send(a,ac,'background-private-message')
  await received(b,'background-private-message')
  await poll(b.main,'qaNotices.length===1')
  const first=(await notices(b))[0]
  assert.equal(first.title,'MoreThanChat');assert.equal(first.body,'你有 1 条新消息');assert.equal(first.silent,true)
  await poll(a.client,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==='background-private-message'&&m.receipt?.deliveredCount===1))`)
  assert.equal(await evaluate(a.client,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().find(m=>m.text==='background-private-message').receipt.readCount)`),0)
  assert.equal(await evaluate(b.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(bc)}).unread)`),1)
  assert.equal(await evaluate(b.main,'qaWindow().getTitle()'),'(1 条未读) MoreThanChat')
  assert.equal(relay.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.message.text')='background-private-message'").get().n,0)
  // The notification opens its conversation, closes the drawer, and only then reads it.
  await evaluate(b.main,'qaNotices[0].instance.emit("click")')
  await poll(b.main,'qaWindow().isVisible()&&qaWindow().isFocused()')
  await poll(b.client,`document.querySelector('.conversation-item.active')?.dataset.conversationId===${JSON.stringify(bc)}&&!document.querySelector('.desktop-settings')`)
  await poll(a.client,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==='background-private-message'&&m.receipt?.readCount===1))`)
  assert.equal((await notices(b))[0].closed,true)
  // Muting does not lose delivery, but must not create another notification or badge.
  await evaluate(b.client,`window.moreThanChat.setConversationOptions(${JSON.stringify(bc)},{muted:true})`)
  await evaluate(b.client,'window.moreThanChat.hideToTray()');await poll(b.main,'!qaWindow().isVisible()')
  await send(a,ac,'background-muted-message');await received(b,'background-muted-message');await delay(1200)
  assert.equal((await notices(b)).length,1);assert.equal(await evaluate(b.main,'qaWindow().getTitle()'),'MoreThanChat')
  await evaluate(b.client,`window.moreThanChat.setConversationOptions(${JSON.stringify(bc)},{muted:false})`)
  await delay(800);assert.equal((await notices(b)).length,1,'Unmuting must not replay old messages')
  // Visible previews must be closed after a remote withdrawal.
  await evaluate(b.client,'window.moreThanChat.configureDesktop({preview:true})')
  await send(a,ac,'background-withdraw-preview');await received(b,'background-withdraw-preview')
  await poll(b.main,'qaNotices.length===2');assert((await notices(b))[1].body.includes('background-withdraw-preview'))
  const message=await evaluate(a.client,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().find(m=>m.text==='background-withdraw-preview'))`)
  await evaluate(a.client,`window.moreThanChat.retractChatMessage(${JSON.stringify(message.id)})`)
  await poll(b.main,'qaNotices[1].closed')
  const before=await evaluate(b.client,'window.moreThanChat.loadState().then(s=>s.activeConversationId)')
  await evaluate(b.main,'qaNotices[1].instance.emit("click")')
  assert.equal(await evaluate(b.main,'qaWindow().isVisible()'),false,'Closed/withdrawn notification cannot reopen a hidden window')
  assert.equal(await evaluate(b.client,'window.moreThanChat.loadState().then(s=>s.activeConversationId)'),before)
  // UI screenshots cover both palettes with these new controls.
  await evaluate(b.client,'window.moreThanChat.focusChatWindow()')
  await evaluate(b.client,`[...document.querySelectorAll('button')].find(b=>b.title==='设置').click()`)
  await poll(b.client,'Boolean(document.querySelector(".desktop-settings"))')
  await mkdir(path.join(root,'.artifacts'),{recursive:true})
  for(const theme of ['light','dark']){
    await evaluate(b.client,`document.querySelector('[data-theme-choice="${theme}"]').click();document.querySelector('.desktop-settings').scrollIntoView({block:'start'})`)
    await poll(b.client,`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
    await delay(250)
    const capture=await b.client.send('Page.captureScreenshot',{format:'png',fromSurface:true})
    await writeFile(path.join(root,'.artifacts',`desktop-background-${theme}${packaged?'-packaged':''}.png`),Buffer.from(capture.data,'base64'))
  }
  const native=await notices(b)
  await evaluate(b.client,'window.moreThanChat.hideToTray()');await poll(b.main,'!qaWindow().isVisible()')
  const second=spawn(executable,['.'],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:path.join(data,'b')},windowsHide:true,stdio:'ignore'})
  sessions.push({child:second})
  await waitForExit(second,5000);assert.equal(second.exitCode,0)
  await poll(b.main,'qaWindow().isVisible()')
  assert.equal(await evaluate(b.main,'qaElectron.BrowserWindow.getAllWindows().length'),1,'Second launch reopens the original window')
  await evaluate(b.client,'window.moreThanChat.hideToTray()');await poll(b.main,'!qaWindow().isVisible()')
  await evaluate(b.main,'globalThis.qaFailNotifications=true')
  await send(a,ac,'background-notification-failure');await received(b,'background-notification-failure')
  await poll(b.client,'window.moreThanChat.getDesktopSettings().then(s=>s.error?.includes("系统通知暂不可用"))')
  await poll(a.client,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==='background-notification-failure'&&m.receipt?.deliveredCount===1&&m.receipt?.readCount===0))`)
  assert.equal(relay.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.message.text')='background-notification-failure'").get().n,0)
  await close(b)
  assert.equal(JSON.parse(await readFile(path.join(data,'b','desktop-preferences.json'),'utf8')).closeToTray,true)
  b=await launch('b');await poll(b.client,'window.moreThanChat.getServerState().then(s=>s.status==="connected")')
  assert.equal((await evaluate(b.client,'window.moreThanChat.getDesktopSettings()')).preferences.preview,true)
  assert.equal((await evaluate(b.client,`window.moreThanChat.searchChatMessages('background-muted-message')`)).length,1)
  await delay(1200);assert.equal((await notices(b)).length,0,'Restart must not re-notify persisted unread history')
  // A save failure must leave a reachable window, not hide it or force exit.
  await evaluate(b.client,'window.moreThanChat.disconnectServer()')
  await evaluate(b.main,`(()=>{
    const load=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    globalThis.qaStorePrototype=load(qaElectron.app.getAppPath()+'/dist-main/chat-store.js').ChatStore.prototype;
    globalThis.qaOriginalSave=qaStorePrototype.save;globalThis.qaSaveErrors=[];
    globalThis.qaOriginalErrorBox=qaElectron.dialog.showErrorBox;
    qaStorePrototype.save=function(){throw new Error('Injected storage failure')};
    qaElectron.dialog.showErrorBox=(title,body)=>{qaSaveErrors.push({title,body})};
    qaWindow().close();
  })()`)
  await poll(b.main,'qaSaveErrors.length===1')
  assert.equal(await evaluate(b.main,'qaWindow().isVisible()'),true)
  assert.equal(b.child.exitCode,null)
  await evaluate(b.main,'qaStorePrototype.save=qaOriginalSave;qaElectron.dialog.showErrorBox=qaOriginalErrorBox;void 0')
  // Disabling close-to-tray restores the old close-and-quit behavior.
  await evaluate(b.client,'window.moreThanChat.configureDesktop({closeToTray:false})')
  await evaluate(b.main,'void setTimeout(()=>qaWindow().close(),250)');b.main.close();b.main=null
  await waitForExit(b.child,6000);assert.equal(b.child.exitCode,0)
  result={packaged,passed:true,profile:data,nativeNotificationsRequested:native.length,nativeShowEvents:native.filter(n=>n.shown).length,nativeFailureEvents:native.filter(n=>n.failed).length,
    clickVerification:'Electron notification click event (not a physical OS toast click)',checks:['settings controls','native close-to-tray','hidden durable delivery + ACK without reading','private silent notification','click navigation + read receipt','mute without data loss','no replay on unmute/restart','withdrawal closes preview','preferences + history restored','second launch restores existing window','native notification failure preserves ACK','storage failure keeps window reachable','explicit quit from tray','default close exits']}
}finally{
  for(const session of sessions){
    try{await close(session)}catch(error){console.error(error.message);session.main?.close();session.client?.close();if(session.child.exitCode===null)session.child.kill()}
    if(!result)console.error(session.logs)
  }
  await relay.close()
}
await writeFile(path.join(root,'.artifacts',`background-acceptance${packaged?'-packaged':''}.json`),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
