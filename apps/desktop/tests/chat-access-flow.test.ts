import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { AttachmentStore } from '../src/main/attachments'
import { ClientIdentity } from '../src/main/identity-store'
import { CentralClient } from '../src/main/central-client'
import { createChatAccess } from '../src/main/chat-access'
import { createCentralServer } from '../../central-server/src/server.mjs'

const cipher={available:()=>true,encrypt:(value:string)=>Buffer.from(value),decrypt:(value:Buffer)=>value.toString()}
async function until(check:()=>boolean){const deadline=Date.now()+9000;while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,20))}throw Error('Chat API flow timeout')}
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mtc-chat-api-flow-')),clients:CentralClient[]=[],stores:ChatStore[]=[],servers:ReturnType<typeof createCentralServer>[]=[]
 return {
  async member(label:string){
   const dir=path.join(root,label),store=await ChatStore.open(dir),files=new AttachmentStore(path.join(dir,'files'));stores.push(store);store.save(createSeedState())
   const client=new CentralClient(await ClientIdentity.load(dir,cipher),store,files,dir);clients.push(client)
   const access=createChatAccess(store,files,request=>client.send(request))
   return {client,store,files,read:async(request:unknown)=>JSON.parse((await access(request)).dataJson)}
  },
  async server(label:string){const app=createCentralServer({directory:path.join(root,label),mode:'public',adminToken:'qa-only-api-flow-admin-token-0001'});servers.push(app);return {app,url:'http://127.0.0.1:'+(await app.listen(0)).port}},
  async close(){vi.restoreAllMocks();for(const client of clients)await client.disconnect(false);for(const app of servers)await app.close();for(const store of stores)store.close();await rm(root,{recursive:true,force:true})},
 }
}
type Member=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['member']>>
async function friend(a:Member,b:Member){await a.client.action('friends/request',{userId:b.client.identity.userId});await b.client.action('friends/accept',{userId:a.client.identity.userId})}
const request=(conversationId:string,clientMessageId:string,text:string)=>({action:'send',conversationId,clientMessageId,text})

