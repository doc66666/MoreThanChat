import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { CdpClient, evaluate, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps','desktop')
const require=createRequire(path.join(desktop,'package.json'))
const executable=process.env.MTC_DESKTOP_EXECUTABLE||process.env.MTC_TEST_PACKAGED_EXE||require('electron')
const packaged=Boolean(process.env.MTC_DESKTOP_EXECUTABLE||process.env.MTC_TEST_PACKAGED_EXE)
// Reuse the OS-encrypted identity fixture: it accepts only isolated a/c profiles.
const data=await mkdtemp(path.join(tmpdir(),'mtc-central-ui-')),sessions=[]
const source=path.join(data,'a'),target=path.join(data,'c'),archive=path.join(data,'chat.mtchistory')
const password='qa-only-history-backup-password',attachmentText='qa-history-attachment-exact-bytes\n'
const attachmentFile=path.join(data,'history-fixture.txt'),downloadFile=path.join(data,'restored-fixture.txt')
const relay=createCentralServer({directory:path.join(data,'server'),mode:'public',adminToken:'qa-only-history-admin-token-000001'})
const url='http://127.0.0.1:'+(await relay.listen(0)).port,traffic={messages:0,reads:0}
relay.server.on('request',request=>{
  if(request.method!=='POST')return
  const pathname=new URL(request.url,url).pathname
  if(pathname.endsWith('/messages'))traffic.messages++
  if(pathname.endsWith('/read'))traffic.reads++
})
await writeFile(attachmentFile,attachmentText,{flag:'wx'})

async function poll(client,expression,ms=20000){
  const deadline=Date.now()+ms
  while(Date.now()<deadline){if(await evaluate(client,expression))return;await delay(80)}
  throw new Error('History UI timeout: '+expression)
}
async function click(session,selector){
  await poll(session.client,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&!n.disabled&&n.checkVisibility()})()`)
  await evaluate(session.client,`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function input(session,selector,value){
  await evaluate(session.client,`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
}
async function launch(profile){
  const port=await reservePort(),inspector=await reservePort()
  const child=spawn(executable,[`--remote-debugging-port=${port}`,`--inspect=127.0.0.1:${inspector}`,'.'],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:profile},windowsHide:true,stdio:['ignore','pipe','pipe']})
  const session={child,profile,logs:''};sessions.push(session)
  child.stdout.resume();child.stderr.on('data',chunk=>{session.logs=(session.logs+chunk.toString()).slice(-10000)})
  session.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  await poll(session.client,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&Boolean(document.querySelector('.composer textarea'))`)
  const targets=await (await fetch(`http://127.0.0.1:${inspector}/json/list`)).json()
  session.main=await CdpClient.connect(targets[0].webSocketDebuggerUrl)
  await evaluate(session.main,`(()=>{
    globalThis.qaLoad=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    globalThis.qaElectron=qaLoad('electron');globalThis.qaWindow=()=>qaElectron.BrowserWindow.getAllWindows()[0];
    if(qaElectron.app.getPath('userData')!==${JSON.stringify(profile)})throw new Error('Not an isolated acceptance profile');
    const profiles=qaLoad(qaElectron.app.getAppPath()+'/dist-main/identity-profiles.js');
    globalThis.qaDirectory=profiles.profilePath(qaElectron.app.getPath('userData'),profiles.activeProfile(qaElectron.app.getPath('userData')));
    globalThis.qaDialogs=[];globalThis.qaOpen=[];globalThis.qaSave=[];globalThis.qaConfirm=[];
    qaElectron.dialog.showOpenDialog=async(_owner,options)=>{qaDialogs.push({type:'open',title:options.title});if(!qaOpen.length)throw new Error('Unexpected QA file picker');return qaOpen.shift()};
    qaElectron.dialog.showSaveDialog=async(_owner,options)=>{qaDialogs.push({type:'save',title:options.title});if(globalThis.qaHoldSave)await new Promise(resolve=>globalThis.qaReleaseSave=resolve);if(!qaSave.length)throw new Error('Unexpected QA save picker');return qaSave.shift()};
    qaElectron.dialog.showMessageBox=async(_owner,options)=>{qaDialogs.push({type:'confirm',message:options.message,detail:options.detail});if(options.message!=='合并这些聊天记录？'||!qaConfirm.length)throw new Error('Unexpected QA confirmation');return {response:qaConfirm.shift(),checkboxChecked:false}};
    globalThis.qaCounts=()=>{const {DatabaseSync}=qaLoad('node:sqlite'),db=new DatabaseSync(qaDirectory+'/chat.sqlite',{readOnly:true});try{return Object.fromEntries(['conversations','messages','central_outbox','read_outbox'].map(table=>[table,Number(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n)]))}finally{db.close()}};
  })()`)
  return session
}
async function close(session){
  if(!session||session.child.exitCode!==null)return
  session.main?.close();session.main=null
  await evaluate(session.client,'window.moreThanChat.quitApp()').catch(()=>undefined)
  await waitForExit(session.child,7000);session.client?.close()
  assert.equal(session.child.exitCode,0,'Explicit quit must persist history and terminate')
}
async function openSettings(session){
  if(!(await evaluate(session.client,'Boolean(document.querySelector(".settings-drawer"))')))await click(session,'button[title="设置"]')
  await poll(session.client,'Boolean(document.querySelector("[data-history-transfer]"))')
  await evaluate(session.client,'document.querySelector("[data-history-transfer]").scrollIntoView({block:"start"})')
  await poll(session.client,'window.moreThanChat.getHistoryTransferStatus().then(s=>!s.busy)')
}
async function mode(session,value,secret=password){
  await openSettings(session)
  await click(session,`[data-history-action="${value}"]`)
  await input(session,'[data-history-password]',secret)
  if(value==='export')await input(session,'[data-history-confirm-password]',secret)
}
async function importArchive(session,{secret=password,confirm=1}={}){
  await evaluate(session.main,`qaOpen.push({canceled:false,filePaths:[${JSON.stringify(archive)}]});qaConfirm.push(${confirm})`)
  await mode(session,'import',secret)
  await click(session,'[data-history-action="confirm"]')
}
async function waitResult(session,phrase){
  await poll(session.client,`document.querySelector('.history-transfer-result')?.textContent.includes(${JSON.stringify(phrase)})`,30000)
  await poll(session.client,'window.moreThanChat.getHistoryTransferStatus().then(s=>!s.busy)')
  assert.equal(await evaluate(session.client,'Boolean(document.querySelector("[data-history-password]"))'),false,'Completed/cancelled transfers clear password controls')
  return evaluate(session.client,'document.querySelector(".history-transfer-result").textContent')
}
async function seedLocalHistory(session,attachment){
  await evaluate(session.main,`(async()=>{
    const {ChatStore}=qaLoad(qaElectron.app.getAppPath()+'/dist-main/chat-store.js'),store=await ChatStore.open(qaDirectory);
    try{
      const state=store.load(),id='history-ai-archive',createdAt=Date.now()-86400000,template=state.messages['conversation-assistant'][0];
      state.conversations.push({...state.conversations[0],id,title:'迁移验收 AI 历史',kind:'assistant',updatedAt:createdAt+84});
      state.messages[id]=Array.from({length:85},(_,i)=>({...template,id:'history-local-'+i,clientMessageId:'history-local-'+i,conversationId:id,text:i===0?'qa-history-before-first-page':('qa-history-local-'+i),createdAt:createdAt+i,...(i===0?{attachment:${JSON.stringify(attachment)}}:{})}));
      store.save(state,undefined,{authoritative:true});qaWindow().webContents.send('central:chat',{...store.loadView(),historyImported:true});
    }finally{store.close()}
  })()`)
  await poll(session.client,`Boolean(document.querySelector('[data-conversation-id="history-ai-archive"]'))`)
}
async function preserveLocalFixture(session){
  await evaluate(session.main,`(async()=>{
    const {ChatStore}=qaLoad(qaElectron.app.getAppPath()+'/dist-main/chat-store.js'),store=await ChatStore.open(qaDirectory);
    try{const state=store.load(),id='target-existing-ai',template=state.messages['conversation-assistant'][0];
      state.conversations.push({...state.conversations[0],id,title:'本机已有对话',kind:'assistant',pinned:true,muted:true});state.messages[id]=[{...template,id:'target-existing-message',clientMessageId:'target-existing-message',conversationId:id,text:'qa-target-existing-keep',createdAt:Date.now()}];
      store.save(state,undefined,{authoritative:true});qaWindow().webContents.send('central:chat',{...store.loadView(),historyImported:true});
    }finally{store.close()}
  })()`)
  await poll(session.client,`Boolean(document.querySelector('[data-conversation-id="target-existing-ai"]'))`)
  await click(session,'[data-conversation-id="target-existing-ai"]')
}
async function screenshot(session,theme){
  await openSettings(session)
  await click(session,`[data-theme-choice="${theme}"]`)
  await evaluate(session.client,'document.querySelector("[data-history-transfer]").scrollIntoView({block:"start"})')
  await delay(250)
  const capture=await session.client.send('Page.captureScreenshot',{format:'png',fromSurface:true})
  await writeFile(path.join(root,'.artifacts',`history-transfer-${theme}${packaged?'-packaged':''}.png`),Buffer.from(capture.data,'base64'))
}

let a,b,c,result
try{
  a=await launch(source);b=await launch(path.join(data,'b'))
  const aid=(await evaluate(a.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'历史源 A')`)).userId
  const bid=(await evaluate(b.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'历史好友 B')`)).userId
  await evaluate(a.client,`window.moreThanChat.serverAction('friends/request',{userId:${JSON.stringify(bid)}})`)
  await evaluate(b.client,`window.moreThanChat.serverAction('friends/accept',{userId:${JSON.stringify(aid)}})`)
  for(const [session,peer] of [[a,bid],[b,aid]])await poll(session.client,`window.moreThanChat.loadState().then(s=>s.conversations.some(c=>c.targetId===${JSON.stringify(peer)}))`)
  const ac=(await evaluate(a.client,'window.moreThanChat.loadState()')).conversations.find(item=>item.targetId===bid).id
  const bc=(await evaluate(b.client,'window.moreThanChat.loadState()')).conversations.find(item=>item.targetId===aid).id
  await evaluate(a.main,`qaOpen.push({canceled:false,filePaths:[${JSON.stringify(attachmentFile)}]})`)
  const attachment=await evaluate(a.client,'window.moreThanChat.chooseAttachment()')
  await evaluate(a.client,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(ac)},clientMessageId:crypto.randomUUID(),text:'qa-history-sent-attachment',attachmentId:${JSON.stringify(attachment.id)}})`)
  await evaluate(b.client,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(bc)},clientMessageId:crypto.randomUUID(),text:'qa-history-received-peer'})`)
  await poll(a.client,`window.moreThanChat.searchChatMessages('qa-history-received-peer').then(m=>m.length===1)`)
  await poll(b.client,`window.moreThanChat.searchChatMessages('qa-history-sent-attachment').then(m=>m.length===1)`)
  await poll(a.client,`window.moreThanChat.loadState().then(s=>s.messages[${JSON.stringify(ac)}].some(m=>m.text==='qa-history-sent-attachment'&&m.receipt?.deliveredCount===1))`)
  await seedLocalHistory(a,attachment)
  await evaluate(a.client,'window.moreThanChat.disconnectServer()')
  await evaluate(a.client,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(ac)},clientMessageId:crypto.randomUUID(),text:'qa-history-queued-do-not-replay'})`)
  assert.equal((await evaluate(a.main,'qaCounts()')).central_outbox,1)

  // Mismatched passwords fail before opening a native dialog or exporting data.
  await mode(a,'export')
  await input(a,'[data-history-confirm-password]',password+'-different')
  await poll(a.client,'document.querySelector("[data-history-transfer] [role=alert]")?.textContent.includes("不一致")')
  assert.equal(await evaluate(a.client,'document.querySelector("[data-history-action=confirm]").disabled'),true)
  assert.equal(await evaluate(a.main,'qaDialogs.filter(d=>d.type==="save").length'),0)
  await input(a,'[data-history-confirm-password]',password)
  await evaluate(a.main,`qaSave.push({canceled:false,filePath:${JSON.stringify(archive)}})`)
  await click(a,'[data-history-action="confirm"]')
  const exported=await waitResult(a,'加密备份已保存')
  const encrypted=await readFile(archive)
  assert(encrypted.length>1000);assert(!encrypted.includes(Buffer.from('qa-history-before-first-page')))
  // Busy state survives settings remounts. Cancelling OS selection changes no data.
  await evaluate(a.main,'globalThis.qaHoldSave=true;qaSave.push({canceled:true})')
  await mode(a,'export');await click(a,'[data-history-action="confirm"]')
  await poll(a.main,'typeof qaReleaseSave==="function"')
  await click(a,'.settings-drawer .drawer-header button')
  await click(a,'button[title="设置"]')
  await poll(a.client,'document.querySelector("[data-history-action=export]")?.disabled&&Boolean(document.querySelector(".history-transfer-progress"))')
  await evaluate(a.main,'globalThis.qaHoldSave=false;qaReleaseSave();delete globalThis.qaReleaseSave')
  await poll(a.client,'!document.querySelector("[data-history-action=export]")?.disabled')
  await close(a)
  for(const action of ['export','import']){
    const helper=spawn(require('electron'),[path.join(desktop,'scripts','verify-identity-fixture.cjs'),source,target,action],{cwd:desktop,windowsHide:true,stdio:['ignore','pipe','pipe']})
    helper.stdout.resume();helper.stderr.resume();await waitForExit(helper,15000)
    assert.equal(helper.exitCode,0,'Real OS-encrypted identity fixture: '+action)
  }
  c=await launch(target)
  assert.equal((await evaluate(c.client,'window.moreThanChat.getServerState()')).userId,aid)
  await preserveLocalFixture(c)
  const initial=await evaluate(c.main,'qaCounts()'),beforeTraffic={...traffic}
  await importArchive(c,{secret:'qa-only-incorrect-password'})
  await poll(c.client,'document.querySelector("[data-history-transfer] [role=alert]")?.textContent.includes("密码")')
  await poll(c.client,'window.moreThanChat.getHistoryTransferStatus().then(s=>!s.busy)')
  assert.deepEqual(await evaluate(c.main,'qaCounts()'),initial)
  assert.equal(await evaluate(c.main,'qaDialogs.filter(d=>d.type==="confirm").length'),0)
  await evaluate(c.main,'qaConfirm.length=0')
  await click(c,'[data-history-action="cancel"]')
  await importArchive(c,{confirm:0});await waitResult(c,'已取消操作')
  assert.deepEqual(await evaluate(c.main,'qaCounts()'),initial)
  await importArchive(c)
  const restored=await waitResult(c,'恢复完成'),after=await evaluate(c.main,'qaCounts()')
  assert(after.messages>=initial.messages+88)
  assert.equal(after.central_outbox,0);assert.equal(after.read_outbox,0)
  assert.deepEqual(traffic,beforeTraffic,'Import cannot replay sends or read receipts')
  assert.equal(await evaluate(c.client,'document.querySelector(".conversation-item.active")?.dataset.conversationId'),'target-existing-ai')
  await poll(c.client,'Boolean(document.querySelector("[data-conversation-id=history-ai-archive]"))')
  const saved=await evaluate(c.client,'window.moreThanChat.loadState()')
  assert.equal(saved.conversations.find(item=>item.id===ac).unavailable,true)
  assert.equal(saved.messages[ac].find(item=>item.text==='qa-history-queued-do-not-replay').status,'failed')
  assert(saved.messages[ac].find(item=>item.text==='qa-history-received-peer').readAt)
  assert.equal(saved.messages['history-ai-archive'].length,50,'Initial projection stays bounded')
  assert(!saved.messages['history-ai-archive'].some(item=>item.id==='history-local-0'))
  assert.equal(saved.messages['target-existing-ai'][0].text,'qa-target-existing-keep')
  assert((await evaluate(c.main,'qaDialogs.filter(d=>d.type==="confirm").at(-1).detail')).includes('现有记录优先'))
  await importArchive(c)
  const duplicate=await waitResult(c,'恢复完成')
  assert(duplicate.includes('新增 0 个历史会话、0 条消息'))
  assert.deepEqual(await evaluate(c.main,'qaCounts()'),after,'Repeated restore is idempotent')
  await mkdir(path.join(root,'.artifacts'),{recursive:true})
  await screenshot(c,'light');await screenshot(c,'dark')
  await click(c,'.settings-drawer .drawer-header button')
  await click(c,'[data-conversation-id="history-ai-archive"]')
  await click(c,'button[title="搜索聊天记录"]')
  await input(c,'[data-message-search]','qa-history-before-first-page')
  await click(c,'[data-search-result="history-local-0"]')
  await poll(c.client,`Boolean(document.querySelector('[data-message-id="history-local-0"] [data-attachment-id="${attachment.id}"]'))`)
  assert.equal(Buffer.from((await evaluate(c.client,`window.moreThanChat.readAttachment(${JSON.stringify(attachment.id)})`)).data,'base64').toString(),attachmentText)
  await evaluate(c.main,`qaSave.push({canceled:false,filePath:${JSON.stringify(downloadFile)}})`)
  await click(c,`[data-message-id="history-local-0"] [data-attachment-id="${attachment.id}"] button`)
  const deadline=Date.now()+5000
  while(true){try{assert.equal(await readFile(downloadFile,'utf8'),attachmentText);break}catch(error){if(Date.now()>deadline)throw error;await delay(80)}}
  // Restore while an old history page is visible: import must invalidate its cursor.
  await importArchive(c);await waitResult(c,'恢复完成')
  await click(c,'.settings-drawer .drawer-header button')
  await poll(c.client,'!document.querySelector("[data-message-id=history-local-0]")')
  assert.equal(await evaluate(c.client,'document.querySelectorAll("[data-message-id]").length'),50)
  await evaluate(c.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'历史源 A')`)
  await poll(c.client,`window.moreThanChat.loadState().then(s=>!s.conversations.find(c=>c.id===${JSON.stringify(ac)}).unavailable)`)
  await click(c,`[data-conversation-id="${ac}"]`)
  await evaluate(c.client,'window.moreThanChat.focusChatWindow()')
  await delay(1500)
  assert.deepEqual(traffic,beforeTraffic,'Reconnect/opening imported history must not replay sends or read receipts')
  assert.equal((await evaluate(c.main,'qaCounts()')).central_outbox,0)
  await close(c);c=await launch(target)
  await poll(c.client,'window.moreThanChat.getServerState().then(s=>s.status==="connected")')
  assert.equal((await evaluate(c.client,'window.moreThanChat.getServerState()')).userId,aid)
  assert.deepEqual(await evaluate(c.main,'qaCounts()'),after)
  assert.equal((await evaluate(c.client,'window.moreThanChat.searchChatMessages("qa-history-before-first-page")')).length,1)
  assert.equal(Buffer.from((await evaluate(c.client,`window.moreThanChat.readAttachment(${JSON.stringify(attachment.id)})`)).data,'base64').toString(),attachmentText)
  assert.deepEqual(traffic,beforeTraffic,'Restart must not replay imported work')
  result={packaged,passed:true,profile:data,archiveBytes:encrypted.length,sourceSummary:exported,restoredSummary:restored,duplicateSummary:duplicate,stored:after,
    nativeDialogs:'OS dialog selection/confirmation substituted only through the temporary process Main inspector',
    checks:['local password mismatch prevents export','encrypted full-history UI export','busy state across settings remount','same UID via real OS-encrypted identity transfer','wrong password and cancelled merge leave data intact','native merge confirmation counts','new local/AI conversation projects immediately','existing local data and selected chat retained','imported relationships read-only until server confirms','no outbox/read receipt replay on import/reconnect/restart','duplicate merge idempotent','history outside recent 50 searchable','attachment bytes and native save action','import invalidates historical viewport','restart durability','light/dark settings screenshots']}
}finally{
  for(const session of sessions){
    try{await close(session)}catch(error){console.error(error.message);session.main?.close();session.client?.close();if(session.child.exitCode===null)session.child.kill()}
    if(!result&&session.logs)console.error(session.logs)
  }
  await relay.close()
}
await writeFile(path.join(root,'.artifacts',`history-acceptance${packaged?'-packaged':''}.json`),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
