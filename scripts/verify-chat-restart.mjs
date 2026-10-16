import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { CdpClient, evaluate as cdpEvaluate, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'
import { durableGroupReplyCode } from './fixtures/durable-group-reply.mjs'

const desktop=path.resolve(import.meta.dirname,'../apps/desktop'),executable=createRequire(path.join(desktop,'package.json'))('electron')
const directory=await mkdtemp(path.join(tmpdir(),'mtc-chat-restart-')),sessions=[]
const relay=createCentralServer({directory:path.join(directory,'relay'),mode:'public',adminToken:'qa-only-restart-admin-token-0001'})
const sendAttempts=new Map()
relay.server.on('request',request=>{
 if(request.url!=='/v1/messages')return
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  try{const id=JSON.parse(Buffer.concat(chunks).toString()).clientMessageId;sendAttempts.set(id,(sendAttempts.get(id)||0)+1)}catch{}
 })
})
const url='http://127.0.0.1:'+(await relay.listen(0)).port
async function evaluate(client,expression){let timer;try{return await Promise.race([cdpEvaluate(client,expression),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CDP deadline: '+expression.slice(0,100))),15000)})])}finally{clearTimeout(timer)}}
async function poll(s,expression,ms=25000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(s.client,expression))return;await delay(60)}throw Error('Restart UI timeout: '+expression+'\n'+s.logs)}
async function click(s,selector){await poll(s,`Boolean(document.querySelector(${JSON.stringify(selector)}))&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await evaluate(s.client,`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function input(s,selector,value){await evaluate(s.client,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('change',{bubbles:true}))})()`)}
const action=(s,route,data)=>evaluate(s.client,`window.moreThanChat.serverAction(${JSON.stringify(route)},${JSON.stringify(data)})`)
const state=s=>evaluate(s.client,'window.moreThanChat.getServerState()')
const read=(s,request)=>evaluate(s.client,`window.moreThanChat.accessChat(${JSON.stringify(request)}).then(r=>JSON.parse(r.dataJson))`)
const closePanel=s=>evaluate(s.client,`document.querySelector('.plugin-drawer .drawer-header button')?.click()`)
async function launch(name,restart=false){
 const port=await reservePort(),inspector=await reservePort(),profile=path.join(directory,name)
 const child=spawn(executable,[`--remote-debugging-port=${port}`,`--inspect=127.0.0.1:${inspector}`,'.'],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:profile},windowsHide:true,stdio:['ignore','pipe','pipe']})
 const s={child,logs:''};sessions.push(s);child.stdout.resume();child.stderr.on('data',chunk=>s.logs=(s.logs+chunk).slice(-12000))
 s.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
 await poll(s,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&Boolean(document.querySelector('.composer textarea'))`)
 s.main=await CdpClient.connect((await(await fetch(`http://127.0.0.1:${inspector}/json/list`)).json())[0].webSocketDebuggerUrl)
 await evaluate(s.main,`(()=>{globalThis.qaElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');if(qaElectron.app.getPath('userData')!==${JSON.stringify(profile)})throw Error('Not a test profile')})()`)
 if(restart)await poll(s,`window.moreThanChat.getServerState().then(s=>s.status==='connected')`)
 else await evaluate(s.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},${JSON.stringify(name)})`)
 s.id=(await state(s)).userId
 return s
}
async function close(s){
 if(s.child.exitCode!==null)return
 s.main?.close();s.main=null
 // Do not await a return value from a renderer that is about to be destroyed.
 const quit=evaluate(s.client,'window.moreThanChat.quitApp()').catch(()=>{})
 await waitForExit(s.child,8000);s.client?.close();await quit
 if(s.child.exitCode===null){s.child.kill();throw Error('Test app did not exit')}
 assert.equal(s.child.exitCode,0)
}
async function history(s,conversationId){const all=[];let after=-1;for(;;){const page=await read(s,{action:'history',conversationId,after,limit:100});all.push(...page.messages);if(!page.hasNewer)return all;after=page.after}}
let result
try{
 const a=await launch('A'),c=await launch('C');let b=await launch('B')
 for(const peer of [b,c]){await action(a,'friends/request',{userId:peer.id});await action(peer,'friends/accept',{userId:a.id})}
 const group=(await action(a,'groups',{name:'重启热更新验收',memberIds:[b.id,c.id]})).directory.groups.find(g=>g.name==='重启热更新验收').id
 const conversationId=relay.serverId+':'+group,selector=`[data-conversation-id="${conversationId}"]`
 for(const s of [a,b,c])await poll(s,`window.moreThanChat.loadState().then(s=>s.conversations.some(c=>c.id===${JSON.stringify(conversationId)}))`)
 const send=async(text,from=a)=>read(from,{action:'send',conversationId,clientMessageId:crypto.randomUUID(),text})
 const count=async(s,text,n=1)=>poll(s,`window.moreThanChat.searchChatMessages(${JSON.stringify(text)},${JSON.stringify(conversationId)}).then(m=>m.filter(x=>x.text===${JSON.stringify(text)}).length===${n})`)
 const pluginId='example.qa-durable-reply';let proposal
 async function share(version){
  const manifest={manifestVersion:1,id:pluginId,version:version+'.0.0',displayName:'重启续发验收',description:'插件自行持久化检查点和回复计划',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted']}
  const draft=await evaluate(b.client,`window.moreThanChat.createPluginDraft(${JSON.stringify({manifestJson:JSON.stringify(manifest),source:JSON.stringify({kind:'executable-client',code:durableGroupReplyCode({senderId:a.id,version})})})})`)
  assert(draft.ok,JSON.stringify(draft))
  await click(b,'button[title="插件"]');const parent=`[data-draft-id="${pluginId}"]`
  await poll(b,`Boolean(document.querySelector(${JSON.stringify(parent+' [data-share-client]')}))`)
  await evaluate(b.client,`document.querySelector(${JSON.stringify(parent+' [data-share-client]')}).open=true`)
  await input(b,parent+' [data-share-target]',group);await click(b,parent+' [data-share-submit]');await closePanel(b)
  await poll(a,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.groupId===${JSON.stringify(group)}&&p.pack.version===${version}&&p.status==='pending'))`)
  proposal=(await state(a)).directory.plugins.find(p=>p.groupId===group&&p.pack.version===version)
  await click(a,'button[title="联系人"]');await click(a,`[data-group-plugin-review="${proposal.pack.id}"] [data-approve-group-plugin]`);await closePanel(a)
  await poll(b,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.digest===${JSON.stringify(proposal.digest)}&&p.status==='approved'))`)
 }
 async function enable(version){
  await click(b,selector);await click(b,'button[title="插件"]')
  await click(b,`[data-group-plugin-gate="${proposal.pack.id}"][data-plugin-scope="${group}"][data-plugin-digest="${proposal.digest}"] [data-enable-group-plugin]`)
  await closePanel(b);await poll(b,`globalThis.qaReplyLive===${version}&&globalThis.qaReplyReady`)
 }
 await send('ask:old-history');await count(b,'ask:old-history')
 await share(1);await enable(1)
 await send('ask:first');await count(a,'v1:first');await count(c,'v1:first')
 // Directory refresh must neither restart a live plugin nor replay its history.
 const runs=await evaluate(b.client,'globalThis.qaReplyRuns')
 for(let i=0;i<3;i++)await action(a,'groups/rename',{groupId:group,name:'重启热更新验收 '+i})
 await poll(b,`window.moreThanChat.getServerState().then(s=>s.directory.groups.find(g=>g.id===${JSON.stringify(group)})?.name==='重启热更新验收 2')`)
 assert.equal(await evaluate(b.client,'globalThis.qaReplyRuns'),runs)
 assert(!(await history(a,conversationId)).some(m=>m.text==='v1:old-history'))
 // Stop while a reply plan exists but has not entered the host's reliable queue.
 await evaluate(b.client,`globalThis.qaReplyBeforeSend=p=>new Promise(resolve=>{globalThis.qaHeldPlan=p;globalThis.qaReleasePlan=resolve})`)
 await send('ask:planned-restart');await poll(b,'Boolean(globalThis.qaHeldPlan)')
 const planned=await evaluate(b.client,'globalThis.qaHeldPlan.request')
 const identity=b.id;await close(b)
 for(let i=0;i<65;i++)await send('ask:offline-'+i)
 await count(c,'ask:offline-64')
 b=await launch('B',true);assert.equal(b.id,identity)
 await poll(b,'globalThis.qaReplyLive===1&&globalThis.qaReplyReady')
 await count(a,'v1:planned-restart');await count(a,'v1:offline-64')
 await count(c,'v1:offline-64')
 let messages=await history(a,conversationId)
 assert.equal(messages.filter(m=>m.text.startsWith('v1:offline-')).length,65)
 assert.equal(messages.find(m=>m.text==='v1:planned-restart').clientMessageId,planned.clientMessageId)
 assert.equal(messages.filter(m=>m.text==='v1:old-history').length,0)
 console.log('PASS restart: saved plan, 65 offline messages beyond projection window, no historical replay')
 // Approve a real upgrade while an old instance is preparing a reply.
 await evaluate(b.client,`globalThis.qaReplyBeforeSend=p=>new Promise(resolve=>{globalThis.qaHeldPlan=p;globalThis.qaReleasePlan=resolve})`)
 await send('ask:hot-update');await poll(b,'Boolean(globalThis.qaHeldPlan)')
 const hot=await evaluate(b.client,'globalThis.qaHeldPlan.request')
 await share(2);await poll(b,'globalThis.qaReplyLive===0')
 await evaluate(b.client,'globalThis.qaReplyBeforeSend=null')
 await enable(2);await count(a,'v1:hot-update')
 await evaluate(b.client,'globalThis.qaReleasePlan()')
 await send('ask:new-version');await count(a,'v2:new-version');await count(c,'v2:new-version')
 messages=await history(a,conversationId)
 assert.equal(messages.filter(m=>m.senderId===identity&&m.text.endsWith(':hot-update')).length,1)
 assert.equal(messages.find(m=>m.text==='v1:hot-update').clientMessageId,hot.clientMessageId)
 console.log('PASS hot update: old pending work revoked, exact reply plan retained, new requests use v2')
 // Crash-window equivalent: durable enqueue succeeds, but plugin checkpoint has not advanced.
 await evaluate(b.main,`(()=>{globalThis.qaOriginalFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/v1/messages'))throw Error('QA offline send');return qaOriginalFetch(input,init)}})()`)
 await evaluate(b.client,`globalThis.qaReplyAfterSend=p=>new Promise(resolve=>{globalThis.qaQueuedPlan=p;globalThis.qaReleaseQueued=resolve})`)
 await send('ask:queued-restart');await poll(b,'Boolean(globalThis.qaQueuedPlan)')
 const queued=await evaluate(b.client,'globalThis.qaQueuedPlan.request')
 assert((await history(b,conversationId)).some(m=>m.clientMessageId===queued.clientMessageId&&m.status==='queued'))
 await close(b);b=await launch('B',true)
 await poll(b,'globalThis.qaReplyLive===2&&globalThis.qaReplyReady')
 await count(a,'v2:queued-restart');await count(c,'v2:queued-restart')
 messages=await history(a,conversationId)
 assert.equal(messages.filter(m=>m.clientMessageId===queued.clientMessageId).length,1)
 console.log('PASS restart: durable outbox and plugin retry converge to one message')
 // Server accepted the send but the sender lost both its HTTP and event receipts.
 await evaluate(b.main,`(()=>{globalThis.qaOriginalFetch=globalThis.fetch;globalThis.qaLoseReceipt=false;globalThis.fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/v1/events')){if(qaLoseReceipt)return new Response('{}',{status:503});const response=await qaOriginalFetch(input,init);return qaLoseReceipt?new Response('{}',{status:503}):response}if(url.endsWith('/v1/messages')){if(qaLoseReceipt)throw Error('QA receipt still unavailable');globalThis.qaLoseReceipt=true;globalThis.qaLostRequest={input,init};const response=await qaOriginalFetch(input,init);await response.text();throw Error('QA accepted but lost receipt')}return qaOriginalFetch(input,init)}})()`)
 await send('ask:lost-receipt');await count(a,'v2:lost-receipt');await count(c,'v2:lost-receipt')
 const lost=(await history(b,conversationId)).find(m=>m.text==='v2:lost-receipt')
 assert.equal(lost.status,'queued')
 assert.equal(sendAttempts.get(lost.clientMessageId),1)
 // Independently replay the identical wire request: the retry must return the
 // same canonical message, not fan out a second message. This uses only QA state.
 const retried=await evaluate(b.main,`qaOriginalFetch(qaLostRequest.input,{...qaLostRequest.init,signal:AbortSignal.timeout(10000)}).then(async r=>({status:r.status,body:await r.json()}))`)
 assert.equal(retried.status,200)
 assert.equal(retried.body.messageId,(await history(a,conversationId)).find(m=>m.text==='v2:lost-receipt').id)
 assert.equal(sendAttempts.get(lost.clientMessageId),2)
 await close(b);b=await launch('B',true)
 await poll(b,'globalThis.qaReplyLive===2&&globalThis.qaReplyReady')
 await poll(b,`window.moreThanChat.accessChat({action:'history',conversationId:${JSON.stringify(conversationId)}}).then(r=>JSON.parse(r.dataJson).messages.some(m=>m.text==='v2:lost-receipt'&&m.status==='sent'))`)
 await delay(300)
 // The session directory already contains this receipt. Correct recovery avoids
 // another HTTP send; do not mistake that path for wire-level retry deduplication.
 assert.equal(sendAttempts.get(lost.clientMessageId),2)
 for(const s of [a,b,c]){
  const all=await history(s,conversationId),replies=all.filter(m=>m.senderId===identity&&/^v[12]:/.test(m.text))
  assert.equal(replies.length,71)
  assert.equal(new Set(replies.map(m=>m.clientMessageId)).size,71)
  assert.equal(replies.filter(m=>m.text.endsWith(':old-history')).length,0)
  assert.equal(replies.filter(m=>m.text==='v2:lost-receipt').length,1)
 }
 assert.deepEqual(await evaluate(b.client,'globalThis.qaReplyErrors'),[])
 assert.equal(relay.db.prepare("SELECT COUNT(*) AS n FROM message_routes WHERE sender=? AND client_id LIKE 'reply-%'").get(identity).n,71)
 assert.equal(await evaluate(c.client,'globalThis.qaReplyLive??0'),0)
 result={ok:true,profile:directory,checks:['three real Electron profiles; share, administrator approval and local opt-in','pre-activation history ignored','ordinary directory refresh preserves instance','three complete client restarts preserve identity, local choice and plugin-owned checkpoint','65 offline requests beyond latest-50 projection all answered','pending plan survives hot update with original ID/body','late old-version completion cannot resend','persisted outbox and plugin retry deduplicated','identical lost-receipt wire retry returns same canonical message','session receipts settle the persisted outbox after restart without needless resend','71 replies, exactly once on all three clients; passive member never executes plugin']}
}finally{
 for(const s of sessions.reverse())await close(s).catch(error=>{console.error(error.message,s.logs);process.exitCode=1})
 await relay.close()
}
console.log(JSON.stringify(result,null,2))
