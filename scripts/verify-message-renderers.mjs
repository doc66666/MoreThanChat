import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {mkdtemp,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {createCentralServer} from '../apps/central-server/src/server.mjs'
import {CdpClient,evaluate,waitForTarget,reservePort,waitForExit,delay} from './verify-plugin-ui.mjs'

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps/desktop'),exe=process.env.MTC_TEST_PACKAGED_EXE||createRequire(path.join(desktop,'package.json'))('electron')
const directory=await mkdtemp(path.join(root,'.artifacts/message-renderers-')),sessions=[],checks=[]
const server=createCentralServer({directory:path.join(directory,'central'),mode:'public',adminToken:'qa-message-renderers-only-not-production'})
const url='http://127.0.0.1:'+(await server.listen(0)).port,pluginId='example.html-message'
let passed=false
const run=(s,code)=>evaluate(s.client,code)
async function poll(s,code){const end=Date.now()+20000;while(Date.now()<end){if(await run(s,code))return;await delay(75)}throw Error('Message render UI timeout: '+code)}
async function click(s,selector){await poll(s,`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await run(s,`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function input(s,selector,value){await run(s,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`)}
async function launch(name){
 const port=await reservePort(),child=spawn(exe,[`--remote-debugging-port=${port}`,...(process.env.MTC_TEST_PACKAGED_EXE?[]:['.'])],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_ENABLE_DEMO_PLUGINS:'0',MTC_QA_USER_DATA_DIR:path.join(directory,name)},windowsHide:true,stdio:['ignore','pipe','pipe']})
 const s={name,child,logs:''};sessions.push(s);child.stdout.resume();child.stderr.on('data',d=>s.logs=(s.logs+d).slice(-20000));s.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
 await poll(s,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&!!document.querySelector('.composer textarea')`)
 await run(s,`window.moreThanChat.connectServer(${JSON.stringify(url)},${JSON.stringify(name)})`);s.id=(await run(s,'window.moreThanChat.getServerState()')).userId;return s
}
async function close(s){if(!s?.client)return;await Promise.race([run(s,'window.moreThanChat.quitApp()').catch(()=>{}),delay(1000)]);await waitForExit(s.child,8000);s.client.close();s.client=null;if(s.child.exitCode===null)s.child.kill()}
async function closePanel(s){await run(s,`document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelector('.plugin-drawer .drawer-header button')?.click()`)}
async function panel(s){await closePanel(s);await click(s,'button[title="插件"]');await poll(s,`!!document.querySelector('[data-example-card="${pluginId}"]')`)}
async function install(s){await panel(s);await click(s,`[data-example-card="${pluginId}"] [data-example-install]`);await poll(s,`window.moreThanChat.getClientPlugins().then(p=>p.some(v=>v.manifest.id==='${pluginId}'&&v.enabled))`);await closePanel(s)}
async function openChat(s,target,kind='friends'){await closePanel(s);await click(s,'button[title="联系人"]');await click(s,`[data-contacts-tab="${kind}"]`);await click(s,kind==='groups'?`[data-contact-group="${target}"]`:`[data-contact-chat="${target}"]`)}
const action=(s,route,data)=>run(s,`window.moreThanChat.serverAction(${JSON.stringify(route)},${JSON.stringify(data)})`)
const find=(s,text)=>run(s,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().find(m=>m.text===${JSON.stringify(text)}))`)
const article=id=>`[data-message-id="${id}"]`
async function has(s,text){await poll(s,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.text===${JSON.stringify(text)}&&m.status==='sent'))`);return find(s,text)}
async function sendText(s,text){await input(s,'.composer textarea',text);await click(s,'.send-button')}
const cardDialog=(scope='local')=>`dialog[data-example-source="${pluginId}"][data-example-scope="${scope}"]`
async function editCard(s,summary,body,scope='local'){await click(s,`button[data-example-source="${pluginId}"][data-example-scope="${scope}"]`);await input(s,cardDialog(scope)+' [data-html-summary]',summary);await input(s,cardDialog(scope)+' [data-html-source]',body)}
async function sendCard(s,summary,body,scope='local'){await editCard(s,summary,body,scope);await click(s,cardDialog(scope)+' [data-html-send]');await poll(s,`!document.querySelector(${JSON.stringify(cardDialog(scope))}).open`)}
async function expectDraft(s,summary,body,scope='local'){await click(s,`button[data-example-source="${pluginId}"][data-example-scope="${scope}"]`);await poll(s,`document.querySelector(${JSON.stringify(cardDialog(scope)+' [data-html-summary]')}).value===${JSON.stringify(summary)}&&document.querySelector(${JSON.stringify(cardDialog(scope)+' [data-html-source]')}).value===${JSON.stringify(body)}`);await closePanel(s)}
async function toggle(s,enabled){await panel(s);const button=`[...document.querySelectorAll('[data-client-plugin="${pluginId}"] .draft-actions button')].find(b=>b.textContent===${JSON.stringify(enabled?'启用':'停用界面插件')})`;await poll(s,`${button}&&!(${button}).disabled`);await run(s,`${button}.click()`);await poll(s,`window.moreThanChat.getClientPlugins().then(p=>p.find(v=>v.manifest.id==='${pluginId}')?.enabled===${enabled})`);await closePanel(s)}
async function update(s,version,code){
 const current=(await run(s,'window.moreThanChat.getClientPlugins()')).find(p=>p.manifest.id===pluginId)
 const draft=await run(s,`window.moreThanChat.createPluginDraft(${JSON.stringify({manifestJson:JSON.stringify({...current.manifest,version}),source:JSON.stringify({...current.program,code})})})`)
 assert(draft.persisted&&draft.draft.ok)
 await panel(s);await poll(s,`document.querySelector('[data-draft-id="${pluginId}"] small')?.textContent.includes(${JSON.stringify(' · r'+draft.draft.revision+' ·')})`);await click(s,`[data-draft-id="${pluginId}"] [data-client-install]`)
 await poll(s,`window.moreThanChat.getClientPlugins().then(p=>p.find(v=>v.manifest.id==='${pluginId}')?.manifest.version===${JSON.stringify(version)})`);await closePanel(s)
}
async function inspectFrame(s,messageId){
 const end=Date.now()+8000;let error
 while(Date.now()<end){
  try{const value=await inspectFrameDocument(s,messageId);if(value?.heading)return value}catch(e){error=e}
  await delay(80)
 }
 throw Error('HTML frame did not finish loading: '+(error?.message||messageId))
}
async function inspectFrameDocument(s,messageId){
 const doc=await s.client.send('DOM.getDocument',{depth:-1,pierce:true}),found=await s.client.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:article(messageId)+' iframe'})
 const frame=(await s.client.send('DOM.describeNode',{nodeId:found.nodeId})).node.frameId
 // Sandboxed srcdoc can be an out-of-process iframe; attach to its own CDP target.
 let sessionId
 try{
  const targets=(await s.client.send('Target.getTargets')).targetInfos
  if(targets.some(t=>t.targetId===frame))sessionId=(await s.client.send('Target.attachToTarget',{targetId:frame,flatten:true})).sessionId
  const {executionContextId}=await s.client.send('Page.createIsolatedWorld',{frameId:frame,worldName:'message-qa'},sessionId)
  const value=await s.client.send('Runtime.evaluate',{contextId:executionContextId,expression:`({heading:document.querySelector('h2')?.textContent,scripts:document.querySelectorAll('script').length,html:document.body.innerHTML,color:getComputedStyle(document.body).color,background:getComputedStyle(document.body).backgroundColor})`,returnByValue:true},sessionId)
  return value.result.value
 }finally{if(sessionId)await s.client.send('Target.detachFromTarget',{sessionId})}
}
async function screenshot(s,name){await delay(300);const shot=await s.client.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(directory,name+'.png'),Buffer.from(shot.data,'base64'))}

