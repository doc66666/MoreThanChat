import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {mkdtemp,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {createCentralServer} from '../apps/central-server/src/server.mjs'
import {directPluginScope} from '../packages/central-protocol/dist/index.js'
import {CdpClient,evaluate,waitForTarget,reservePort,waitForExit,delay} from './verify-plugin-ui.mjs'

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps/desktop'),packaged=process.env.MTC_TEST_PACKAGED_EXE,exe=packaged||createRequire(path.join(desktop,'package.json'))('electron')
const directory=await mkdtemp(path.join(root,'.artifacts/examples-ui-')),sessions=[],checks=[]
const server=createCentralServer({directory:path.join(directory,'central'),mode:'public',adminToken:'qa-example-library-only-not-production'})
const url='http://127.0.0.1:'+(await server.listen(0)).port
const game='example.tic-tac-toe',phrase='example.quick-phrases',timer='example.focus-timer',memory='example.memory-pairs'
let passed=false
const run=(s,code)=>evaluate(s.client,code)
async function poll(s,code){const end=Date.now()+20000;while(Date.now()<end){if(await run(s,code))return;await delay(75)}throw Error('Examples UI timeout: '+code)}
async function click(s,selector){await poll(s,`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await run(s,`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function input(s,selector,text){await run(s,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(text)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`)}
async function launch(name){
  const port=await reservePort(),child=spawn(exe,[`--remote-debugging-port=${port}`,...(packaged?[]:['.'])],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_ENABLE_DEMO_PLUGINS:'0',MTC_QA_USER_DATA_DIR:path.join(directory,name)},windowsHide:true,stdio:['ignore','pipe','pipe']})
  const s={name,child,logs:''};sessions.push(s);child.stdout.resume();child.stderr.on('data',d=>s.logs=(s.logs+d).slice(-20000))
  s.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  await poll(s,`document.querySelector('.host-status')?.dataset.hostState==='ready'&&!!document.querySelector('.composer textarea')`);return s
}
async function close(s){if(!s?.client)return;await Promise.race([run(s,'window.moreThanChat.quitApp()').catch(()=>{}),delay(1000)]);await waitForExit(s.child,8000);s.client.close();s.client=null;if(s.child.exitCode===null)s.child.kill()}
async function screenshot(s,name){await delay(350);await run(s,`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);const shot=await s.client.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(directory,name+'.png'),Buffer.from(shot.data,'base64'))}
async function closePanel(s){await run(s,`document.querySelector('.plugin-drawer .drawer-header button')?.click()`)}
async function plugins(s){await closeDialogs(s);await closePanel(s);await click(s,'button[title="插件"]');await poll(s,`document.querySelectorAll('[data-example-card]').length===5`)}
async function closeDialogs(s){await run(s,`document.querySelectorAll('dialog[open]').forEach(d=>d.close())`)}
const dlg=(id,scope='local')=>`dialog[data-example-source="${id}"][data-example-scope="${scope}"]`
async function openExample(s,id,scope='local'){
  await closePanel(s);await closeDialogs(s)
  await click(s,`button[data-example-source="${id}"][data-example-scope="${scope}"]`)
  await poll(s,`document.querySelector(${JSON.stringify(dlg(id,scope))})?.open`)
}
const state=s=>run(s,'window.moreThanChat.getServerState()')
const action=(s,route,data)=>run(s,`window.moreThanChat.serverAction(${JSON.stringify(route)},${JSON.stringify(data)})`)
async function connect(s){await run(s,`window.moreThanChat.connectServer(${JSON.stringify(url)},${JSON.stringify(s.name)})`);s.id=(await state(s)).userId}
async function openChat(s,target,kind='group'){
  await closeDialogs(s);await closePanel(s);await click(s,'button[title="联系人"]');await click(s,`[data-contacts-tab="${kind==='group'?'groups':'friends'}"]`)
  await click(s,`[data-contact-${kind==='group'?'group':'chat'}="${target}"]`)
}
async function share(s,scope){
  await plugins(s);const selector=`[data-client-plugin="${game}"] [data-share-target]`
  await poll(s,`!!document.querySelector(${JSON.stringify(selector)})`)
  await run(s,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.closest('details').open=true;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,${JSON.stringify(scope)});n.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await click(s,`[data-client-plugin="${game}"] [data-share-submit]`)
  await poll(s,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.groupId===${JSON.stringify(scope)}&&p.status==='pending'))`)
  return (await state(s)).directory.plugins.find(p=>p.groupId===scope&&p.status==='pending')
}
async function approve(s,p){await closeDialogs(s);await closePanel(s);await click(s,'button[title="联系人"]');await click(s,'[data-contacts-tab="requests"]');await click(s,`[data-group-plugin-review="${p.pack.id}"] [data-approve-group-plugin]`);await poll(s,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.digest===${JSON.stringify(p.digest)}&&p.groupId===${JSON.stringify(p.groupId)}&&p.status==='approved'))`)}
async function load(s,p){await plugins(s);await click(s,`[data-group-plugin-gate="${p.pack.id}"][data-plugin-scope="${p.groupId}"][data-plugin-digest="${p.digest}"] [data-enable-group-plugin]`);await openExample(s,game,p.groupId.startsWith('dm_')?'direct':'group')}
async function board(s,scope,text){await poll(s,`[...document.querySelectorAll(${JSON.stringify(dlg(game,scope)+' [data-ttt-cell]')})].map(n=>n.textContent).join('')===${JSON.stringify(text)}`)}
const move=(s,scope,cell)=>click(s,dlg(game,scope)+` [data-ttt-cell="${cell}"]`)
async function join(s,scope){await click(s,dlg(game,scope)+' [data-ttt-join]');await poll(s,`!document.querySelector(${JSON.stringify(dlg(game,scope)+' [data-ttt-join]')})?.textContent.includes('处理中')`)}

