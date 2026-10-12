import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'
import { CentralClient } from '../src/main/central-client'
import { createCentralServer } from '../../central-server/src/server.mjs'

const cipher={available:()=>true,encrypt:(text:string)=>Buffer.from(text),decrypt:(bytes:Buffer)=>bytes.toString()}
async function until(check:()=>boolean,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Client flow timeout')}
describe('human chat reliability',()=>{
  it('does not ACK an incoming message until local persistence succeeds after a disk failure',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-before-ack-')),aStore=await ChatStore.open(path.join(root,'a')),bStore=await ChatStore.open(path.join(root,'b'))
    aStore.save(createSeedState());bStore.save(createSeedState())
    const app=createCentralServer({directory:path.join(root,'server'),mode:'public',adminToken:'qa-only-strong-admin-token-0001'}),url='http://127.0.0.1:'+(await app.listen(0)).port
    const a=new CentralClient(await ClientIdentity.load(path.join(root,'a'),cipher),aStore,new AttachmentStore(path.join(root,'a','files')),path.join(root,'a'))
    const b=new CentralClient(await ClientIdentity.load(path.join(root,'b'),cipher),bStore,new AttachmentStore(path.join(root,'b','files')),path.join(root,'b'))
    try {
      await a.connect(url,'A');await b.connect(url,'B');await a.action('friends/request',{userId:b.identity.userId});await b.action('friends/accept',{userId:a.identity.userId})
      await until(()=>Boolean(aStore.load()?.conversations.some(c=>c.targetId===b.identity.userId)))
      const conversation=String(aStore.load()!.conversations.find(c=>c.targetId===b.identity.userId)!.id),id=randomUUID(),save=bStore.save.bind(bStore)
      let blocked=true,failures=0
      vi.spyOn(bStore,'save').mockImplementation((...args)=>{
        const candidate=args[0] as {messages:Record<string,{text:string}[]>}
        if(blocked&&Object.values(candidate.messages).flat().some(m=>m.text==='persist-before-ack-body')){failures++;throw new Error('Injected full disk')}
        return save(...args)
      })
      await a.send({conversationId:conversation,clientMessageId:id,text:'persist-before-ack-body'})
      await until(()=>failures>0)
      expect(bStore.messageByClient(app.serverId,a.identity.userId,id)).toBeUndefined()
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE recipient=? AND json_extract(payload,'$.message.clientMessageId')=?").get(b.identity.userId,id).n).toBe(1)
      blocked=false
      await until(()=>Boolean(bStore.messageByClient(app.serverId,a.identity.userId,id)))
      await until(()=>app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE recipient=? AND json_extract(payload,'$.message.clientMessageId')=?").get(b.identity.userId,id).n===0)
      expect(bStore.searchMessages('persist-before-ack-body')).toHaveLength(1)
    }finally{vi.restoreAllMocks();await a.disconnect(false);await b.disconnect(false);await app.close();aStore.close();bStore.close();await rm(root,{recursive:true,force:true})}
  },15000)
  it('drains and deduplicates an old queued message outside the initial history page',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-old-queue-')),aStore=await ChatStore.open(path.join(root,'a')),bStore=await ChatStore.open(path.join(root,'b'))
    aStore.save(createSeedState());bStore.save(createSeedState())
    const app=createCentralServer({directory:path.join(root,'server'),mode:'public',adminToken:'qa-only-strong-admin-token-0001'}),url='http://127.0.0.1:'+(await app.listen(0)).port
    const a=new CentralClient(await ClientIdentity.load(path.join(root,'a'),cipher),aStore,new AttachmentStore(path.join(root,'a','files')),path.join(root,'a'))
    const b=new CentralClient(await ClientIdentity.load(path.join(root,'b'),cipher),bStore,new AttachmentStore(path.join(root,'b','files')),path.join(root,'b'))
    try {
      await a.connect(url,'A');await b.connect(url,'B');await a.action('friends/request',{userId:b.identity.userId});await b.action('friends/accept',{userId:a.identity.userId})
      await until(()=>Boolean(aStore.load()?.conversations.some(c=>c.targetId===b.identity.userId)))
      const conversation=String(aStore.load()!.conversations.find(c=>c.targetId===b.identity.userId)!.id),id=randomUUID()
      await a.disconnect(false);await a.send({conversationId:conversation,clientMessageId:id,text:'old-outbox-must-deliver'})
      const state=aStore.load()!,template=state.messages[conversation]![0]!
      state.messages[conversation]=Array.from({length:80},(_,i)=>({...template,id:randomUUID(),clientMessageId:randomUUID(),status:'sent',text:'padding-'+i,createdAt:Number(template.createdAt)+i+1}))
      aStore.save(state,undefined,{authoritative:true})
      expect(aStore.load()!.messages[conversation]!.some(m=>m.clientMessageId===id)).toBe(false)
      await a.connect(url,'A')
      await until(()=>aStore.messageByClient(app.serverId,a.identity.userId,id)?.status==='sent')
      await until(()=>Number((aStore.messageByClient(app.serverId,a.identity.userId,id)?.receipt as {deliveredCount:number}|undefined)?.deliveredCount)===1)
      await a.send({conversationId:conversation,clientMessageId:id,text:'old-outbox-must-deliver'})
      const grouped=await a.action('groups',{name:'Separate target',memberIds:[b.identity.userId]})
      const groupId=String(aStore.load()!.conversations.find(c=>c.targetId===grouped.directory!.groups[0]!.id)!.id)
      await expect(a.send({conversationId:groupId,clientMessageId:id,text:'old-outbox-must-deliver'})).rejects.toThrow('替换会话')
      expect(aStore.outbox(app.serverId)).toEqual([])
      expect(bStore.searchMessages('old-outbox-must-deliver')).toHaveLength(1)
      expect(app.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE client_id=?').get(id).n).toBe(1)
      await a.action('friends/remove',{userId:b.identity.userId})
      await expect(a.send({conversationId:conversation,clientMessageId:randomUUID(),text:'must-not-send-to-removed-friend'})).rejects.toThrow('已不是')
      await a.disconnect(false)
      await expect(a.send({conversationId:conversation,clientMessageId:randomUUID(),text:'must-not-queue-for-removed-friend'})).rejects.toThrow('已不是')
      expect(aStore.outbox(app.serverId)).toEqual([])
    }finally{await a.disconnect(false);await b.disconnect(false);await app.close();aStore.close();bStore.close();await rm(root,{recursive:true,force:true})}
  })
  it('rejects a familiar server id from an unconfirmed address before signing or sending queued messages',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-server-pin-')),store=await ChatStore.open(root);store.save(createSeedState())
    const app=createCentralServer({directory:path.join(root,'server'),mode:'public',adminToken:'qa-only-strong-admin-token-0001'}),address=await app.listen(0)
    let requests=0
    const fake=createServer((req,res)=>{if(req.url!=='/v1/ping')requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({protocolVersion:1,serverId:app.serverId,mode:'public'}))})
    await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve))
    const client=new CentralClient(await ClientIdentity.load(root,cipher),store,new AttachmentStore(path.join(root,'files')),root)
    try{
      await client.connect('http://127.0.0.1:'+address.port,'A')
      const signature=vi.spyOn(client.identity,'sign');signature.mockClear()
      await expect(client.connect('http://127.0.0.1:'+(fake.address() as {port:number}).port,'A')).rejects.toThrow('另一个地址')
      expect(signature).not.toHaveBeenCalled();expect(requests).toBe(0)
      expect(store.serverOrigin(app.serverId)).toBe('http://127.0.0.1:'+address.port)
    }finally{vi.restoreAllMocks();await client.disconnect(false);await app.close();await new Promise<void>(resolve=>fake.close(()=>resolve()));store.close();await rm(root,{recursive:true,force:true})}
  })
  it('cancels a slower connection and keeps the newer server address persisted',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-connection-switch-')),store=await ChatStore.open(root);store.save(createSeedState())
    const app=createCentralServer({directory:path.join(root,'server'),mode:'public',adminToken:'qa-only-strong-admin-token-0001'}),address=await app.listen(0)
    const fake=createServer((_req,res)=>{setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({protocolVersion:1,serverId:'srv_'+randomUUID(),mode:'public'}))},150)})
    await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve))
    const client=new CentralClient(await ClientIdentity.load(root,cipher),store,new AttachmentStore(path.join(root,'files')),root),url='http://127.0.0.1:'+address.port
    try{
      const first=client.connect('http://127.0.0.1:'+(fake.address() as {port:number}).port,'A').catch(e=>e)
      await new Promise(resolve=>setTimeout(resolve,20))
      await client.connect(url,'A')
      expect(await first).toBeInstanceOf(Error)
      expect(client.snapshot().address).toBe(url)
      expect(JSON.parse(await readFile(path.join(root,'central-settings.json'),'utf8')).address).toBe(url)
    }finally{await client.disconnect(false);await app.close();await new Promise<void>(resolve=>fake.close(()=>resolve()));store.close();await rm(root,{recursive:true,force:true})}
  })
  it('persists the offline outbox, isolates servers and distinguishes delivery from reading',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-chat-flow-')),stores:ChatStore[]=[],clients:CentralClient[]=[],servers:ReturnType<typeof createCentralServer>[]=[]
    const make=async(label:string,identity?:ClientIdentity)=>{
      const folder=path.join(root,label),store=await ChatStore.open(folder);stores.push(store);store.save(createSeedState())
      const key=identity??await ClientIdentity.load(folder,cipher),client=new CentralClient(key,store,new AttachmentStore(path.join(folder,'attachments')),folder)
      clients.push(client);return {client,store,key}
    }
    const server=async(label:string)=>{const app=createCentralServer({directory:path.join(root,label),mode:'public',adminToken:'qa-only-strong-admin-token-0001'});servers.push(app);const address=await app.listen(0);return {app,url:'http://127.0.0.1:'+address.port}}
    try{
      const relay=await server('server'),other=await server('other'),a=await make('a'),b=await make('b')
      await a.client.connect(relay.url,'A');await b.client.connect(relay.url,'B')
      await a.client.action('friends/request',{userId:b.key.userId});await b.client.action('friends/accept',{userId:a.key.userId})
      await until(()=>Boolean(a.store.load()?.conversations.some(c=>c.targetId===b.key.userId)))
      const aid=String(a.store.load()!.conversations.find(c=>c.targetId===b.key.userId)!.id)
      const bid=String(b.store.load()!.conversations.find(c=>c.targetId===a.key.userId)!.id)
      await a.client.disconnect(false)
      const id=randomUUID();await a.client.send({conversationId:aid,clientMessageId:id,text:'offline-outbox-body'})
      expect(a.store.outbox(relay.app.serverId)).toHaveLength(1)
      expect(a.store.load()!.messages[aid]![0]!.status).toBe('queued')
      await a.client.connect(other.url,'A')
      expect(a.store.outbox(relay.app.serverId)).toHaveLength(1)
      expect(other.app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.kind')='message'").get().n).toBe(0)
      await a.client.disconnect(false);a.store.close()
      const reopened=await ChatStore.open(path.join(root,'a'));stores.push(reopened)
      const restored=new CentralClient(a.key,reopened,new AttachmentStore(path.join(root,'a','attachments')),path.join(root,'a'));clients.push(restored)
      expect(reopened.outbox(relay.app.serverId)).toHaveLength(1)
      await restored.connect(relay.url,'A')
      await until(()=>Boolean(b.store.load()?.messages[bid]?.some(m=>m.text==='offline-outbox-body')))
      await until(()=>Number((reopened.load()!.messages[aid]![0]!.receipt as {deliveredCount:number}|undefined)?.deliveredCount)===1)
      expect((reopened.load()!.messages[aid]![0]!.receipt as {readCount:number}).readCount).toBe(0)
      expect(b.store.load()!.conversations.find(c=>c.id===bid)!.unread).toBe(1)
      b.client.setReadingConversation(bid)
      await until(()=>Number((reopened.load()!.messages[aid]![0]!.receipt as {readCount:number}).readCount)===1)
      expect(b.store.load()!.conversations.find(c=>c.id===bid)!.unread).toBe(0)
      expect(reopened.outbox(relay.app.serverId)).toHaveLength(0)
      expect(JSON.stringify(relay.app.db.prepare('SELECT * FROM queue').all())).not.toContain('offline-outbox-body')
    }finally{for(const client of clients)await client.disconnect(false);for(const app of servers)await app.close();for(const store of stores)store.close();await rm(root,{recursive:true,force:true})}
  })
  it('does not duplicate a message when its POST succeeds but the response is lost',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-lost-response-')),aStore=await ChatStore.open(path.join(root,'a')),bStore=await ChatStore.open(path.join(root,'b'))
    aStore.save(createSeedState());bStore.save(createSeedState())
    const app=createCentralServer({directory:path.join(root,'server'),mode:'public',adminToken:'qa-only-strong-admin-token-0001'}),address=await app.listen(0),url='http://127.0.0.1:'+address.port
    const a=new CentralClient(await ClientIdentity.load(path.join(root,'a'),cipher),aStore,new AttachmentStore(path.join(root,'a','files')),path.join(root,'a'))
    const b=new CentralClient(await ClientIdentity.load(path.join(root,'b'),cipher),bStore,new AttachmentStore(path.join(root,'b','files')),path.join(root,'b'))
    try{
      await a.connect(url,'A');await b.connect(url,'B');await a.action('friends/request',{userId:b.identity.userId});await b.action('friends/accept',{userId:a.identity.userId})
      await until(()=>Boolean(aStore.load()?.conversations.some(c=>c.targetId===b.identity.userId)))
      const conversation=String(aStore.load()!.conversations.find(c=>c.targetId===b.identity.userId)!.id),id=randomUUID(),original=globalThis.fetch
      let lost=false
      vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{const response=await original(input,init);if(String(input).endsWith('/v1/messages')&&!lost){lost=true;throw new Error('Injected lost response')}return response})
      await a.send({conversationId:conversation,clientMessageId:id,text:'delivered-once'})
      await until(()=>aStore.load()!.messages[conversation]![0]!.status==='sent')
      await until(()=>Object.values(bStore.load()!.messages).flat().some(m=>m.text==='delivered-once'))
      await a.send({conversationId:conversation,clientMessageId:id,text:'delivered-once'})
      expect(Object.values(bStore.load()!.messages).flat().filter(m=>m.text==='delivered-once')).toHaveLength(1)
      expect(app.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE client_id=?').get(id).n).toBe(1)
    }finally{vi.restoreAllMocks();await a.disconnect(false);await b.disconnect(false);await app.close();aStore.close();bStore.close();await rm(root,{recursive:true,force:true})}
  })
})
