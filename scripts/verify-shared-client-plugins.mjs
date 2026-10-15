import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {createCentralServer} from '../apps/central-server/src/server.mjs'
import {directPluginScope} from '../packages/central-protocol/dist/index.js'
import {CdpClient,evaluate,reservePort,waitForTarget,waitForExit,delay} from './verify-plugin-ui.mjs'

const root=path.resolve(import.meta.dirname,'..'),desktop=path.join(root,'apps/desktop')
await mkdir(path.join(root,'.artifacts'),{recursive:true})
const directory=await mkdtemp(path.join(root,'.artifacts/shared-client-flow-'))
const executable=process.env.MTC_TEST_PACKAGED_EXE||createRequire(path.join(desktop,'package.json'))('electron')
const pack=JSON.parse(await readFile(path.join(root,'examples/shared-tic-tac-toe.mtcplugin'),'utf8'))
let authoredPack=pack,modelRequests=0,modelError=null
// Deterministic OpenAI-compatible model fixture exercises the actual chat/tool loop.
// This is not a claim that a live DeepSeek model authored this fixture.
const modelServer=createServer(async(req,res)=>{
  try {
    let body='';for await(const chunk of req)body+=chunk
    const parsed=JSON.parse(body);modelRequests++
    assert(parsed.messages.some(m=>m.role==='system'&&m.content.includes('sdk.network.send')&&m.content.includes('私聊')),'Missing built-in executable author contract')
    const tools=parsed.messages.filter(m=>m.role==='tool')
    const updating=authoredPack.manifest.version!=='0.1.0'
    // Twelve tool rounds plus the tools-disabled summary, all reporting usage.
    // v0.2.1 passed no-usage fixtures but killed Host on this completion event.
    const steps=updating?['inspect_drafts','create_draft','validate_draft',...Array(9).fill('inspect_drafts')]:['create_draft','validate_draft',...Array(10).fill('inspect_drafts')],tool=steps[tools.length]
    if(tools.length===12)assert.equal(parsed.tools,undefined,'Summary must disable tools')
    const baseRevision=updating&&tools.length?JSON.parse(tools[0].content).draft.revision:0
    const args=tool==='create_draft'?{manifest:authoredPack.manifest,code:authoredPack.program.code,baseRevision}:{draftId:pack.manifest.id}
    const delta=tool?{tool_calls:[{index:0,id:'shared-'+modelRequests,function:{name:tool,arguments:JSON.stringify(args)}}]}:{content:'已创建并校验可执行井字棋草稿。可本机安装或申请分享到好友／群聊。'}
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: ${JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}})}\n\ndata: [DONE]\n\n`)
  }catch(error){modelError=String(error);res.writeHead(500);res.end('Model fixture failed')}
})
await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve))
const server=createCentralServer({directory:path.join(directory,'server'),mode:'public',adminToken:'qa-shared-plugins-only-not-production'})
const address=await server.listen(0),url='http://127.0.0.1:'+address.port,sessions=[],evidence=[]
let passed=false
function limit(promise,ms=15000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CDP deadline')),ms)})]).finally(()=>clearTimeout(timer))}
async function value(session,expression){return limit(evaluate(session.client,expression))}
async function poll(session,expression){const end=Date.now()+20000;while(Date.now()<end){if(await value(session,expression))return;await delay(80)}throw Error('UI timeout: '+expression)}
async function click(s,selector){await poll(s,`Boolean(document.querySelector(${JSON.stringify(selector)}))&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await value(s,`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function launch(name){
  const port=await reservePort(),child=spawn(executable,[`--remote-debugging-port=${port}`,'.'],{cwd:desktop,env:{...process.env,MTC_QA_MODE:'1',MTC_QA_USER_DATA_DIR:path.join(directory,name)},windowsHide:true,stdio:['ignore','pipe','pipe']})
  const s={child,name,errors:[]};sessions.push(s);child.stdout.resume();child.stderr.setEncoding('utf8');child.stderr.on('data',c=>s.errors.push(c))
  s.client=await CdpClient.connect((await waitForTarget(port)).webSocketDebuggerUrl)
  await poll(s,`document.querySelector('.host-status')?.dataset.hostState==='ready'`)
  await value(s,`window.moreThanChat.connectServer(${JSON.stringify(url)},${JSON.stringify(name)})`)
  s.id=(await state(s)).userId;return s
}
const state=s=>value(s,'window.moreThanChat.getServerState()')
const action=(s,route,data)=>value(s,`window.moreThanChat.serverAction(${JSON.stringify(route)},${JSON.stringify(data)})`)
async function closePanel(s){await value(s,`document.querySelector('.plugin-drawer .drawer-header button')?.click()`)}
async function plugins(s){await closePanel(s);await click(s,'button[title="插件"]');await poll(s,'Boolean(document.querySelector("[data-client-plugins]"))')}
async function open(s,target,kind='group') {await closePanel(s);await click(s,'button[title="联系人"]');await click(s,`[data-${kind==='group'?'group':'friend'}="${target}"]`)}
async function createDraft(s,p){
  authoredPack=p
  const generation=await value(s,"document.querySelector('.host-status').dataset.hostGeneration")
  await closePanel(s)
  await value(s,`window.moreThanChat.setModelSettings({baseUrl:'http://127.0.0.1:${modelServer.address().port}',model:'qa-executable-author',providerMode:'openai-compatible',apiKey:'qa-only-shared-model-token'})`)
  await value(s,`[...document.querySelectorAll('.conversation-item')].find(n=>n.textContent.includes('More AI')).click()`)
  await value(s,`(()=>{window.__sharedTerminal=null;window.__sharedTools=[];window.moreThanChat.onModelChatEvent(e=>{if(e.type==='author-tool')window.__sharedTools.push(e);if(['completed','failed','cancelled'].includes(e.type))window.__sharedTerminal=e;});const node=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,'创建或更新可执行共享井字棋 ${p.manifest.version}，用于本机、群聊和私聊；调用作者工具并校验草稿。');node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await click(s,'.send-button');await poll(s,'Boolean(window.__sharedTerminal)')
  const terminal=await value(s,'window.__sharedTerminal')
  assert.equal(terminal.type,'completed',modelError||'Model loop failed')
  assert.deepEqual(terminal.usage,{inputTokens:130,outputTokens:52,totalTokens:182,reportedRequests:13,requestCount:13})
  assert.equal(await value(s,"document.querySelector('.host-status').dataset.hostGeneration"),generation,'Host restarted during authoring')
  assert.equal(await value(s,"document.querySelector('.host-status').dataset.hostState"),'ready')
  const tools=await value(s,'window.__sharedTools')
  for(const tool of ['create_draft','validate_draft'])assert(tools.some(e=>e.tool===tool&&e.phase==='finished'&&e.ok),'Tool did not succeed: '+tool)
  const draft=(await value(s,'window.moreThanChat.inspectPluginDrafts()')).drafts.find(d=>d.id===p.manifest.id)
  assert(draft?.ok);s.revision=draft.revision
}
async function share(s,scope,fromInstalled=false){
  await plugins(s)
  const parent=fromInstalled?`[data-client-plugin="${pack.manifest.id}"]`:`[data-draft-id="${pack.manifest.id}"]`
  if(!fromInstalled)await poll(s,`document.querySelector(${JSON.stringify(parent+' small')})?.textContent.includes('r${s.revision} ·')`)
  const select=parent+' [data-share-target]'
  await poll(s,`Boolean(document.querySelector(${JSON.stringify(select)}))`)
  await value(s,`(()=>{const panel=document.querySelector(${JSON.stringify(parent+' [data-share-client]')});panel.open=true;const node=document.querySelector(${JSON.stringify(select)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(node,${JSON.stringify(scope)});node.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await click(s,parent+' [data-share-submit]')
  await poll(s,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.groupId===${JSON.stringify(scope)}&&p.status==='pending'))`)
  await closePanel(s)
  return (await state(s)).directory.plugins.filter(p=>p.groupId===scope&&p.status==='pending').at(-1)
}
async function approve(s,p){await closePanel(s);await click(s,'button[title="联系人"]');await click(s,`[data-group-plugin-review="${p.pack.id}"] [data-approve-group-plugin]`);await poll(s,`window.moreThanChat.getServerState().then(s=>s.directory.plugins.some(p=>p.groupId===${JSON.stringify(p.groupId)}&&p.digest===${JSON.stringify(p.digest)}&&p.status==='approved'))`);await closePanel(s)}
function gate(p){return `[data-group-plugin-gate="${p.pack.id}"][data-plugin-scope="${p.groupId}"][data-plugin-digest="${p.digest}"]`}
async function load(s,p){await plugins(s);await click(s,`${gate(p)} [data-enable-group-plugin]`);await closePanel(s);await poll(s,`document.querySelector('[data-shared-game]')?.dataset.sharedGame===${JSON.stringify(p.groupId.startsWith('dm_')?'direct':'group')}`)}
async function board(s,text){await poll(s,`[...document.querySelectorAll('[data-shared-cell]')].map(n=>n.textContent).join('')===${JSON.stringify(text)}`)}
async function close(s){if(s.client){try{await limit(s.client.send('Browser.close'),1000)}catch{}s.client.close();s.client=null}await waitForExit(s.child,5000);if(s.child.exitCode===null)s.child.kill()}
try{
  const a=await launch('插件作者 A'),b=await launch('管理员 B'),c=await launch('成员 C')
  for(const peer of [b,c]){await action(a,'friends/request',{userId:peer.id});await action(peer,'friends/accept',{userId:a.id})}
  await action(b,'friends/request',{userId:c.id});await action(c,'friends/accept',{userId:b.id})
  await action(b,'groups',{name:'可执行插件验收群',memberIds:[a.id,c.id]})
  await poll(a,'window.moreThanChat.getServerState().then(s=>s.directory.groups.length===1)')
  const group=(await state(a)).directory.groups[0].id
  await createDraft(a,pack);await plugins(a);await click(a,`[data-draft-id="${pack.manifest.id}"] [data-client-install]`)
  await poll(a,`document.querySelector('[data-shared-game]')?.dataset.sharedGame==='local'`)
  await closePanel(a);await click(a,'[data-shared-join]');await click(a,'[data-shared-join]');await click(a,'[data-shared-cell="0"]');await board(a,'X········')
  evidence.push('same executable source: user-profile draft, one-click local install, real ESM full-root UI and local play')
  const proposal=await share(a,group,true)
  assert.equal((await state(c)).directory.plugins.filter(p=>p.status==='approved').length,0)
  await approve(b,proposal)
  for(const s of [a,b,c])await open(s,group)
  assert.equal(await value(c,'Boolean(document.querySelector("[data-shared-game]"))'),false)
  await load(a,proposal);await load(b,proposal)
  await open(a,c.id,'direct');await poll(a,`document.querySelector('[data-shared-game]')?.dataset.sharedGame==='local'`)
  await open(a,group);await poll(a,`document.querySelector('[data-shared-game]')?.dataset.sharedGame==='group'`)
  evidence.push('local and shared can stay enabled together: selected conversation shadows local UI, leaving restores local, neither overwrites source')
  await plugins(a);await click(a,`[data-client-plugin="${pack.manifest.id}"] .draft-actions button`);await closePanel(a)
  await poll(a,`document.querySelector('[data-shared-game]')?.dataset.sharedGame==='group'`)
  await click(a,'[data-shared-join]');await poll(b,'document.querySelector("[data-game-status]")?.textContent.includes("1/2")')
  await click(b,'[data-shared-join]');await poll(a,'document.querySelector("[data-game-status]")?.textContent.includes("2/2")')
  for(const [s,cell] of [[a,0],[b,3],[a,1],[b,4],[a,2]]){await click(s,`[data-shared-cell="${cell}"]`);await poll(s,`document.querySelector('[data-shared-cell="${cell}"]').textContent!=='·'`)}
  await board(a,'XXXOO····');await board(b,'XXXOO····')
  await load(c,proposal);await board(c,'XXXOO····')
  await click(c,'[data-shared-reset]');await poll(a,'document.querySelector("[data-game-status]")?.textContent.includes("0/2")')
  await click(c,'[data-shared-join]');await poll(a,'document.querySelector("[data-game-status]")?.textContent.includes("1/2")');await click(a,'[data-shared-join]');await poll(c,'document.querySelector("[data-game-status]")?.textContent.includes("2/2")')
  await click(c,'[data-shared-cell="8"]');await board(a,'········X')
  evidence.push('group: author submits installed code, admin approves, no auto-execution, members choose load, real multiplayer moves/win, late join, new round releases seats to third player')
  const direct=directPluginScope(a.id,b.id),dm=await share(a,direct)
  await assert.rejects(()=>action(a,'plugins/review',{groupId:direct,pluginId:dm.pack.id,version:dm.pack.version,digest:dm.digest,approve:true}),/对方|自行/)
  await approve(b,dm);await open(a,b.id,'direct');await open(b,a.id,'direct')
  await poll(a,'!document.querySelector("[data-shared-game]")');await load(a,dm);await load(b,dm)
  await board(a,'·········');await click(a,'[data-shared-join]');await poll(b,'document.querySelector("[data-game-status]")?.textContent.includes("1/2")');await click(b,'[data-shared-join]');await poll(a,'document.querySelector("[data-game-status]")?.textContent.includes("2/2")')
  await click(a,'[data-shared-cell="4"]');await board(b,'····X····');await board(c,'········X')
  evidence.push('direct: peer-only approval, independent per-device load, same full-root plugin and relay API, direct/group/local state isolation')
  await close(b)
  await click(a,'[data-shared-leave]')
  const b2=await launch('管理员 B');assert.equal(b2.id,b.id);await open(b2,a.id,'direct');await poll(b2,'Boolean(document.querySelector("[data-shared-game]"))');await board(b2,'·········')
  evidence.push('restart/offline: local load choice persists, undelivered events replay after reconnect')
  const next=structuredClone(pack);next.manifest.version='0.2.0';next.program.code=next.program.code.replace("'共享井字棋'","'共享井字棋 v2'")
  await createDraft(a,next);const upgrade=await share(a,direct);await approve(b2,upgrade);await open(a,b2.id,'direct')
  await poll(a,'!document.querySelector("[data-shared-game]")');await poll(b2,'!document.querySelector("[data-shared-game]")')
  await load(a,upgrade);await load(b2,upgrade);await poll(b2,'document.querySelector("[data-shared-game]")?.textContent.includes("v2")')
  assert.equal(await value(b2,'document.querySelectorAll("[data-shared-game]").length'),1)
  await plugins(b2);await click(b2,`${gate(upgrade)} [data-disable-group-plugin]`);await closePanel(b2);await poll(b2,'!document.querySelector("[data-shared-game]")')
  assert.equal(await value(b2,`window.moreThanChat.groupPluginConsent(${JSON.stringify({groupId:direct,pluginId:upgrade.pack.id,digest:upgrade.digest})})`),'declined')
  assert.equal(await value(b2,`window.moreThanChat.groupPluginConsent(${JSON.stringify({groupId:group,pluginId:proposal.pack.id,digest:proposal.digest})})`),'loaded','Stopping the direct instance must not stop the same plugin in the group')
  assert.equal(await value(a,'Boolean(document.querySelector("[data-shared-game]"))'),true)
  evidence.push('upgrade: old executable stops, new exact version individually loaded, no duplicate root; member unload does not unload peer')
  await open(a,group);await poll(a,'Boolean(document.querySelector("[data-shared-game]"))');await board(a,'········X')
  const capture=await a.client.send('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(path.join(directory,'group-game.png'),Buffer.from(capture.data,'base64'))
  await writeFile(path.join(root,'.artifacts',process.env.MTC_TEST_PACKAGED_EXE?'shared-client-packaged.png':'shared-client.png'),Buffer.from(capture.data,'base64'))
  await action(a,'friends/remove',{userId:b2.id});await open(a,c.id,'direct');await poll(a,'!document.querySelector("[data-shared-game]")')
  evidence.push('switching conversations removes owned UI; ending friendship removes shared direct approval')
  passed=true
}finally{
  for(const s of sessions)await close(s)
  await server.close()
  await new Promise(resolve=>modelServer.close(resolve))
  const report={passed,packaged:Boolean(process.env.MTC_TEST_PACKAGED_EXE),model:'deterministic OpenAI-compatible fixture (not live DeepSeek)',modelRequests,modelError,evidence}
  await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2))
  await writeFile(path.join(root,'.artifacts',process.env.MTC_TEST_PACKAGED_EXE?'shared-client-packaged-acceptance.json':'shared-client-acceptance.json'),JSON.stringify(report,null,2))
  for(const s of sessions)await writeFile(path.join(directory,s.name+'-'+sessions.indexOf(s)+'.log'),s.errors.join(''))
  console.log(JSON.stringify({passed,directory,evidence},null,2))
}