try{
 const a=await launch('消息作者 A');let b=await launch('消息读者 B')
 await action(a,'friends/request',{userId:b.id});await action(b,'friends/accept',{userId:a.id});await openChat(a,b.id);await openChat(b,a.id)
 await sendText(a,'**双方都能看到粗体**\n\n|项目|值|\n|---|---|\n|进度|完成|')
 const md=await has(b,'**双方都能看到粗体**\n\n|项目|值|\n|---|---|\n|进度|完成|')
 for(const s of [a,b])await poll(s,`document.querySelector('${article(md.id)} strong')?.textContent==='双方都能看到粗体'&&!!document.querySelector('${article(md.id)} table')`)
 checks.push('normal composer sends Markdown; self and peer render the same bold text and table')
 await install(a)
 const html='<h2 style="color:#b54a2d">一条真正的 HTML 消息</h2><p>卡片正文与文字摘要分开保存。</p><script>top.__messageCodeExecuted=true</script><img src="https://example.com/tracker">'
 await sendCard(a,'HTML 卡片的文字摘要',html);const message=await has(b,'HTML 卡片的文字摘要')
 assert.deepEqual(message.content,{format:'html',version:1,body:html})
 await poll(a,`!!document.querySelector('${article(message.id)} iframe[data-html-message]')`)
 await poll(b,`!!document.querySelector('${article(message.id)} [data-message-fallback]')`)
 await screenshot(b,'01-fallback');await install(b)
 await poll(b,`!!document.querySelector('${article(message.id)} iframe[data-html-message]')`)
 const frame=await inspectFrame(b,message.id);assert.equal(frame.heading,'一条真正的 HTML 消息');assert.equal(frame.scripts,0);assert(!frame.html.includes('example.com'))
 assert.equal(await run(b,'Boolean(window.__messageCodeExecuted)'),false)
 for(const label of ['复制消息','引用回复','转发消息'])assert(await run(b,`!!document.querySelector('${article(message.id)} button[aria-label="${label}"]')`))
 await screenshot(b,'02-html-rendered')
 await run(b,`document.documentElement.dataset.theme='dark'`);await screenshot(b,'02-html-dark')
 const dark=await inspectFrame(b,message.id);assert.notEqual(dark.background,frame.background);assert.notEqual(dark.color,frame.color)
 await run(b,`document.documentElement.dataset.theme='light'`)
 checks.push('HTML editor/preview sends actual typed content; missing renderer shows summary; installing redraws history in a sandboxed HTML document; message actions remain')
 await sendCard(a,'再次发送同样的内容','<p>相同卡片</p>');await sendCard(a,'再次发送同样的内容','<p>相同卡片</p>')
 await poll(b,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().filter(m=>m.text==='再次发送同样的内容').length===2)`)
 await editCard(b,'重启与热更保留的草稿','<h2>未发送正文</h2>');await screenshot(b,'04-editor-draft');await closePanel(b)
 const source=(await run(b,'window.moreThanChat.getClientPlugins()')).find(p=>p.manifest.id===pluginId).program.code
 const wrapped=source.replace("'data-html-message': true","'data-html-message': true, 'data-renderer-version': '2'").replace('function Html(',"ctx.contribute(ctx.getService('ui.surfaces'), {id:'markdown-wrapper',surface:'message.body.markdown',render:({defaultView})=>h('section',{'data-markdown-wrapper':true},defaultView)});\n  function Html(")
 await update(b,'1.0.1',wrapped)
 await poll(b,`document.querySelectorAll('${article(message.id)} iframe[data-renderer-version="2"]').length===1`)
 await poll(b,`!!document.querySelector('${article(md.id)} [data-markdown-wrapper] table')`)
 await update(b,'1.0.2',source.replace("h(Html, { body: context.message.content.body })","(() => {throw new Error('renderer-fixture-failure')})()"))
 await poll(b,`!!document.querySelector('${article(message.id)} [data-message-fallback]')`)
 assert(await run(b,'!!document.querySelector(".composer textarea")'))
 await update(b,'1.0.3',source);await poll(b,`!!document.querySelector('${article(message.id)} iframe[data-html-message]')`)
 await expectDraft(b,'重启与热更保留的草稿','<h2>未发送正文</h2>')
 assert(await run(b,`!!document.querySelector('${article(md.id)} table')&&!document.querySelector('${article(md.id)} [data-markdown-wrapper]')`))
 await toggle(b,false);await close(b);b=await launch('消息读者 B');await openChat(b,a.id)
 await poll(b,`!!document.querySelector('${article(message.id)} [data-message-fallback]')`)
 await toggle(b,true);await poll(b,`!!document.querySelector('${article(message.id)} iframe[data-html-message]')`)
 await expectDraft(b,'重启与热更保留的草稿','<h2>未发送正文</h2>')
 checks.push('renderer hot update redraws once; user plugin wraps default Markdown and unload restores it; broken render falls back without breaking chat; disable survives restart; re-enable restores saved HTML')
 await click(b,`[data-quote-message="${message.id}"]`);await sendText(b,'引用卡片的回复');const quote=await has(a,'引用卡片的回复');assert.equal(quote.quote.text,'HTML 卡片的文字摘要')
 await action(a,'groups',{name:'格式消息测试群',memberIds:[b.id]});await poll(b,'window.moreThanChat.getServerState().then(s=>s.directory.groups.length===1)')
 const group=(await run(b,'window.moreThanChat.getServerState()')).directory.groups[0].id
 const target=(await run(b,'window.moreThanChat.loadState()')).conversations.find(c=>c.targetId===group).id
 await openChat(b,group,'groups');await expectDraft(b,'','');await editCard(b,'只属于群的草稿','<p>群草稿</p>');await openChat(b,a.id)
 await expectDraft(b,'重启与热更保留的草稿','<h2>未发送正文</h2>')
 await click(b,`[data-forward-message="${message.id}"]`);await click(b,`[data-forward-target="${target}"]`)
 await poll(a,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.forwarded?.messageId===${JSON.stringify(message.id)}))`)
 const forwarded=await run(a,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().find(m=>m.forwarded?.messageId===${JSON.stringify(message.id)}))`)
 assert.deepEqual(forwarded.content,message.content)
 await openChat(a,group,'groups');await poll(a,`!!document.querySelector('${article(forwarded.id)} iframe')`);await screenshot(a,'03-forwarded-group')
 await openChat(a,b.id);await click(a,`[data-retract-message="${message.id}"]`);await click(a,'[data-confirm-retract]')
 await poll(b,`window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().some(m=>m.id===${JSON.stringify(message.id)}&&m.retractedAt&&!m.content))`)
 await poll(b,`!!document.querySelector('${article(message.id)}[data-retracted-message]')&&!document.querySelector('${article(message.id)} iframe')`)
 checks.push('quote uses summary; group forwarding preserves format/body and renders; withdrawal removes body and renderer while independent forwarded copy remains')
 await close(b);await sendCard(a,'离线卡片','<h2>重启后送达</h2>');b=await launch('消息读者 B');await openChat(b,a.id);const offline=await has(b,'离线卡片')
 await poll(b,`!!document.querySelector('${article(offline.id)} iframe')`);assert.equal((await inspectFrame(b,offline.id)).heading,'重启后送达')
 checks.push('offline receiver restart delivers and renders the message with its original metadata')
 await b.client.send('Page.bringToFront');await run(b,'window.moreThanChat.focusChatWindow()');await poll(b,'window.moreThanChat.getWindowFocus()')
 await run(b,`document.querySelector('.jump-latest')?.click()`)
 await poll(b,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(offline.conversationId)})?.unread===0)`)
 checks.push('viewing formatted messages at the latest position clears unread counts')
 // A message plugin may replace the whole bubble without implementing timeline anchors.
 const full=source+`\n` // Insert into activate's existing scope, using the same ordinary package.
 await update(b,'1.0.4',full.replace('function Html(',"ctx.contribute(ctx.getService('ui.surfaces'), {id:'whole-message',surface:'message',render:({context})=>h('section',{'data-whole-message':true,style:{padding:'18px'}},context.message.text)});\n  function Html("))
 await poll(b,`document.querySelectorAll('${article(offline.id)}').length===1&&!!document.querySelector('${article(offline.id)} [data-whole-message]')`)
 assert(await run(b,`document.querySelector('${article(offline.id)}').getBoundingClientRect().height>0`))
 await update(b,'1.0.5',source);await poll(b,`!!document.querySelector('${article(offline.id)} iframe')`)
 await update(b,'1.0.6',source.replace('h(Panel, { context })',"(() => { throw new Error('launcher-fixture-failure') })()"))
 await poll(b,`!!document.querySelector('[data-ui-slot="chat.header"] .settings-error')`)
 await update(b,'1.0.7',source);await expectDraft(b,'重启与热更保留的草稿','<h2>未发送正文</h2>')
 assert.equal(await run(b,`document.querySelectorAll('[data-ui-slot="chat.header"] .settings-error').length`),0)
 checks.push('identical deliberate sends create two messages; unsent drafts survive hot update/restart and remain isolated by conversation; whole-message replacements keep a measurable timeline anchor')
 checks.push('a broken legacy slot launcher recovers immediately after installing a fixed version without restarting chat')

 const c=await launch('共享读者 C');await action(a,'friends/request',{userId:c.id});await action(c,'friends/accept',{userId:a.id})
 const sharedGroup=(await action(a,'groups',{name:'共享消息渲染',memberIds:[b.id,c.id]})).directory.groups.find(g=>g.name==='共享消息渲染').id
 await poll(b,`window.moreThanChat.getServerState().then(s=>s.directory.groups.some(g=>g.id===${JSON.stringify(sharedGroup)}))`)
 await openChat(b,sharedGroup,'groups');await sendCard(b,'先有消息后载入插件','<h2>共享渲染器历史卡片</h2>')
 await openChat(c,sharedGroup,'groups');const shared=await has(c,'先有消息后载入插件');await poll(c,`!!document.querySelector('${article(shared.id)} [data-message-fallback]')`)
 await panel(b);const select=`[data-client-plugin="${pluginId}"] [data-share-target]`
 await run(b,`(()=>{const n=document.querySelector(${JSON.stringify(select)});n.closest('details').open=true;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,${JSON.stringify(sharedGroup)});n.dispatchEvent(new Event('change',{bubbles:true}));})()`)
 await click(b,`[data-client-plugin="${pluginId}"] [data-share-submit]`)
 await poll(a,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.groupId===${JSON.stringify(sharedGroup)}&&p.status==='pending'))`)
 const proposal=(await run(a,'window.moreThanChat.getServerState()')).directory.plugins.find(p=>p.groupId===sharedGroup)
 await closePanel(a);await click(a,'button[title="联系人"]');await click(a,'[data-contacts-tab="requests"]');await click(a,`[data-group-plugin-review="${proposal.pack.id}"] [data-approve-group-plugin]`)
 await panel(c);await click(c,`[data-group-plugin-gate="${proposal.pack.id}"][data-plugin-scope="${sharedGroup}"] [data-enable-group-plugin]`);await closePanel(c)
 await poll(c,`!!document.querySelector('${article(shared.id)} iframe')`)
 assert.equal((await inspectFrame(c,shared.id)).heading,'共享渲染器历史卡片');assert.equal((await run(c,'window.moreThanChat.getClientPlugins()')).length,0)
 await sendCard(c,'由共享插件发出的卡片','<h2>群成员发送成功</h2>','group');await has(b,'由共享插件发出的卡片')
 await editCard(c,'共享草稿保留','<p>稍后发送</p>','group');await openChat(c,a.id)
 assert.equal(await run(c,`document.querySelectorAll('button[data-example-source="${pluginId}"]').length`),0)
 await openChat(c,sharedGroup,'groups');await expectDraft(c,'共享草稿保留','<p>稍后发送</p>','group');await screenshot(c,'05-shared-renderer')
 checks.push('ordinary group submission, administrator approval and member load render historical cards without a local install; shared composer sends real messages; leaving the group unloads the renderer and preserves its draft')
 passed=true
}finally{
 for(const s of sessions){await close(s);await writeFile(path.join(directory,s.name+'-'+sessions.indexOf(s)+'.log'),s.logs)}
 await server.close();await writeFile(path.join(directory,'report.json'),JSON.stringify({passed,checks},null,2));console.log(JSON.stringify({passed,directory,checks},null,2))
}
