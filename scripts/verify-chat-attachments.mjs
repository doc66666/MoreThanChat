import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { CdpClient, evaluate as cdpEvaluate, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

async function evaluate(client,expression){
 let timer
 try{return await Promise.race([cdpEvaluate(client,expression),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CDP deadline: '+expression.slice(0,120))),15000)})])}
 finally{clearTimeout(timer)}
}

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps/desktop')
const executable=createRequire(path.join(desktop,'package.json'))('electron')
const directory=await mkdtemp(path.join(tmpdir(),'mtc-group-attachments-ui-')),sessions=[]
const relay=createCentralServer({directory:path.join(directory,'relay'),mode:'public',adminToken:'qa-only-attachments-admin-token-0001'})
const url='http://127.0.0.1:'+(await relay.listen(0)).port
const png=await readFile(path.join(desktop,'assets','icon.png')),text=Buffer.from('群里的文件内容：你好 🙂\n'),binary=Buffer.from(Array.from({length:100003},(_,i)=>i%256))
const files=[['图片.png',png],['相同内容.bin',png],['说明.txt',text],['数据.bin',binary]]
for(const [name,bytes] of files)await writeFile(path.join(directory,name),bytes)
async function poll(s,expression){const end=Date.now()+20000;while(Date.now()<end){if(await evaluate(s.client,expression))return;await delay(80)}throw Error('Attachment UI timeout: '+expression)}
async function click(s,selector){await poll(s,`Boolean(document.querySelector(${JSON.stringify(selector)}))&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await evaluate(s.client,`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function input(s,selector,value){await evaluate(s.client,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)}
const action=(s,route,data)=>evaluate(s.client,`window.moreThanChat.serverAction(${JSON.stringify(route)},${JSON.stringify(data)})`)
const state=s=>evaluate(s.client,'window.moreThanChat.getServerState()')
const read=(s,request)=>evaluate(s.client,`window.moreThanChat.accessChat(${JSON.stringify(request)}).then(r=>JSON.parse(r.dataJson))`)
async function closePanel(s){await evaluate(s.client,`document.querySelector('.plugin-drawer .drawer-header button')?.click()`)}
async function launch(name){
 const port=await reservePort(),inspector=await reservePort(),profile=path.join(directory,name)
 const child=spawn(executable,[`--remote-debugging-port=${port}`,`--inspect=127.0.0.1:${inspector}`,'.'],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:profile},windowsHide:true,stdio:['ignore','pipe','pipe']})
 const s={child,logs:''};sessions.push(s);child.stdout.resume();child.stderr.on('data',chunk=>s.logs=(s.logs+chunk).slice(-12000))
 s.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
 await poll(s,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&Boolean(document.querySelector('.composer textarea'))`)
 s.main=await CdpClient.connect((await(await fetch(`http://127.0.0.1:${inspector}/json/list`)).json())[0].webSocketDebuggerUrl)
 await evaluate(s.main,`(()=>{globalThis.qaElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');if(qaElectron.app.getPath('userData')!==${JSON.stringify(profile)})throw Error('Not a test profile');globalThis.qaFiles=[];globalThis.qaSaveNames=[];qaElectron.dialog.showOpenDialog=async()=>{if(!qaFiles.length)throw Error('Unexpected picker');return {canceled:false,filePaths:[qaFiles.shift()]}};qaElectron.dialog.showSaveDialog=async(_window,options)=>{qaSaveNames.push(options.defaultPath);return {canceled:false,filePath:${JSON.stringify(path.join(directory,name+'-saved.bin'))}}};})()`)
 s.id=(await evaluate(s.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},${JSON.stringify(name)})`)).userId
 return s
}
async function close(s){
 if(s.child.exitCode!==null)return
 s.main?.close();s.main=null
 await evaluate(s.client,'window.moreThanChat.quitApp()').catch(()=>{})
 await waitForExit(s.child,6000);s.client?.close()
 if(s.child.exitCode===null){s.child.kill();throw Error('Test app did not exit')}
 assert.equal(s.child.exitCode,0)
}
let result
try{
 const a=await launch('A'),b=await launch('B'),c=await launch('C')
 for(const peer of [b,c]){await action(a,'friends/request',{userId:peer.id});await action(peer,'friends/accept',{userId:a.id})}
 const group=(await action(a,'groups',{name:'图片文件群',memberIds:[b.id,c.id]})).directory.groups.find(g=>g.name==='图片文件群').id
 for(const s of [a,b,c])await poll(s,`window.moreThanChat.getServerState().then(s=>s.directory.groups.some(g=>g.id===${JSON.stringify(group)}))`)
 const conversationId=relay.serverId+':'+group,conversationSelector=`[data-conversation-id="${conversationId}"]`
 const pluginId='example.qa-group-attachments',manifest={manifestVersion:1,id:pluginId,version:'1.0.0',displayName:'群文件回声验收',description:'只回复此群指定发送者的 echo 消息',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted']}
 const code=`export default async function activate(ctx,sdk){
  const conversations=await sdk.chat.request({action:'list'}),id=conversations.conversations.find(c=>c.serverId===sdk.conversation.serverId&&c.targetId===sdk.conversation.id).id;
  const initial=await sdk.chat.request({action:'history',conversationId:id});const seen=new Set(initial.messages.map(m=>m.id));
  globalThis.qaMediaReads=[];globalThis.qaMediaJobs=[];globalThis.qaMediaErrors=[];
  const gate=new Promise(resolve=>globalThis.qaReleaseMedia=resolve);
  ctx.effect(()=>{globalThis.qaMediaLive=false});
  ctx.effect(sdk.chat.subscribe(p=>{for(const m of p.messages[id]||[]){
   if(seen.has(m.id)||m.role!=='peer'||m.senderId!==${JSON.stringify(a.id)}||m.retractedAt||!m.attachment||!m.text.startsWith('echo:'))continue;seen.add(m.id);
   qaMediaJobs.push((async()=>{
    const format=m.attachment.mime==='image/png'?'image':m.attachment.mime==='text/plain'?'text':'base64';let offset=0;const chunks=[];
    do{const r=await sdk.chat.request({action:'attachment',conversationId:id,messageId:m.id,format,...(format==='image'?{}:{offset,limit:16384})});chunks.push(r);offset=r.nextOffset??-1;}while(offset>=0);
    qaMediaReads.push({text:m.text,chunks});await gate;
    const request={action:'send',conversationId:id,clientMessageId:'echo-'+m.id,text:'reply:'+m.text.slice(5),attachmentMessageId:m.id};
    await sdk.chat.request(request);await sdk.chat.request(request);
   })().catch(e=>qaMediaErrors.push(e.message)));
  }}));globalThis.qaMediaLive=true;
 }`
 const draft=await evaluate(b.client,`window.moreThanChat.createPluginDraft(${JSON.stringify({manifestJson:JSON.stringify(manifest),source:JSON.stringify({kind:'executable-client',code})})})`)
 assert(draft.ok)
 await click(b,'button[title="插件"]')
 const parent=`[data-draft-id="${pluginId}"]`
 await poll(b,`Boolean(document.querySelector(${JSON.stringify(parent+' [data-share-client]')}))`)
 await evaluate(b.client,`document.querySelector(${JSON.stringify(parent+' [data-share-client]')}).open=true`)
 await input(b,parent+' [data-share-target]',group);await click(b,parent+' [data-share-submit]')
 await poll(a,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.groupId===${JSON.stringify(group)}&&p.status==='pending'))`)
 const proposal=(await state(a)).directory.plugins.find(p=>p.groupId===group)
 await click(a,'button[title="联系人"]');await click(a,`[data-group-plugin-review="${proposal.pack.id}"] [data-approve-group-plugin]`);await closePanel(a)
 await poll(b,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.digest===${JSON.stringify(proposal.digest)}&&p.status==='approved'))`)
 assert.equal(await evaluate(b.client,'globalThis.qaMediaLive??false'),false)
 await closePanel(b);await click(b,conversationSelector);await click(b,'button[title="插件"]')
 const gate=`[data-group-plugin-gate="${proposal.pack.id}"][data-plugin-scope="${group}"]`
 await click(b,gate+' [data-enable-group-plugin]');await closePanel(b);await poll(b,'globalThis.qaMediaLive===true')
 assert.equal(await evaluate(c.client,'globalThis.qaMediaLive??false'),false)
 // Exercise background automation without relying on Windows foreground-focus arbitration.
 await evaluate(b.main,'qaElectron.BrowserWindow.getAllWindows()[0].hide()')
 await poll(b,'window.moreThanChat.getWindowFocus().then(focused=>!focused)')
 await evaluate(c.client,'window.moreThanChat.disconnectServer()')
 await click(a,conversationSelector);await evaluate(a.client,'window.moreThanChat.focusChatWindow()')
 for(const [i,[name]] of files.entries()){
  await evaluate(a.main,`qaFiles.push(${JSON.stringify(path.join(directory,name))})`)
  await click(a,'.composer-plus');await click(a,'.composer-file-action')
  await poll(a,`document.querySelector('.attachment-pending')?.textContent.includes(${JSON.stringify(name)})`)
  if(i===0){
   // Selecting the same bytes under a different MIME/name must not alter the pending image draft.
   await evaluate(a.main,`qaFiles.push(${JSON.stringify(path.join(directory,files[1][0]))})`)
   await evaluate(a.client,'window.moreThanChat.chooseAttachment()')
  }
  await input(a,'.composer textarea','echo:'+i);await click(a,'.send-button')
 }
 await poll(b,'globalThis.qaMediaReads.length===4')
 const reads=await evaluate(b.client,'globalThis.qaMediaReads')
 for(const [i,[,bytes]] of files.entries()){
  const chunks=reads.find(r=>r.text==='echo:'+i).chunks
  const actual=Buffer.concat(chunks.map(r=>r.image?Buffer.from(r.image.data,'base64'):r.text!==undefined?Buffer.from(r.text):Buffer.from(r.data,'base64')))
  assert.deepEqual(actual,bytes)
 }
 await evaluate(b.client,'globalThis.qaReleaseMedia();Promise.all(globalThis.qaMediaJobs)')
 assert.deepEqual(await evaluate(b.client,'globalThis.qaMediaErrors'),[])
 await poll(a,`window.moreThanChat.searchChatMessages('reply:',${JSON.stringify(conversationId)}).then(m=>m.length===4)`)
 assert.equal(await evaluate(b.client,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(conversationId)}).unread)`),4)
 await evaluate(c.client,`window.moreThanChat.connectServer(${JSON.stringify(url)},'C')`)
 await poll(c,`window.moreThanChat.searchChatMessages('reply:',${JSON.stringify(conversationId)}).then(m=>m.length===4)`)
 const history=(await read(c,{action:'history',conversationId})).messages
 for(const [i,[name,bytes]] of files.entries())for(const text of ['echo:'+i,'reply:'+i]){
  const message=history.find(m=>m.text===text);assert.equal(message.attachment.name,name)
  const wire=await evaluate(c.client,`window.moreThanChat.readAttachment(${JSON.stringify(message.attachment)})`)
  assert.deepEqual(Buffer.from(wire.data,'base64'),bytes)
 }
 await click(c,conversationSelector);await evaluate(c.client,'window.moreThanChat.focusChatWindow()')
 const imageMessage=history.find(m=>m.text==='echo:0'),fileMessage=history.find(m=>m.text==='reply:3')
 await poll(c,`(()=>{const image=document.querySelector('[data-message-id="${imageMessage.id}"] img');image?.scrollIntoView();return image?.complete&&image.naturalWidth>0})()`)
 for(const [message,expected] of [[imageMessage,png],[fileMessage,binary]]){
  await click(c,`[data-message-id="${message.id}"] .message-attachment button`)
  await poll(c,`document.querySelector('[data-message-id="${message.id}"]')?.textContent.includes('已保存到所选位置')`)
  assert.deepEqual(await readFile(path.join(directory,'C-saved.bin')),expected)
 }
 assert.deepEqual(await evaluate(c.main,'globalThis.qaSaveNames'),[files[0][0],files[3][0]])
 assert.equal(relay.db.prepare("SELECT COUNT(*) AS n FROM message_routes WHERE client_id LIKE 'echo-%'").get().n,4)
 await click(b,'[data-conversation-id="conversation-assistant"]');await poll(b,'globalThis.qaMediaLive===false')
 await evaluate(a.client,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(conversationId)},clientMessageId:'qa-after-unload',text:'echo:after-unload',attachmentId:${JSON.stringify(imageMessage.attachment.id)},attachmentRef:${JSON.stringify(imageMessage.attachment)}})`)
 await poll(b,`window.moreThanChat.searchChatMessages('echo:after-unload').then(m=>m.length===1)`)
 await delay(250);assert.equal((await read(a,{action:'history',conversationId})).messages.filter(m=>m.text==='reply:after-unload').length,0)
 // A malformed image is still a file: render a recoverable preview error, keep save and chat usable.
 const invalid=Buffer.from('This is a file with a misleading PNG extension.'),invalidFile=path.join(directory,'无法预览.png')
 await writeFile(invalidFile,invalid);await evaluate(a.main,`qaFiles.push(${JSON.stringify(invalidFile)})`)
 await click(a,'.composer-plus');await click(a,'.composer-file-action')
 await poll(a,`document.querySelector('.attachment-pending')?.textContent.includes('无法预览.png')`)
 await input(a,'.composer textarea','');await click(a,'.send-button')
 await poll(c,`window.moreThanChat.accessChat({action:'history',conversationId:${JSON.stringify(conversationId)}}).then(r=>JSON.parse(r.dataJson).messages.some(m=>m.attachment?.name==='无法预览.png'))`)
 const invalidMessage=(await read(c,{action:'history',conversationId})).messages.find(m=>m.attachment?.name==='无法预览.png')
 assert.equal(invalidMessage.text,'')
 await evaluate(c.client,`document.querySelector('[data-message-id="${invalidMessage.id}"]')?.scrollIntoView()`)
 await poll(c,`Boolean(document.querySelector('[data-message-id="${invalidMessage.id}"] .attachment-error'))`)
 await click(c,`[data-message-id="${invalidMessage.id}"] button[aria-label="另存为 无法预览.png"]`)
 await poll(c,`document.querySelector('[data-message-id="${invalidMessage.id}"]')?.textContent.includes('已保存到所选位置')`)
 assert.deepEqual(await readFile(path.join(directory,'C-saved.bin')),invalid)
 await input(c,'.composer textarea','预览失败后聊天仍可使用');await click(c,'.send-button')
 await poll(a,`window.moreThanChat.searchChatMessages('预览失败后聊天仍可使用').then(m=>m.length===1)`)
 result={ok:true,profile:directory,checks:['three real clients: draft, share, approval, opt-in execution','composer keeps selected image metadata despite same-hash file import','image, UTF-8 and chunked binary reads through shared plugin SDK','per-message attachment names and bytes preserved in copies','offline member receives originals and bot replies once','bot replies do not mark peer messages read','actual decoded image preview','UI save dialog uses original filename and saves exact bytes','leaving group view disposes the shared auto-replier','attachment-only message','invalid image keeps error/retry/save controls and chat usable']}
}finally{
 for(const s of sessions.reverse())await close(s).catch(error=>{console.error(error.message,s.logs);process.exitCode=1})
 await relay.close()
}
console.log(JSON.stringify(result,null,2))