it('addresses same-name friends and groups by exact IDs, reads both servers locally, and queues only for the selected target server',async()=>{
 const f=await fixture()
 try{
  const a=await f.member('a'),b=await f.member('b'),c=await f.member('c'),first=await f.server('first'),second=await f.server('second')
  await a.client.connect(first.url,'A');await b.client.connect(first.url,'同名好友');await c.client.connect(first.url,'同名好友')
  await friend(a,b);await friend(a,c)
  const firstGroup=(await a.client.action('groups',{name:'同名群',memberIds:[b.client.identity.userId,c.client.identity.userId]})).directory!.groups[0]!
  const nextDirectory=(await a.client.action('groups',{name:'同名群',memberIds:[c.client.identity.userId]})).directory!
  const otherGroup=nextDirectory.groups.find(g=>g.id!==firstGroup.id)!
  const conversations=(await a.read({action:'list'})).conversations as {id:string;title:string;targetId:string}[]
  expect(conversations.filter(entry=>entry.title==='同名好友')).toHaveLength(2)
  expect(conversations.filter(entry=>entry.title==='同名群')).toHaveLength(2)
  const direct=conversations.find(entry=>entry.targetId===b.client.identity.userId)!.id
  const group=conversations.find(entry=>entry.targetId===firstGroup.id)!.id
  const other=conversations.find(entry=>entry.targetId===otherGroup.id)!.id
  await until(()=>Boolean(b.store.conversation(group)&&c.store.conversation(other)))
  await a.read(request(direct,'direct-only','只给指定好友'))
  await a.read(request(group,'group-only','只给指定群'))
  await until(()=>Boolean(b.store.messageByClient(first.app.serverId,a.client.identity.userId,'direct-only')&&b.store.messageByClient(first.app.serverId,a.client.identity.userId,'group-only')&&c.store.messageByClient(first.app.serverId,a.client.identity.userId,'group-only')))
  expect(c.store.messageByClient(first.app.serverId,a.client.identity.userId,'direct-only')).toBeUndefined()
  expect((await c.read({action:'history',conversationId:other})).messages).toEqual([])
  const unread=b.store.conversation(group)?.unread
  expect((await b.read({action:'history',conversationId:group})).messages[0].text).toBe('只给指定群')
  expect(b.store.conversation(group)?.unread).toBe(unread);expect(b.store.pendingReads(first.app.serverId)).toEqual([])

  await a.client.connect(second.url,'A');await b.client.connect(second.url,'同名好友');await friend(a,b)
  const secondGroup=(await a.client.action('groups',{name:'同名群',memberIds:[b.client.identity.userId]})).directory!.groups[0]!
  const all=(await a.read({action:'list'})).conversations as {id:string;serverId:string;targetId:string}[]
  const newDirect=all.find(entry=>entry.serverId===second.app.serverId&&entry.targetId===b.client.identity.userId)!.id
  const newGroup=all.find(entry=>entry.serverId===second.app.serverId&&entry.targetId===secondGroup.id)!.id
  expect(newDirect).not.toBe(direct);expect(newGroup).not.toBe(group)
  for(const [id,key] of [[direct,'old-dm'],[group,'old-group']])expect(await a.read(request(id!,key!,'旧服待发'))).toMatchObject({queued:true})
  expect(a.store.outbox(first.app.serverId)).toHaveLength(2)
  expect(second.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(0)
  // Stored history remains readable while connected elsewhere, and ID routing is never by name.
  expect((await a.read({action:'history',conversationId:group,after:-1})).messages[0].text).toBe('只给指定群')
  await a.read(request(newDirect,'new-dm','新服私聊'))
  await a.read(request(newGroup,'new-group','新服群聊'))
  await until(()=>Boolean(b.store.messageByClient(second.app.serverId,a.client.identity.userId,'new-group')&&b.store.messageByClient(second.app.serverId,a.client.identity.userId,'new-dm')))
  expect((await b.read({action:'history',conversationId:newGroup})).messages.map((m:{text:string})=>m.text)).toEqual(['新服群聊'])
  await a.client.connect(first.url,'A');await b.client.connect(first.url,'同名好友')
  await until(()=>a.store.outbox(first.app.serverId).length===0&&Boolean(b.store.messageByClient(first.app.serverId,a.client.identity.userId,'old-dm')&&b.store.messageByClient(first.app.serverId,a.client.identity.userId,'old-group')&&c.store.messageByClient(first.app.serverId,a.client.identity.userId,'old-group')))
  expect(second.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(2)
  expect(first.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(4)
  await a.read(request(group,'old-group','旧服待发'))
  expect(first.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(4)
 }finally{await f.close()}
},30000)

it.each(['direct','group'] as const)('rejects a %s send if membership ends during attachment I/O, but retains local history reads',async kind=>{
 const f=await fixture();let release=()=>{}
 try{
  const a=await f.member('a'),b=await f.member('b'),relay=await f.server('relay')
  await a.client.connect(relay.url,'A');await b.client.connect(relay.url,'B');await friend(a,b)
  const group=kind==='group'?(await a.client.action('groups',{name:'接口验收',memberIds:[b.client.identity.userId]})).directory!.groups[0]:undefined
  const target=group?.id??b.client.identity.userId
  const id=String(a.store.conversationList().find(entry=>entry.targetId===target)!.id)
  const file=await a.files.put(Buffer.from('历史附件内容'),'历史文件.txt','text/plain')
  await a.client.send({conversationId:id,clientMessageId:'original',text:'历史消息',attachmentId:file.id,attachmentRef:file})
  await until(()=>Boolean(b.store.messageByClient(relay.app.serverId,a.client.identity.userId,'original')))
  const source=b.store.messageByClient(relay.app.serverId,a.client.identity.userId,'original')!
  const original=b.files.read.bind(b.files),gate=new Promise<void>(resolve=>{release=resolve});let waiting=false
  const spy=vi.spyOn(b.files,'read').mockImplementation(async(...args)=>{const wire=await original(...args);waiting=true;await gate;return wire})
  const pending=b.read({...request(id,'must-not-enqueue','附件复制'),attachmentMessageId:source.id}).catch(error=>error)
  await until(()=>waiting)
  await a.client.action(group?'groups/kick':'friends/remove',group?{groupId:group.id,userId:b.client.identity.userId}:{userId:b.client.identity.userId})
  await until(()=>b.store.conversation(id)?.unavailable===true)
  release();expect(await pending).toBeInstanceOf(Error);spy.mockRestore()
  expect(b.store.outbox(relay.app.serverId)).toEqual([])
  expect(b.store.messageByClient(relay.app.serverId,b.client.identity.userId,'must-not-enqueue')).toBeUndefined()
  expect((await b.read({action:'list'})).conversations.find((entry:{id:string})=>entry.id===id)).toMatchObject({available:false})
  expect((await b.read({action:'history',conversationId:id})).messages.map((m:{text:string})=>m.text)).toEqual(['历史消息'])
  expect((await b.read({action:'attachment',conversationId:id,messageId:source.id,format:'text'})).text).toBe('历史附件内容')
  await expect(b.read(request(id,'no-relation','不可发送'))).rejects.toThrow('已不在此群内，或已不是本服好友')
  expect(relay.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(1)
 }finally{release();await f.close()}
},30000)

it('reports a queued send and its later server failure accurately through the history interface',async()=>{
 const f=await fixture()
 try{
  const a=await f.member('a'),b=await f.member('b'),relay=await f.server('relay')
  await a.client.connect(relay.url,'A');await b.client.connect(relay.url,'B');await friend(a,b)
  const id=String(a.store.conversationList().find(entry=>entry.targetId===b.client.identity.userId)!.id),fetchOriginal=globalThis.fetch
  vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input)===relay.url+'/v1/messages'?Promise.resolve(new Response(JSON.stringify({error:'服务器拒绝本次发送'}),{status:403})):fetchOriginal(input,init))
  expect(await a.read(request(id,'rejected-send','这条会被拒绝'))).toMatchObject({queued:true})
  await until(()=>a.store.messageByClient(relay.app.serverId,a.client.identity.userId,'rejected-send')?.status==='failed')
  expect((await a.read({action:'history',conversationId:id,limit:1})).messages[0]).toMatchObject({status:'failed',errorMessage:'服务器拒绝本次发送'})
  expect(a.store.outbox(relay.app.serverId)).toEqual([])
  expect(relay.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(0)
 }finally{await f.close()}
},20000)
