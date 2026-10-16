import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { parseExecutableClientPackage } from '@more-than-chat/plugin-runtime'
import { SharedClientPlugins } from '../src/renderer/src/shared-client-plugins'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'
import { CentralClient } from '../src/main/central-client'
import { createChatAccess } from '../src/main/chat-access'
import { createCentralServer } from '../../central-server/src/server.mjs'

const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=','base64')
async function until(check:()=>boolean){const end=Date.now()+9000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20))}throw Error('Group attachment flow timeout')}

it('runs an approved group auto-replier over image/text/binary attachments with offline fanout, deduplication and per-instance disposal',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mtc-group-media-')),stores:ChatStore[]=[],clients:CentralClient[]=[]
 const relay=createCentralServer({directory:path.join(root,'relay'),mode:'public',adminToken:'qa-only-group-media-admin-0001'}),url='http://127.0.0.1:'+(await relay.listen(0)).port
 const runtime=new CordisPluginRuntime({target:'pc-ui'}),jobs:Promise<void>[]=[],errors:unknown[]=[],reads=new Map<string,Buffer>()
 let release!:()=>void,stop=()=>{},manager:SharedClientPlugins|undefined,choice:'loaded'|'pending'='pending',scope:string|null=null
 const gate=new Promise<void>(resolve=>{release=resolve})
 const make=async(name:string)=>{
  const dir=path.join(root,name),store=await ChatStore.open(dir);stores.push(store);store.save(createSeedState())
  const files=new AttachmentStore(path.join(dir,'files')),client=new CentralClient(await ClientIdentity.load(dir,cipher),store,files,dir)
  clients.push(client);await client.connect(url,name)
  const access=createChatAccess(store,files,input=>client.send(input))
  return {client,store,files,read:async(input:unknown)=>JSON.parse((await access(input)).dataJson)}
 }
 try{
  const a=await make('A'),b=await make('B'),c=await make('C')
  for(const peer of [b,c]){await a.client.action('friends/request',{userId:peer.client.identity.userId});await peer.client.action('friends/accept',{userId:a.client.identity.userId})}
  const group=(await a.client.action('groups',{name:'Media group',memberIds:[b.client.identity.userId,c.client.identity.userId]})).directory!.groups.find(g=>g.name==='Media group')!
  const other=(await a.client.action('groups',{name:'Other group',memberIds:[b.client.identity.userId,c.client.identity.userId]})).directory!.groups.find(g=>g.name==='Other group')!
  const id=relay.serverId+':'+group.id,otherId=relay.serverId+':'+other.id
  await until(()=>Boolean(b.store.conversation(id)&&c.store.conversation(id)))
  // A failed attachment write must not ACK this recipient, while the other member can receive it.
  const image=await a.files.put(png,'图片.png','image/png'),original=b.files.receive.bind(b.files)
  let broken=true,attempts=0
  vi.spyOn(b.files,'receive').mockImplementation(async wire=>{if(broken){attempts++;throw Error('Injected attachment disk failure')}return original(wire)})
  await a.client.send({conversationId:id,clientMessageId:'before-plugin',text:'before plugin',attachmentId:image.id,attachmentRef:image})
  await until(()=>attempts>0&&Boolean(c.store.messageByClient(relay.serverId,a.client.identity.userId,'before-plugin')))
  expect(b.store.messageByClient(relay.serverId,a.client.identity.userId,'before-plugin')).toBeUndefined()
  expect(relay.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE recipient=? AND json_extract(payload,'$.message.clientMessageId')='before-plugin'").get(b.client.identity.userId).n).toBe(1)
  broken=false
  await until(()=>Boolean(b.store.messageByClient(relay.serverId,a.client.identity.userId,'before-plugin'))&&b.client.snapshot().status==='connected')
  expect(Buffer.from((await b.files.read(image.id,image)).data,'base64')).toEqual(png)
  const pack=parseExecutableClientPackage({manifest:{manifestVersion:1,id:'qa.group-media-reply',version:'1.0.0',displayName:'附件回声',description:'Fixture',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted']},program:{kind:'executable-client',code:'fixture'}})
  const pluginId='gplugin_'+randomUUID()
  const submitted=await b.client.action('plugins/submit',{groupId:group.id,pack:{id:pluginId,version:1,displayName:'附件回声',kind:'executable',slot:'chat.details',client:pack}})
  const digest=submitted.directory!.plugins.find(p=>p.pack.id===pluginId)!.digest
  const seen=new Set<string>(),load=vi.fn(async()=>({default:async(_ctx:any,sdk:any)=>{
   sdk.chat.subscribe((projection:any)=>{for(const message of projection.messages[id]??[]){
    if(seen.has(message.id)||message.role!=='peer'||message.senderId!==a.client.identity.userId||message.retractedAt||!message.attachment||!message.text.startsWith('echo:'))continue
    seen.add(message.id)
    jobs.push((async()=>{
     const format=message.attachment.mime==='image/png'?'image':message.attachment.mime==='text/plain'?'text':'base64'
     const chunks:Buffer[]=[];let offset=0
     do{
      const result=await sdk.chat.request({action:'attachment',conversationId:id,messageId:message.id,format,...(format==='image'?{}:{offset,limit:16384})})
      chunks.push(format==='image'?Buffer.from(result.image.data,'base64'):format==='text'?Buffer.from(result.text):Buffer.from(result.data,'base64'))
      offset=result.nextOffset??-1
     }while(offset>=0)
     reads.set(message.clientMessageId,Buffer.concat(chunks))
     await gate
     const request={action:'send',conversationId:id,clientMessageId:'auto:'+message.clientMessageId,text:'reply:'+message.clientMessageId,attachmentMessageId:message.id}
     await sdk.chat.request(request);await sdk.chat.request(request)
    })().catch(error=>{errors.push(error)}))
   }})
  }}))
  manager=new SharedClientPlugins(runtime,{groupPluginConsent:async()=>choice,serverAction:(route,data)=>b.client.action(route,data),getPluginInbox:async()=>[],onPluginEvent:()=>()=>{}},{chat:{request:b.read,subscribe:(fn:any)=>b.client.onChat(fn)}},load)
  scope=group.id
  stop=b.client.subscribe(snapshot=>{void manager!.update(snapshot,scope).catch(error=>{errors.push(error)})})
  await manager.update(b.client.snapshot(),scope);expect(load).not.toHaveBeenCalled()
  await a.client.action('plugins/review',{groupId:group.id,pluginId,version:1,digest,approve:true})
  await until(()=>b.client.snapshot().directory!.plugins.some(p=>p.pack.id===pluginId&&p.status==='approved'))
  await manager.update(b.client.snapshot(),scope);expect(load).not.toHaveBeenCalled()
  choice='loaded';await manager.update(b.client.snapshot(),scope);expect(load).toHaveBeenCalledOnce()
  await c.client.disconnect(false)
  const text=Buffer.from('群文件：你好 🙂\n'),binary=Buffer.from(Array.from({length:100003},(_,i)=>i%256))
  const originals=[{bytes:png,ref:image},{bytes:text,ref:await a.files.put(text,'第一份.txt','text/plain')},{bytes:text,ref:await a.files.put(text,'第二份.dat','application/octet-stream')},{bytes:binary,ref:await a.files.put(binary,'data.bin','application/octet-stream')}]
  for(const [i,item] of originals.entries())await a.client.send({conversationId:id,clientMessageId:'media-'+i,text:'echo:'+i,attachmentId:item.ref.id,attachmentRef:item.ref})
  await until(()=>reads.size===4)
  for(const [i,item] of originals.entries())expect(reads.get('media-'+i)).toEqual(item.bytes)
  release();await Promise.all(jobs)
  expect(errors).toEqual([])
  await until(()=>a.store.searchMessages('reply:media-',id).length===4)
  // Repeated directories, receipts and local read projections are not new inputs.
  b.client.refreshChat();b.client.refreshChat();await Promise.all(jobs)
  expect(relay.db.prepare("SELECT COUNT(*) AS n FROM message_routes WHERE client_id LIKE 'auto:%'").get().n).toBe(4)
  expect(b.store.conversation(id)?.unread).toBe(5) // Original disk-retry message + four requests; no tool-read receipts.
  await c.client.connect(url,'C')
  await until(()=>c.store.searchMessages('reply:media-',id).length===4)
  for(const [i,item] of originals.entries())for(const member of [a,b,c]){
   const message=member.store.messageByClient(relay.serverId,b.client.identity.userId,'auto:media-'+i)!
   expect(message.attachment).toEqual(item.ref)
   expect(Buffer.from((await member.files.read(item.ref.id,item.ref)).data,'base64')).toEqual(item.bytes)
  }
  await until(()=>relay.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.kind')='message'").get().n===0)
  await a.client.send({conversationId:otherId,clientMessageId:'other-group',text:'echo:wrong group',attachmentId:image.id,attachmentRef:image})
  await c.client.send({conversationId:id,clientMessageId:'other-member',text:'echo:wrong sender',attachmentId:image.id,attachmentRef:image})
  await until(()=>Boolean(b.store.messageByClient(relay.serverId,c.client.identity.userId,'other-member'))&&Boolean(b.store.messageByClient(relay.serverId,a.client.identity.userId,'other-group')))
  expect(jobs).toHaveLength(4)
  scope=other.id;await manager.update(b.client.snapshot(),scope)
  await a.client.send({conversationId:id,clientMessageId:'after-leaving',text:'echo:no active plugin',attachmentId:image.id,attachmentRef:image})
  await until(()=>Boolean(b.store.messageByClient(relay.serverId,a.client.identity.userId,'after-leaving')))
  expect(jobs).toHaveLength(4);expect(runtime.list()).toEqual([])
 }finally{
  release();stop();await manager?.update(null,null);await runtime.close();await Promise.all(jobs);vi.restoreAllMocks()
  for(const client of clients)await client.disconnect(false)
  await relay.close();for(const store of stores)store.close();await rm(root,{recursive:true,force:true})
 }
},30000)