try{
  let a=await launch('示例玩家 A')
  assert.equal((await run(a,'window.moreThanChat.getClientPlugins()')).length,0,'No sample should be installed on a fresh profile')
  await plugins(a);await screenshot(a,'01-library')
  for(const id of [phrase,timer,memory,game]){
    await click(a,`[data-example-card="${id}"] [data-example-install]`)
    await poll(a,`document.querySelector('[data-example-card="${id}"] [data-example-install]')?.textContent==='已安装'`)
  }
  await click(a,`[data-example-card="${phrase}"] [data-example-copy]`)
  await poll(a,`window.moreThanChat.inspectPluginDrafts().then(s=>s.drafts.some(d=>d.id.startsWith('${phrase}.copy-')&&d.ok))`)
  const copied=(await run(a,'window.moreThanChat.inspectPluginDrafts()')).drafts.find(d=>d.id.startsWith(phrase+'.copy-'))
  assert(copied.ok);assert.equal((await run(a,'window.moreThanChat.getClientPlugins()')).length,4)
  checks.push('clean profile has no automatic installs; gallery installs four ordinary executable packages and copies an independent valid AI-editable draft')
  const beforeMessages=await run(a,'window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().length)')
  await closePanel(a);await input(a,'.composer textarea','已有内容')
  await openExample(a,phrase);await input(a,'[data-phrase-input]','测试短语，重启后仍保留');await click(a,'[data-phrase-add]')
  await click(a,'[data-phrase-insert="3"]');await poll(a,`document.querySelector('.composer textarea').value===${JSON.stringify('已有内容\n测试短语，重启后仍保留')}`)
  assert.equal(await run(a,'window.moreThanChat.loadState().then(s=>Object.values(s.messages).flat().length)'),beforeMessages)
  await openExample(a,timer);await click(a,'[data-focus-toggle]');await closeDialogs(a);await delay(1200)
  await openExample(a,timer);assert.notEqual(await run(a,`document.querySelector('[data-focus-clock]').textContent`),'25:00')
  await screenshot(a,'02-focus')
  await openExample(a,memory)
  const known=new Map()
  for(let turn=0;turn<40;turn++){
    const cells=await run(a,`[...document.querySelectorAll('[data-memory-cell]')].map(n=>({i:Number(n.dataset.memoryCell),disabled:n.disabled,text:n.textContent}))`)
    const available=cells.filter(c=>!c.disabled)
    if(!available.length)break
    let first=available.find(c=>!known.has(c.i))??available[0]
    // Prefer a pair already learned from earlier flips.
    let pair
    for(const c of available){const other=available.find(o=>o.i!==c.i&&known.has(c.i)&&known.get(o.i)===known.get(c.i));if(other){first=c;pair=other;break}}
    await click(a,`[data-memory-cell="${first.i}"]`);known.set(first.i,await run(a,`document.querySelector('[data-memory-cell="${first.i}"]').textContent`))
    pair??=available.find(c=>c.i!==first.i&&known.get(c.i)===known.get(first.i))??available.find(c=>c.i!==first.i&&!known.has(c.i))??available.find(c=>c.i!==first.i)
    await click(a,`[data-memory-cell="${pair.i}"]`);known.set(pair.i,await run(a,`document.querySelector('[data-memory-cell="${pair.i}"]').textContent`))
    await delay(760)
  }
  await poll(a,`document.querySelector('[data-memory-status]').textContent.includes('全部配对')`);await screenshot(a,'03-memory-win')
  await openExample(a,game);await join(a,'local');await join(a,'local');await move(a,'local',0);await board(a,'local','X········')
  await close(a);a=await launch('示例玩家 A')
  await openExample(a,phrase);assert(await run(a,`document.querySelector('${dlg(phrase)}').textContent.includes('测试短语，重启后仍保留')`))
  await openExample(a,timer);assert.notEqual(await run(a,`document.querySelector('[data-focus-clock]').textContent`),'25:00');await click(a,'[data-focus-toggle]')
  await openExample(a,memory);assert(!(await run(a,`document.querySelector('${dlg(memory)}').textContent`)).includes('最佳 —'))
  await openExample(a,game);await board(a,'local','X········')
  checks.push('real UI: phrases append without sending; timer continues while closed and across restart; memory game completes and saves best score; local game survives restart')
  await closeDialogs(a);await connect(a)
  const b=await launch('示例玩家 B');await connect(b);let c=await launch('示例玩家 C');await connect(c)
  for(const [from,to] of [[a,b],[a,c],[b,c]]){await action(from,'friends/request',{userId:to.id});await action(to,'friends/accept',{userId:from.id})}
  await action(b,'groups',{name:'示例联机验收',memberIds:[a.id,c.id]});await poll(a,'window.moreThanChat.getServerState().then(s=>s.directory.groups.length===1)')
  const group=(await state(a)).directory.groups[0].id,p=await share(a,group)
  await approve(b,p);for(const s of [a,b,c])await openChat(s,group)
  assert.equal(await run(c,`document.querySelectorAll('button[data-example-scope="group"]').length`),0,'Approval must not auto-load code')
  await load(a,p);await load(b,p)
  await join(a,'group');await poll(b,`document.querySelector('${dlg(game,'group')} [data-ttt-seats]').textContent.includes('示例玩家 A')`)
  await join(b,'group')
  for(const [s,cell] of [[a,0],[b,3],[a,1],[b,4],[a,2]]){await move(s,'group',cell);await poll(s,`document.querySelector('${dlg(game,'group')} [data-ttt-cell="${cell}"]').textContent!=='·'`)}
  await board(a,'group','XXXOO····');await board(b,'group','XXXOO····')
  await load(c,p);await board(c,'group','XXXOO····');await click(c,dlg(game,'group')+' [data-ttt-reset]');await board(a,'group','·········')
  await join(c,'group');await poll(a,`document.querySelector('${dlg(game,'group')} [data-ttt-seats]').textContent.includes('示例玩家 C')`);await join(a,'group');await move(c,'group',4);await board(a,'group','····X····')
  await screenshot(a,'04-shared-game')
  await close(c);await move(a,'group',0)
  c=await launch('示例玩家 C');await connect(c);await openChat(c,group);await openExample(c,game,'group');await board(c,'group','O···X····')
  checks.push('three real clients: group application, admin approval, explicit member load, multiplayer win, late spectator sync, new round releases both seats, third player joins; restart receives offline move')
  const direct=directPluginScope(a.id,b.id),dm=await share(a,direct);await approve(b,dm);await openChat(a,b.id,'direct');await openChat(b,a.id,'direct');await load(a,dm);await load(b,dm)
  await board(a,'direct','·········');await join(a,'direct');await poll(b,`document.querySelector('${dlg(game,'direct')} [data-ttt-seats]').textContent.includes('示例玩家 A')`);await join(b,'direct');await move(a,'direct',8);await board(b,'direct','········X')
  await openExample(a,game,'local');await board(a,'local','X········');await board(c,'group','O···X····')
  checks.push('friend approval and real direct play use the same package; local, group and direct boards are isolated')
  await closeDialogs(a);await a.client.send('Page.bringToFront')
  await poll(a,'window.moreThanChat.getWindowFocus()')
  await run(a,`(()=>{const n=document.querySelector('.message-scroll');n.scrollTop=n.scrollHeight;n.dispatchEvent(new Event('scroll'));})()`)
  const aChat=(await run(a,'window.moreThanChat.loadState()')).conversations.find(v=>v.targetId===b.id).id
  const bChat=(await run(b,'window.moreThanChat.loadState()')).conversations.find(v=>v.targetId===a.id).id
  const sendText=text=>run(b,`window.moreThanChat.sendCentralMessage(${JSON.stringify({conversationId:bChat,clientMessageId:crypto.randomUUID(),text})})`)
  await sendText('小窗打开前正常阅读')
  await poll(a,`window.moreThanChat.loadState().then(s=>s.messages[${JSON.stringify(aChat)}]?.some(m=>m.text==='小窗打开前正常阅读')&&s.conversations.find(c=>c.id===${JSON.stringify(aChat)}).unread===0)`)
  await openExample(a,phrase);await delay(250);await sendText('小窗遮挡时应保持未读')
  await poll(a,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(aChat)}).unread>0)`)
  await closeDialogs(a)
  await poll(a,`window.moreThanChat.loadState().then(s=>s.conversations.find(c=>c.id===${JSON.stringify(aChat)}).unread===0)`)
  checks.push('focused latest chat stays unread while a plugin dialog covers it, then reads normally when the dialog closes')
  await plugins(a)
  const pack=(await run(a,'window.moreThanChat.getClientPlugins()')).find(p=>p.manifest.id===phrase)
  const manifest={...pack.manifest,version:'1.0.1'}
  await run(a,`window.moreThanChat.createPluginDraft(${JSON.stringify({manifestJson:JSON.stringify(manifest),source:JSON.stringify(pack.program)})})`)
  await closePanel(a);await plugins(a);await poll(a,`!!document.querySelector('[data-draft-id="${phrase}"] [data-client-install]')`);await click(a,`[data-draft-id="${phrase}"] [data-client-install]`)
  await poll(a,`window.moreThanChat.getClientPlugins().then(p=>p.find(v=>v.manifest.id==='${phrase}')?.manifest.version==='1.0.1')`)
  assert.equal(await run(a,`document.querySelectorAll('button[data-example-open="${phrase}"]').length`),1)
  assert.equal(await run(a,`document.querySelector('[data-example-card="${phrase}"] [data-example-install]').disabled`),true)
  await closePanel(a);await openExample(a,phrase);await screenshot(a,'05-phrases')
  await a.client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await a.client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await poll(a,`!document.querySelector('${dlg(phrase)}').open`)
  await plugins(a);await run(a,`document.documentElement.dataset.theme='dark'`);await screenshot(a,'06-library-dark')
  await click(a,`[data-client-plugin="${memory}"] [data-client-uninstall]`)
  await poll(a,`window.moreThanChat.getClientPlugins().then(p=>!p.some(v=>v.manifest.id==='${memory}'))`)
  assert.equal(await run(a,`document.querySelectorAll('button[data-example-open="${memory}"]').length`),0)
  checks.push('ordinary draft hot-update keeps one launcher; gallery never overwrites installed edits; Escape closes dialog; uninstall removes owned UI; light/dark screenshots recorded')
  passed=true
}finally{
  for(const s of sessions){await close(s);await writeFile(path.join(directory,s.name+'-'+sessions.indexOf(s)+'.log'),s.logs)}
  await server.close()
  await writeFile(path.join(directory,'report.json'),JSON.stringify({passed,packaged:Boolean(packaged),checks},null,2))
  console.log(JSON.stringify({passed,directory,checks},null,2))
}
