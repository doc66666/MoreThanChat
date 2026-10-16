import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { CdpClient, evaluate, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps','desktop')
const executable=createRequire(path.join(desktop,'package.json'))('electron')
const data=await mkdtemp(path.join(tmpdir(),'mtc-chat-experience-')),sessions=[],bodies=[]
const relay=createCentralServer({directory:path.join(data,'relay'),mode:'public',adminToken:'qa-only-experience-admin-token-0001'})
const url='http://127.0.0.1:'+(await relay.listen(0)).port
const otherRelay=createCentralServer({directory:path.join(data,'other-relay'),mode:'public',adminToken:'qa-only-experience-admin-token-0002'})
const otherUrl='http://127.0.0.1:'+(await otherRelay.listen(0)).port
const imageFile=path.join(data,'one.png'),textFile=path.join(data,'note.txt')
const imageData='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII='
await writeFile(imageFile,Buffer.from(imageData,'base64'));await writeFile(textFile,'聊天附件 UTF-8 内容',{flag:'wx'})
let ac,bc,imageMessage,textMessage,modelError
const model=createServer(async(req,res)=>{
 try{
  let body='';for await(const chunk of req)body+=chunk
  const request=JSON.parse(body);bodies.push(request)
  const results=request.messages.filter(m=>m.role==='tool'),round=results.length
  const steps=[['list_conversations',{}],['read_chat_history',{conversationId:bc}],['read_chat_attachment',{conversationId:bc,messageId:imageMessage,format:'image'}],['read_chat_attachment',{conversationId:bc,messageId:textMessage,format:'text'}],['send_chat_message',{conversationId:bc,clientMessageId:'qa-assistant-reply',text:'助手已读取聊天与附件'}]]
  if(round===1)assert(JSON.parse(results[0].content).conversations.some(c=>c.id===bc))
  if(round===2)assert(JSON.parse(results[1].content).messages.some(m=>m.id===imageMessage))
  if(round===3)assert(request.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.image_url?.url==='data:image/png;base64,'+imageData)))
  if(round===4)assert.equal(JSON.parse(results[3].content).text,'聊天附件 UTF-8 内容')
  if(round===5)assert.equal(JSON.parse(results[4].content).queued,true)
  const step=steps[round],delta=step?{tool_calls:[{index:0,id:'call-'+round,function:{name:step[0],arguments:JSON.stringify(step[1])}}]}:{content:'读取和代发已完成。'}
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:step?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
 }catch(error){modelError=error;res.writeHead(500);res.end('Fixture assertion failed')}
})
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve))
async function poll(client,expression,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(client,expression))return;await delay(80)}throw Error('Chat experience timeout: '+expression)}
async function launch(name){
 const port=await reservePort(),inspector=await reservePort(),profile=path.join(data,name)
 const child=spawn(executable,[`--remote-debugging-port=${port}`,`--inspect=127.0.0.1:${inspector}`,'.'],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:profile},windowsHide:true,stdio:['ignore','pipe','pipe']})
 const s={child,logs:''};sessions.push(s);child.stdout.resume();child.stderr.on('data',chunk=>s.logs=(s.logs+chunk).slice(-12000))
 s.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
 await poll(s.client,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&Boolean(document.querySelector('.composer textarea'))`)
 s.main=await CdpClient.connect((await(await fetch(`http://127.0.0.1:${inspector}/json/list`)).json())[0].webSocketDebuggerUrl)
 await evaluate(s.main,`(()=>{globalThis.qaElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');globalThis.qaWindow=()=>qaElectron.BrowserWindow.getAllWindows()[0];if(qaElectron.app.getPath('userData')!==${JSON.stringify(profile)})throw Error('Not a test profile');globalThis.qaFiles=[];qaElectron.dialog.showOpenDialog=async()=>{if(!qaFiles.length)throw Error('Unexpected test picker');return {canceled:false,filePaths:[qaFiles.shift()]}};})()`)
 return s
}
async function close(s){
 if(!s||s.child.exitCode!==null)return
 s.main?.close();s.main=null
 await evaluate(s.client,'window.moreThanChat.quitApp()').catch(()=>{})
 await waitForExit(s.child,6000);s.client?.close()
 if(s.child.exitCode===null){s.child.kill();throw Error('Test app did not exit')}
 assert.equal(s.child.exitCode,0)
}
const send=(s,id,text,attachmentId)=>evaluate(s.client,`window.moreThanChat.sendCentralMessage(${JSON.stringify({conversationId:id,clientMessageId:crypto.randomUUID(),text,...(attachmentId?{attachmentId}:{})})})`)
const read=(s,input)=>evaluate(s.client,`window.moreThanChat.accessChat(${JSON.stringify(input)}).then(r=>JSON.parse(r.dataJson))`)
const unread=(s,id)=>evaluate(s.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(id)}).unread)`)
const bottom=`(()=>{const n=document.querySelector('.message-scroll');return n&&n.clientHeight>0&&n.scrollHeight-n.scrollTop-n.clientHeight<=2})()`
async function click(s,selector){await poll(s.client,`Boolean(document.querySelector(${JSON.stringify(selector)}))`);await evaluate(s.client,`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function input(s,selector,value){await evaluate(s.client,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
const conversationSelector=id=>`[data-conversation-id="${id}"]`
let result
try{
 const a=await launch('a'),b=await launch('b')
 const aid=(await evaluate(a.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'验收甲')`)).userId
 const bid=(await evaluate(b.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'验收乙')`)).userId
 await evaluate(a.client,`window.moreThanChat.serverAction('friends/request',{userId:${JSON.stringify(bid)}})`)
 await evaluate(b.client,`window.moreThanChat.serverAction('friends/accept',{userId:${JSON.stringify(aid)}})`)
 for(const [s,id] of [[a,bid],[b,aid]])await poll(s.client,`window.moreThanChat.loadState().then(s=>s.conversations.some(c=>c.targetId===${JSON.stringify(id)}))`)
 ac=(await read(a,{action:'list'})).conversations.find(c=>c.targetId===bid).id
 bc=(await read(b,{action:'list'})).conversations.find(c=>c.targetId===aid).id
 await evaluate(a.client,'window.moreThanChat.focusChatWindow()')
 for(let i=0;i<55;i++)await send(a,ac,'滚动验收 '+i+'\n这是两端聊天的测试记录。')
 await poll(b.client,`window.moreThanChat.searchChatMessages('滚动验收 54').then(m=>m.length===1)`,30000)
 assert.equal(await unread(b,bc),55)
 const first=await evaluate(b.client,`window.moreThanChat.getFirstUnread(${JSON.stringify(bc)})`)
 await read(b,{action:'history',conversationId:bc});assert.equal(await unread(b,bc),55)
 await evaluate(b.client,'window.moreThanChat.focusChatWindow()');await click(b,conversationSelector(bc))
 await poll(b.client,bottom);await poll(b.client,`document.querySelector('[data-unread-entry]')?.textContent.includes('55')`)
 await poll(b.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(bc)}).unread===0)`)
 await click(b,'[data-unread-entry] button')
 await poll(b.client,`Boolean(document.querySelector('[data-message-id="${first}"]'))`)
 assert.equal(await evaluate(b.client,`document.querySelector('[data-message-id="${first}"]').getBoundingClientRect().bottom>document.querySelector('.message-scroll').getBoundingClientRect().top`),true)
 await click(b,'.jump-latest');await poll(b.client,bottom)
 await evaluate(b.client,`document.querySelector('.message-scroll').scrollTop=0`);await delay(150)
 await send(a,ac,'滚动在上方时的新消息')
 await poll(b.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(bc)}).unread===1)`)
 assert.equal(await evaluate(b.client,bottom),false)
 // An assistant/plugin send is not a user scroll gesture and must not read unseen messages.
 await read(b,{action:'send',conversationId:bc,clientMessageId:'qa-background-reply',text:'后台插件回复'})
 await delay(250)
 assert.equal(await evaluate(b.client,bottom),false,'A background self message must not pull the reader to the bottom')
 assert.equal(await unread(b,bc),1,'A background reply must not mark the peer message read')
 await poll(b.client,`document.querySelector('[data-unread-entry]')?.textContent.includes('1 条新消息')`)
 const newestUnread=await evaluate(b.client,`window.moreThanChat.getFirstUnread(${JSON.stringify(bc)})`)
 await click(b,'[data-unread-entry] button')
 await poll(b.client,`Boolean(document.querySelector('[data-message-id="${newestUnread}"] .message-highlight, [data-message-id="${newestUnread}"].message-highlight'))`)
 await click(b,'.jump-latest');await poll(b.client,bottom)
 await send(a,ac,'底部可见消息不应未读')
 await poll(b.client,`document.querySelector('.message-scroll')?.textContent.includes('底部可见消息不应未读')`)
 await poll(b.client,bottom);assert.equal(await unread(b,bc),0)
 await evaluate(b.client,`document.querySelector('.message-scroll').scrollTop=0`);await delay(150)
 await click(b,conversationSelector(bc));await poll(b.client,bottom)
 // Explicitly sending in this window should still follow the user's new message.
 await evaluate(b.client,`document.querySelector('.message-scroll').scrollTop=0`);await delay(150)
 await input(b,'.composer textarea','本机手动发送后回到底部');await click(b,'.send-button');await poll(b.client,bottom)
 await poll(a.client,`window.moreThanChat.searchChatMessages('本机手动发送后回到底部').then(m=>m.length===1)`)
 await click(b,'button[title="设置"]');await delay(150);await send(a,ac,'设置遮挡时保留未读')
 await poll(b.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(bc)}).unread===1)`)
 await click(b,'.settings-drawer .drawer-header button');await poll(b.client,bottom)
 await poll(b.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(bc)}).unread===0)`)
 // Change the nickname using the actual controls, not only a direct API call.
 await click(a,'.brand-mark');await input(a,'[data-server-field="name"]','甲的新昵称')
 assert((await evaluate(a.client,`document.querySelector('[data-connect-server]').textContent`)).includes('保存昵称'))
 await click(a,'[data-connect-server]');await poll(a.client,`document.querySelector('.network-drawer')?.textContent.includes('昵称已保存')`)
 await click(a,'[aria-label="关闭服务器与联系人"]')
 await poll(b.client,`document.querySelector('.chat-identity h1')?.textContent==='甲的新昵称'`)
 assert((await evaluate(b.client,`document.querySelector(${JSON.stringify(conversationSelector(bc))}).textContent`)).includes('甲的新昵称'))
 assert((await evaluate(b.client,`[...document.querySelectorAll('.sender-name')].map(n=>n.textContent)`)).includes('甲的新昵称'))
 // Receive an image and a UTF-8 file; leave the conversation so model reads cannot mark it read.
 await click(b,'[data-conversation-id="conversation-assistant"]')
 for(const file of [imageFile,textFile]){
  await evaluate(a.main,`qaFiles.push(${JSON.stringify(file)})`)
  const attachment=await evaluate(a.client,'window.moreThanChat.chooseAttachment()');await send(a,ac,path.basename(file),attachment.id)
 }
 await poll(b.client,`window.moreThanChat.searchChatMessages('note.txt').then(m=>m.length===1)`)
 const history=await read(b,{action:'history',conversationId:bc})
 imageMessage=history.messages.find(m=>m.attachment?.name==='one.png').id;textMessage=history.messages.find(m=>m.attachment?.name==='note.txt').id
 const before=await unread(b,bc);assert.equal(before,2)
 await evaluate(b.client,`window.moreThanChat.setModelSettings({providerMode:'openai-compatible',baseUrl:'http://127.0.0.1:${model.address().port}',model:'qa-vision',apiKey:'qa-only-test-key'})`)
 await evaluate(b.client,`window.qaTools=[];window.qaTerminal=null;window.moreThanChat.onModelChatEvent(e=>{if(e.type==='author-tool')qaTools.push(e);if(['completed','failed','cancelled'].includes(e.type))qaTerminal=e})`)
 await input(b,'.composer textarea','请读取甲的聊天、图片和文件，然后回复他。');await click(b,'.send-button')
 await poll(b.client,'Boolean(window.qaTerminal)',30000)
 if(modelError)throw modelError
 assert.equal((await evaluate(b.client,'window.qaTerminal')).type,'completed')
 assert.equal(await unread(b,bc),before,'Assistant reads must not create read receipts')
 await poll(a.client,`window.moreThanChat.searchChatMessages('助手已读取聊天与附件').then(m=>m.length===1)`)
 assert.equal((await evaluate(b.client,'window.qaTools.filter(e=>e.phase==="finished"&&e.ok)')).length,5)
 assert(!JSON.stringify(await evaluate(b.client,'window.moreThanChat.loadState()')).includes(imageData),'Do not persist base64 in AI transcript')
 await evaluate(b.client,'window.moreThanChat.focusChatWindow()');await click(b,conversationSelector(bc));await poll(b.client,bottom)
 await mkdir(path.join(root,'.artifacts'),{recursive:true})
 for(const theme of ['light','dark']){
  await click(b,'button[title="设置"]');await click(b,`[data-theme-choice="${theme}"]`);await click(b,'.settings-drawer .drawer-header button');await poll(b.client,bottom);await delay(150)
  const capture=await b.client.send('Page.captureScreenshot',{format:'png',fromSurface:true})
  await writeFile(path.join(root,'.artifacts',`chat-experience-${theme}.png`),Buffer.from(capture.data,'base64'))
 }
 // The same broker is available to an actual installed Cordis client plugin.
 await evaluate(a.client,`window.moreThanChat.serverAction('groups',{name:'接口验收群',memberIds:[${JSON.stringify(bid)}]})`)
 await poll(b.client,`window.moreThanChat.accessChat({action:'list'}).then(r=>JSON.parse(r.dataJson).conversations.some(c=>c.title==='接口验收群'))`)
 const ag=(await read(a,{action:'list'})).conversations.find(c=>c.title==='接口验收群').id
 const bg=(await read(b,{action:'list'})).conversations.find(c=>c.title==='接口验收群').id
 await read(b,{action:'send',conversationId:bg,clientMessageId:'qa-group-send',text:'群接口代发'})
 await poll(a.client,`window.moreThanChat.searchChatMessages('群接口代发').then(m=>m.length===1)`)
 const pluginId='example.qa-chat-sdk'
 const manifest={manifestVersion:1,id:pluginId,version:'0.1.0',displayName:'聊天接口验收',description:'仅响应验收群的指定消息',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted'],services:{requires:['ui.surfaces']}}
 const code=`export default async function activate(ctx,sdk){
  const conversations=await sdk.chat.request({action:'list'}),id=conversations.conversations.find(c=>c.title==='接口验收群').id;
  const page=await sdk.chat.request({action:'history',conversationId:id});
  const seen=new Set(page.messages.map(m=>m.id));let alive=true;
  ctx.effect(()=>{alive=false;globalThis.qaPluginLive=false});
  const surfaces=ctx.getService('ui.surfaces');let uncover=()=>{};ctx.effect(()=>uncover());
  globalThis.qaUncoverChat=()=>uncover();
  globalThis.qaCoverChat=()=>{uncover=surfaces.register(ctx.manifest.id,{id:'qa-cover',surface:'root',render:()=>sdk.React.createElement('div',{'data-qa-chat-cover':true},'测试桌面')})};
  ctx.effect(sdk.chat.subscribe(p=>{for(const m of p.messages[id]||[]){
    if(!alive||seen.has(m.id)||m.role!=='peer'||!['sdk-ping','sdk-delay'].includes(m.text))continue;seen.add(m.id);
    if(m.text==='sdk-delay'){
      globalThis.qaPendingReply=true;
      globalThis.qaReplyJob=(async()=>{
        await new Promise(resolve=>globalThis.qaReleaseReply=resolve);
        // Deliberately omit an author-side alive check: the SDK must revoke the old instance.
        await sdk.chat.request({action:'send',conversationId:id,clientMessageId:'qa-late-'+m.id,text:'sdk-late-pong'});
        return 'sent';
      })().catch(e=>e.message);
    }else sdk.chat.request({action:'send',conversationId:id,clientMessageId:'qa-plugin-'+m.id,text:'sdk-pong'}).catch(e=>globalThis.qaPluginError=e.message);
  }}));globalThis.qaPluginSdk=sdk;globalThis.qaPluginLive=true;
 }`
 await evaluate(b.client,`window.moreThanChat.createPluginDraft(${JSON.stringify({manifestJson:JSON.stringify(manifest),source:JSON.stringify({kind:'executable-client',code})})})`)
 await click(b,'button[title="插件"]');await click(b,`[data-draft-id="${pluginId}"] [data-client-install]`)
 await poll(b.client,'globalThis.qaPluginLive===true')
 await send(a,ag,'sdk-ping');await poll(a.client,`window.moreThanChat.searchChatMessages('sdk-pong').then(m=>m.length===1)`)
 assert.equal(await evaluate(b.client,'globalThis.qaPluginError??null'),null)
 assert.equal(await unread(b,bg),1,'Plugin reads and replies must not mark the group read')
 // An offline local plugin uses the originating conversation ID, not the newly selected server.
 await evaluate(b.client,'window.moreThanChat.disconnectServer()')
 await send(a,ag,'reconnect-unread-one');await send(a,ag,'reconnect-unread-two')
 const queued=await evaluate(b.client,`globalThis.qaPluginSdk.chat.request(${JSON.stringify({action:'send',conversationId:bg,clientMessageId:'qa-offline-plugin',text:'sdk-offline-pong'})})`)
 assert.equal(queued.queued,true)
 await evaluate(b.client,`window.moreThanChat.connectServer(${JSON.stringify(otherUrl)},'验收乙')`)
 assert.equal(otherRelay.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n,0)
 assert.equal((await read(b,{action:'history',conversationId:bg})).messages.find(m=>m.clientMessageId==='qa-offline-plugin').status,'queued')
 await evaluate(b.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'验收乙')`)
 await poll(b.client,`window.moreThanChat.searchChatMessages('reconnect-unread-two').then(m=>m.length===1)`)
 await poll(a.client,`window.moreThanChat.searchChatMessages('sdk-offline-pong').then(m=>m.length===1)`)
 assert.equal(await unread(b,bg),3,'Reconnection and plugin sends must preserve unseen peer messages')
 await evaluate(b.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'验收乙')`)
 assert.equal((await read(a,{action:'history',conversationId:ag})).messages.filter(m=>m.text==='sdk-offline-pong').length,1)
 assert.equal(otherRelay.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n,0)
 await click(b,'.plugin-drawer .drawer-header button');await click(b,conversationSelector(bg));await poll(b.client,bottom)
 await poll(b.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(bg)}).unread===0)`)
 await evaluate(b.client,'globalThis.qaCoverChat()');await poll(b.client,`Boolean(document.querySelector('[data-qa-chat-cover]'))`)
 await delay(150);await send(a,ag,'root-hidden-message')
 await poll(b.client,`window.moreThanChat.searchChatMessages('root-hidden-message').then(m=>m.length===1)`)
 assert.equal(await unread(b,bg),1,'Replacing the default root must stop read receipts even with no scroll container')
 // Test-only loader handle: remove the covering contribution so the normal controls return.
 await evaluate(b.client,'globalThis.qaUncoverChat()');await poll(b.client,`!document.querySelector('[data-qa-chat-cover]')`)
 await click(b,'button[title="插件"]')
 await send(a,ag,'sdk-delay');await poll(b.client,'globalThis.qaPendingReply===true')
 await poll(b.client,`[...document.querySelectorAll('[data-client-plugins] button')].some(b=>b.textContent==='停用界面插件'&&!b.disabled)`)
 await evaluate(b.client,`[...document.querySelectorAll('[data-client-plugins] button')].find(b=>b.textContent==='停用界面插件').click()`)
 await poll(b.client,'globalThis.qaPluginLive===false')
 await evaluate(b.client,'globalThis.qaReleaseReply()')
 assert.match(await evaluate(b.client,'globalThis.qaReplyJob'),/停用/)
 assert.equal((await read(b,{action:'history',conversationId:bg})).messages.filter(m=>m.text==='sdk-late-pong').length,0,'A delayed disabled instance must not even queue a reply')
 await send(a,ag,'sdk-ping');await delay(600)
 assert.equal((await read(a,{action:'history',conversationId:ag})).messages.filter(m=>m.text==='sdk-pong').length,1,'Disabled plugin must stop replying')
 result={ok:true,checks:['latest on entry and reselection','first unread outside latest page','unread while scrolled up','background self sends preserve reading position and unread','new unread takes precedence over entry marker','history page always offers return to live timeline','visible-at-bottom reads','nickname list/header/bubbles','assistant host-main history/image/text/send loop','no read receipts from tools','group read/send broker','custom root stops read receipts','installed client plugin reply and disposal','offline plugin queue survives server switch without cross-server delivery','reconnect delivers once and preserves unread','disabled in-flight plugin reply cannot enqueue'],modelRequests:bodies.length,profile:data}
}finally{
 for(const s of sessions.reverse())await close(s).catch(error=>{console.error(error.message,s.logs);process.exitCode=1})
 await relay.close();await otherRelay.close();await new Promise(resolve=>model.close(resolve))
}
console.log(JSON.stringify(result,null,2))
