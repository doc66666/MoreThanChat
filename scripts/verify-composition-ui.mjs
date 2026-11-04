import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { createCentralServer } from '../apps/central-server/src/server.mjs'
import { CdpClient, evaluate, waitForTarget, reservePort, waitForExit, delay } from './verify-plugin-ui.mjs'

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps/desktop'),executable=createRequire(path.join(desktop,'package.json'))('electron')
const directory=await mkdtemp(path.join(tmpdir(),'mtc-composition-')),sessions=[],checks=[]
const server=createCentralServer({directory:path.join(directory,'relay'),mode:'public',adminToken:'qa-composition-only-0001'})
const url='http://127.0.0.1:'+(await server.listen(0)).port
let completeModel
const modelServer=createServer(async(req,res)=>{
 for await(const _chunk of req){}
 res.writeHead(200,{'Content-Type':'text/event-stream'})
 const chunk=text=>'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n'
 res.write(chunk('热更新前的内容，'))
 completeModel=()=>{if(!res.writableEnded)res.end(chunk('热更新后的内容。')+'data: [DONE]\n\n')}
})
await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve))
const run=(s,code)=>evaluate(s.client,code)
async function poll(s,code,ms=15000){const until=Date.now()+ms;while(Date.now()<until){if(await run(s,code))return;await delay(70)}throw Error('Composition UI timeout: '+code)}
async function launch(name){
 const port=await reservePort(),profile=path.join(directory,name),child=spawn(executable,[`--remote-debugging-port=${port}`,'.'],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:profile},windowsHide:true,stdio:['ignore','pipe','pipe']})
 const s={child,profile,logs:''};sessions.push(s);child.stdout.resume();child.stderr.on('data',b=>s.logs=(s.logs+b).slice(-10000))
 s.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
 await poll(s,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&!!document.querySelector('.composer textarea')`);return s
}
async function close(s){if(!s||s.child.exitCode!==null)return;await Promise.race([run(s,'window.moreThanChat.quitApp()').catch(()=>{}),delay(1000)]);await waitForExit(s.child,8000);s.client.close();if(s.child.exitCode===null){s.child.kill();throw Error('Client failed to exit')}assert.equal(s.child.exitCode,0)}
async function click(s,selector){await poll(s,`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await run(s,`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function panel(s){if(await run(s,`!!document.querySelector('.plugin-drawer')`))await click(s,'.plugin-drawer .drawer-header button');await click(s,'button[title="插件"]');await poll(s,`!!document.querySelector('[data-client-plugins]')`)}
async function toggleClient(s,id,enabled){
 await panel(s)
 const expression=`[...document.querySelectorAll('[data-client-plugin="${id}"] button')].find(b=>b.textContent===${JSON.stringify(enabled?'启用':'停用界面插件')})`
 await poll(s,`${expression}&&!(${expression}).disabled`)
 await run(s,`(${expression}).click()`)
 await poll(s,`window.moreThanChat.getClientPlugins().then(ps=>ps.some(p=>p.manifest.id===${JSON.stringify(id)}&&p.enabled===${enabled}))`)
}
async function install(s,pack){
 await run(s,`window.moreThanChat.createPluginDraft(${JSON.stringify({manifestJson:JSON.stringify(pack.manifest),source:JSON.stringify(pack.program)})})`)
 const inspection=await run(s,'window.moreThanChat.inspectPluginDrafts()'),revision=inspection.drafts.find(p=>p.id===pack.manifest.id).revision
 await panel(s);await poll(s,`document.querySelector('[data-draft-id="${pack.manifest.id}"] small')?.textContent.includes('r${revision} ·')`)
 await click(s,`[data-draft-id="${pack.manifest.id}"] [data-client-install]`)
 await poll(s,`window.moreThanChat.getClientPlugins().then(ps=>ps.some(p=>p.manifest.id===${JSON.stringify(pack.manifest.id)}&&p.manifest.version===${JSON.stringify(pack.manifest.version)}&&p.enabled))`)
}
function pack(id,version,code,requires=['ui.surfaces'],provides=[]){return {manifest:{manifestVersion:1,id,version,displayName:id,description:'用户插件替换默认功能验收',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted'],services:{requires,provides}},program:{kind:'executable-client',code}}}
function header(version){return pack('test.replace-header',version,`export default(ctx,sdk)=>{globalThis.__headerLive=(globalThis.__headerLive||0)+1;ctx.effect(()=>globalThis.__headerLive--);ctx.contribute(ctx.getService('ui.surfaces'),{id:'header',surface:'workspace.chat.header',render:({defaultView,context})=>sdk.React.createElement('div',{'data-user-header':'${version}','data-selected-model':context.modelSettings?.model},defaultView,sdk.React.createElement('small',null,'用户插件标题 ${version}'))})}`)}
async function nativePlugin(s,area,id,service,method,value){
 const folder=path.join(s.profile,...(area==='host'?['host-private','plugins']:['main-plugins']),id);await mkdir(folder,{recursive:true})
 const manifest={manifestVersion:1,id,version:'1.0.0',displayName:id,description:'Node provider replacement',targets:['pc-host'],engine:{moreThanChat:'^0.1.0'},permissions:['host.trusted'],services:{requires:[service],provides:[service]}}
 await writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest))
 const code=`export default ctx=>{const original=ctx.getService('${service}');ctx.provideService('${service}',new Proxy(original,{get(target,key){if(key==='${method}')return (...args)=>{const result=target[key](...args);const patch=value=>({...value,${service==='model.agent'?'model':'displayName'}:'${value}'});return result&&typeof result.then==='function'?result.then(patch):patch(result)};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v}}))}`
 await writeFile(path.join(folder,'index.mjs'),code);return folder
}
try {
 let a=await launch('a');const b=await launch('b')
 for(const [s,name]of [[a,'模块作者'],[b,'测试好友']])await run(s,`window.moreThanChat.connectServer(${JSON.stringify(url)},${JSON.stringify(name)})`)
 const aid=(await run(a,'window.moreThanChat.getServerState()')).userId,bid=(await run(b,'window.moreThanChat.getServerState()')).userId
 await run(a,`window.moreThanChat.serverAction('friends/request',{userId:${JSON.stringify(bid)}})`);await run(b,`window.moreThanChat.serverAction('friends/accept',{userId:${JSON.stringify(aid)}})`)
 await poll(a,`window.moreThanChat.loadState().then(s=>s.conversations.some(c=>c.targetId===${JSON.stringify(bid)}))`)
 const chat=(await run(a,'window.moreThanChat.loadState()')).conversations.find(c=>c.targetId===bid).id
 await install(a,header('1.0.0'));await click(a,'.plugin-drawer .drawer-header button');await poll(a,`document.querySelector('[data-user-header="1.0.0"]')&&globalThis.__headerLive===1`)
 await run(a,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(chat)},clientMessageId:'composition-before',text:'替换标题后仍可聊天'})`)
 await poll(b,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==='替换标题后仍可聊天'))`)
 await install(a,header('2.0.0'));await poll(a,`globalThis.__headerLive===1&&!!document.querySelector('[data-user-header="2.0.0"]')`)
 checks.push('user plugin replaces one built-in view; hot update leaves one effect; chat continues')
 await click(a,'.plugin-drawer .drawer-header button')
 await run(a,`window.moreThanChat.setModelSettings({providerMode:'openai-compatible',baseUrl:'http://127.0.0.1:${modelServer.address().port}/v1',model:'local-composition-test',apiKey:'qa-composition-fixture'})`)
 await run(a,`(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'热更新中继续回复');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
 await click(a,'.send-button')
 await poll(a,`document.querySelector('.message-scroll')?.textContent.includes('热更新前的内容')`)
 await run(a,`void(globalThis.__timeline=document.querySelector('.message-scroll'))`)
 const servicePack=pack('test.model-provider','1.0.0',`export default ctx=>{const previous=ctx.getService('model.api');ctx.provideService('model.api',{...previous,getModelSettings:async()=>({...await previous.getModelSettings(),model:'插件服务模型'})})}`,['model.api'],['model.api'])
 await install(a,servicePack);await poll(a,`document.querySelector('[data-selected-model]')?.dataset.selectedModel==='插件服务模型'`)
 assert.equal(await run(a,`globalThis.__timeline===document.querySelector('.message-scroll')`),true)
 completeModel()
 await poll(a,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==='热更新前的内容，热更新后的内容。'&&m.status==='sent'))`)
 checks.push('live AI stream and timeline survive service rebinding without missing or duplicating chunks')
 checks.push('installed user provider replaces a built-in service and consumers rebind')
 await close(a);a=await launch('a');await poll(a,`!!document.querySelector('[data-user-header="2.0.0"]')&&document.querySelector('[data-selected-model]')?.dataset.selectedModel==='插件服务模型'`)
 await toggleClient(a,'test.replace-header',false)
 await poll(a,`!document.querySelector('[data-user-header]')&&globalThis.__headerLive===0&&!!document.querySelector('.chat-header')`)
 await toggleClient(a,'test.model-provider',false)
 await close(a);a=await launch('a')
 assert.equal(await run(a,`!document.querySelector('[data-user-header]')&&!globalThis.__headerLive&&!!document.querySelector('.chat-header')`),true)
 assert((await run(a,'window.moreThanChat.getClientPlugins()')).every(p=>!p.enabled))
 await toggleClient(a,'test.replace-header',true);await toggleClient(a,'test.model-provider',true)
 await poll(a,`document.querySelector('[data-selected-model]')?.dataset.selectedModel==='插件服务模型'&&globalThis.__headerLive===1`)
 checks.push('disabled user view/service stay disabled across restart; re-enable restores exactly one view and the selected service')
 await panel(a);await click(a,'[data-client-plugin="test.model-provider"] [data-client-uninstall]')
 await poll(a,`document.querySelector('[data-selected-model]')?.dataset.selectedModel!=='插件服务模型'`)
 await panel(a);await click(a,'[data-client-plugin="test.replace-header"] [data-client-uninstall]')
 await poll(a,`!document.querySelector('[data-user-header]')&&!!document.querySelector('.chat-header')`)
 checks.push('restart restores provider selections; uninstall restores default service and view')
 const node=await nativePlugin(a,'host','test.host-model','model.agent','getSettings','Node provider v1')
 await poll(a,`window.moreThanChat.getModelSettings().then(s=>s.model==='Node provider v1')`)
 await nativePlugin(a,'host','test.host-model','model.agent','getSettings','Node provider v2')
 await poll(a,`window.moreThanChat.getModelSettings().then(s=>s.model==='Node provider v2')`)
 await writeFile(path.join(node,'index.mjs'),'export default()=>{throw Error("invalid Node update")}')
 await poll(a,`window.moreThanChat.getHostPlugins().then(c=>c.plugins.some(p=>p.id==='test.host-model'&&p.error?.includes('invalid Node update')))`)
 await close(a);a=await launch('a')
 await poll(a,`window.moreThanChat.getModelSettings().then(s=>s.model==='Node provider v2')`)
 await run(a,`window.moreThanChat.setHostPluginEnabled('test.host-model',false)`)
 await close(a);a=await launch('a')
 await poll(a,`window.moreThanChat.getModelSettings().then(s=>s.model!=='Node provider v2')`)
 await run(a,`window.moreThanChat.setHostPluginEnabled('test.host-model',true)`)
 await poll(a,`window.moreThanChat.getModelSettings().then(s=>s.model==='Node provider v2')`)
 checks.push('utility Host rejects a broken edit, restores its accepted version on cold start, and preserves explicit disable/re-enable across restart')
 await rm(node,{recursive:true});await poll(a,`window.moreThanChat.getModelSettings().then(s=>s.model!=='Node provider v2')`)
 checks.push('actual utility Host: user Node provider hot replacement and default restoration')
 const main=await nativePlugin(a,'main','test.main-central','central.client','snapshot','Main provider')
 await poll(a,`window.moreThanChat.getServerState().then(s=>s.displayName==='Main provider').catch(()=>false)`)
 await run(a,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(chat)},clientMessageId:'composition-after',text:'主进程服务替换后仍可聊天'})`)
 await poll(b,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text==='主进程服务替换后仍可聊天'))`)
 await rm(main,{recursive:true});await poll(a,`window.moreThanChat.getServerState().then(s=>s.displayName==='模块作者').catch(()=>false)`)
 checks.push('actual Electron main: central service decorator swaps without duplicate/lost messages')
 await panel(a);await click(a,'[data-composition-modules]')
 await click(a,'[data-plugin-id="builtin.host.agent"] .plugin-toggle')
 await poll(a,`window.moreThanChat.getHostPlugins().then(c=>c.plugins.some(p=>p.id==='builtin.host.agent'&&p.status==='inactive'))`)
 await click(a,'[data-plugin-id="builtin.host.agent"] .plugin-toggle')
 await poll(a,`window.moreThanChat.getHostPlugins().then(c=>c.plugins.some(p=>p.id==='builtin.host.agent'&&p.status==='active'))`)
 await run(a,`window.moreThanChat.setHostPluginEnabled('builtin.main.central',false)`)
 assert.equal(await run(a,`window.moreThanChat.loadState().then(s=>s.conversations.some(c=>c.id===${JSON.stringify(chat)}))`),true)
 await run(a,`window.moreThanChat.setHostPluginEnabled('builtin.host.agent',false)`)
 await close(a);a=await launch('a')
 const disabledCatalog=await run(a,'window.moreThanChat.getHostPlugins()')
 for(const id of ['builtin.main.central','builtin.host.agent'])assert.equal(disabledCatalog.plugins.find(p=>p.id===id)?.status,'inactive')
 assert.equal(await run(a,`window.moreThanChat.loadState().then(s=>s.conversations.some(c=>c.id===${JSON.stringify(chat)}))`),true)
 const bchat=(await run(b,'window.moreThanChat.loadState()')).conversations.find(c=>c.targetId===aid).id
 await run(b,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(bchat)},clientMessageId:'composition-offline',text:'停用重启期间等待送达'})`)
 await run(a,`window.moreThanChat.setHostPluginEnabled('builtin.host.agent',true)`)
 await run(a,`window.moreThanChat.setHostPluginEnabled('builtin.main.central',true)`)
 await poll(a,`window.moreThanChat.getServerState().then(s=>s.status==='connected')`)
 await poll(a,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().filter(m=>m.text==='停用重启期间等待送达').length===1)`)
 await run(a,`window.moreThanChat.sendCentralMessage({conversationId:${JSON.stringify(chat)},clientMessageId:'composition-restarted',text:'重新启用后双向聊天正常'})`)
 await poll(b,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().filter(m=>m.text==='重新启用后双向聊天正常').length===1)`)
 checks.push('disabled built-in Agent/central remain inactive after restart; local history works; re-enable reconnects, delivers queued message once, and resumes bidirectional chat')
 await panel(a)
 await click(a,'.plugin-drawer .drawer-header button')
 assert.equal(await run(a,`Math.round(document.querySelector('.app-shell').getBoundingClientRect().top)`),0,'closing plugin management must not scroll the native application chrome')
 assert.equal(await run(a,`document.querySelector('.window-title').getBoundingClientRect().top>=0`),true)
 await run(a,`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`)
 const capture=await a.client.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,'.artifacts/composition-ui.png'),Buffer.from(capture.data,'base64'))
 console.log(JSON.stringify({passed:true,directory,checks},null,2))
} catch(error){for(const s of sessions)console.error(s.logs);throw error}
finally{completeModel?.();for(const s of sessions)await close(s);await server.close();modelServer.closeAllConnections();await new Promise(resolve=>modelServer.close(resolve))}
