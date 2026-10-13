import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'
import { CentralClient } from '../src/main/central-client'
import { createCentralServer } from '../../central-server/src/server.mjs'

const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
async function until(check:()=>boolean,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Multi-device flow timeout')}
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'mtc-devices-'))
  const options={directory:path.join(root,'server'),mode:'public',adminToken:'test-only-device-flow-admin-token'}
  let app=createCentralServer(options),port=(await app.listen(0)).port
  const url='http://127.0.0.1:'+port
  const identities=await Promise.all(['a','b'].map(id=>ClientIdentity.load(path.join(root,id),cipher)))
  const clients:CentralClient[]=[],stores:ChatStore[]=[]
  for(const [index,id] of ['a1','a2','b1','b2'].entries()){
    const directory=path.join(root,id),store=await ChatStore.open(directory);store.save(createSeedState());stores.push(store)
    clients.push(new CentralClient(identities[Math.floor(index/2)]!,store,new AttachmentStore(path.join(directory,'files')),directory))
  }
  return {root,url,clients,stores,get app(){return app},async restart(){await app.close();app=createCentralServer(options);await app.listen(port)},async close(){for(const c of clients)await c.disconnect(false);await app.close();for(const s of stores)s.close();await rm(root,{recursive:true,force:true})}}
}
async function connectAll(f:Awaited<ReturnType<typeof fixture>>){
  const [a1,a2,b1,b2]=f.clients as [CentralClient,CentralClient,CentralClient,CentralClient]
  for(const [i,c] of f.clients.entries())await c.connect(f.url,i<2?'A':'B')
  await a1.action('friends/request',{userId:b1.identity.userId});await b1.action('friends/accept',{userId:a1.identity.userId})
  await until(()=>f.stores.every(s=>s.load()?.conversations.some(c=>c.kind==='direct')))
  return {a1,a2,b1,b2,conversation:String(a1.store.load()!.conversations.find(c=>c.kind==='direct')!.id)}
}
describe('registered device delivery',()=>{
  it('keeps independent obligations across restart, mirrors own messages, and synchronizes read state',async()=>{
    const f=await fixture()
    try{
      const {a1,a2,b1,b2,conversation}=await connectAll(f)
      await a2.disconnect(false);await b2.disconnect(false)
      const clientId=randomUUID();await a1.send({conversationId:conversation,clientMessageId:clientId,text:'multi-device durable message'})
      await until(()=>Boolean(b1.store.messageByClient(f.app.serverId,a1.identity.userId,clientId)))
      const id=String(b1.store.messageByClient(f.app.serverId,a1.identity.userId,clientId)!.id)
      await until(()=>f.app.db.prepare('SELECT delivered_at FROM message_delivery WHERE message_id=?').get(id)?.delivered_at!=null)
      expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=?').get(id).n).toBe(2) // A2 and B2 each still owed a copy.
      expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue_devices WHERE event_id=?').get(id).n).toBe(2)
      const bConversation=String(b1.store.message(id)!.conversationId)
      b1.setReadingConversation(bConversation)
      await until(()=>f.app.db.prepare('SELECT read_at FROM message_delivery WHERE message_id=?').get(id)?.read_at!=null)
      await f.restart()
      // A restart may reset a pooled keep-alive socket; exercise the client's reconnect path.
      await a2.connect(f.url,'A').catch(()=>undefined);await b2.connect(f.url,'B').catch(()=>undefined)
      await until(()=>a2.snapshot().status==='connected'&&b2.snapshot().status==='connected')
      await until(()=>Boolean(a2.store.message(id))&&Boolean(b2.store.message(id)?.readAt))
      expect(a2.store.message(id)!.role).toBe('self')
      expect(b2.store.load()!.conversations.find(c=>c.id===bConversation)!.unread).toBe(0)
      await until(()=>f.app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=?').get(id).n===0)
      expect(a2.store.searchMessages('multi-device durable message')).toHaveLength(1)
      expect(b2.store.searchMessages('multi-device durable message')).toHaveLength(1)
      await b2.disconnect(false);await a1.connect(f.url,'A')
      await a1.retractMessage(id);await b2.connect(f.url,'B')
      await until(()=>Boolean(b2.store.message(id)?.retractedAt)&&Boolean(a2.store.message(id)?.retractedAt))
      expect(b2.store.message(id)!.text).toBe('')
    }finally{await f.close()}
  },25000)
  it('mirrors group attachments and removes only a retired device delivery obligation',async()=>{
    const f=await fixture()
    try{
      const {a1,a2,b1,b2}=await connectAll(f)
      const result=await a1.action('groups',{name:'Device group',memberIds:[b1.identity.userId]})
      const groupId=result.directory!.groups[0]!.id
      await until(()=>f.clients.every(c=>c.store.load()!.conversations.some(v=>v.targetId===groupId)))
      const conversation=String(a1.store.load()!.conversations.find(c=>c.targetId===groupId)!.id)
      await b2.disconnect(false)
      const attachment=await a1.attachments.put(Buffer.from('shared group attachment'),'group.txt','text/plain')
      const id=randomUUID();await a1.send({conversationId:conversation,clientMessageId:id,text:'group with two sender devices',attachmentId:attachment.id})
      await until(()=>Boolean(a2.store.messageByClient(f.app.serverId,a1.identity.userId,id))&&Boolean(b1.store.messageByClient(f.app.serverId,a1.identity.userId,id)))
      const messageId=String(b1.store.messageByClient(f.app.serverId,a1.identity.userId,id)!.id)
      await until(()=>f.app.db.prepare('SELECT COUNT(*) AS n FROM queue_devices WHERE event_id=?').get(messageId).n===1)
      const devices=await b1.devices(),retired=devices.find(d=>!d.current)!
      await b1.removeDevice(retired.id)
      expect(await b1.devices()).toHaveLength(1)
      expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=?').get(messageId).n).toBe(0)
      await expect(b2.connect(f.url,'B')).rejects.toThrow('已移除')
      await expect(a1.removeDevice(retired.id)).rejects.toThrow('不存在')
      await expect(b1.removeDevice((await b1.devices())[0]!.id)).rejects.toThrow('不能移除')
      expect(a2.store.message(messageId)!.role).toBe('self')
      expect((await a2.attachments.read(attachment.id)).data).toBe(Buffer.from('shared group attachment').toString('base64'))
      expect((await b1.attachments.read(attachment.id)).name).toBe('group.txt')
    }finally{await f.close()}
  },20000)
})
