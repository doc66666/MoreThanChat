import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'
import { CentralClient } from '../src/main/central-client'
import { createCentralServer } from '../../central-server/src/server.mjs'
import { ForwardAttemptIds } from '../src/renderer/src/message-actions'

const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0))await cleanup()})
async function until(check:()=>boolean,timeout=7000){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Message action timeout')}
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'mtc-message-actions-')),server=createCentralServer({directory:path.join(root,'server'),mode:'public',adminToken:'qa-only-strong-admin-token-0001'}),url='http://127.0.0.1:'+(await server.listen(0)).port
  const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
  const make=async(label:string)=>{const folder=path.join(root,label),store=await ChatStore.open(folder),identity=await ClientIdentity.load(folder,cipher),files=new AttachmentStore(path.join(folder,'attachments')),client=new CentralClient(identity,store,files,folder);store.save(createSeedState());await client.connect(url,label);return{store,files,client,uid:identity.userId}}
  const a=await make('A'),b=await make('B')
  cleanups.push(async()=>{await a.client.disconnect(false);await b.client.disconnect(false);await server.close();a.store.close();b.store.close();await rm(root,{recursive:true,force:true})})
  await a.client.action('friends/request',{userId:b.uid});await b.client.action('friends/accept',{userId:a.uid})
  await until(()=>Boolean(a.store.load()?.conversations.some(c=>c.targetId===b.uid)))
  const aid=String(a.store.load()!.conversations.find(c=>c.targetId===b.uid)!.id),bid=String(b.store.load()!.conversations.find(c=>c.targetId===a.uid)!.id)
  return{a,b,aid,bid,server,url}
}
describe('chat message action integration',()=>{
  it('retries a forwarding destination without duplicate messages and allows another destination',async()=>{
    const {a,b,aid,bid,server}=await fixture(),clientId=randomUUID()
    await a.client.send({conversationId:aid,clientMessageId:clientId,text:'forward-retry-original'})
    await until(()=>Boolean(b.store.messageByClient(server.serverId,a.uid,clientId)?.actionsSupported))
    const original=b.store.messageByClient(server.serverId,a.uid,clientId)!
    const grouped=await a.client.action('groups',{name:'Forward retry group',memberIds:[b.uid]}),group=grouped.directory!.groups[0]!.id
    await until(()=>Boolean(b.store.load()?.conversations.some(c=>c.targetId===group)))
    const bgroup=String(b.store.load()!.conversations.find(c=>c.targetId===group)!.id)
    const ids=new ForwardAttemptIds(randomUUID)
    // A renderer can lose its reply after the first request was durably queued.
    await b.client.forwardMessage(String(original.id),bid,ids.forTarget(bid))
    await b.client.forwardMessage(String(original.id),bid,ids.forTarget(bid))
    await b.client.forwardMessage(String(original.id),bgroup,ids.forTarget(bgroup))
    await until(()=>Boolean(a.store.messageByClient(server.serverId,b.uid,ids.forTarget(bid))&&a.store.messageByClient(server.serverId,b.uid,ids.forTarget(bgroup))))
    for(const store of [a.store,b.store]){
      for(const target of [bid,bgroup]){
        const copies=Object.values(store.load()!.messages).flat().filter(m=>m.senderId===b.uid&&m.clientMessageId===ids.forTarget(target))
        expect(copies).toHaveLength(1)
      }
    }
  })
  it('uses the accepted sender name when an offline queue is sent after changing nickname',async()=>{
    const {a,b,aid,server,url}=await fixture(),clientId=randomUUID()
    await a.client.disconnect(false);await a.client.send({conversationId:aid,clientMessageId:clientId,text:'queued-before-rename'})
    await a.client.connect(url,'Renamed A')
    await until(()=>Boolean(a.store.messageByClient(server.serverId,a.uid,clientId)?.actionsSupported))
    const source=a.store.messageByClient(server.serverId,a.uid,clientId)!
    expect(source.senderName).toBe('Renamed A')
    const replyId=randomUUID();await a.client.send({conversationId:aid,clientMessageId:replyId,text:'self-quoted-reply',quoteMessageId:String(source.id)})
    await until(()=>Boolean(b.store.messageByClient(server.serverId,a.uid,replyId)))
    expect(b.store.messageByClient(server.serverId,a.uid,replyId)?.quote).toMatchObject({senderName:'Renamed A',text:'queued-before-rename'})
  })
  it('converges through durable notifications when the withdrawal succeeds but its response is lost',async()=>{
    const {a,b,aid,server}=await fixture(),clientId=randomUUID()
    await a.client.send({conversationId:aid,clientMessageId:clientId,text:'lost-withdrawal-body'})
    await until(()=>Boolean(b.store.messageByClient(server.serverId,a.uid,clientId)))
    const id=String(b.store.messageByClient(server.serverId,a.uid,clientId)!.id),realFetch=globalThis.fetch
    let lost=false,posts=0
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const response=await realFetch(input,init)
      if(String(input).endsWith('/v1/messages/retract')){posts++;if(!lost){lost=true;throw new Error('Injected lost withdrawal response')}}
      return response
    })
    await a.client.retractMessage(id).catch(()=>undefined)
    await until(()=>Boolean(a.store.message(id)?.retractedAt&&b.store.message(id)?.retractedAt))
    expect(lost).toBe(true)
    await a.client.retractMessage(id)
    expect(posts).toBe(1)
    expect(a.store.searchMessages('lost-withdrawal-body')).toEqual([])
    expect(b.store.searchMessages('lost-withdrawal-body')).toEqual([])
  })
  it('quotes, forwards and independently withdraws copies across offline reconnects',async()=>{
    const {a,b,aid,bid,server,url}=await fixture(),clientId=randomUUID()
    await a.client.send({conversationId:aid,clientMessageId:clientId,text:'original-action-body'})
    await until(()=>Boolean(b.store.messageByClient(server.serverId,a.uid,clientId)?.actionsSupported))
    const original=structuredClone(b.store.messageByClient(server.serverId,a.uid,clientId)!),id=String(original.id),replyId=randomUUID()
    await b.client.send({conversationId:bid,clientMessageId:replyId,text:'reply-to-original',quoteMessageId:id})
    await until(()=>Boolean(a.store.messageByClient(server.serverId,b.uid,replyId)))
    expect(a.store.messageByClient(server.serverId,b.uid,replyId)?.quote).toMatchObject({messageId:id,senderId:a.uid,text:'original-action-body'})
    const grouped=await a.client.action('groups',{name:'Action group',memberIds:[b.uid]}),group=grouped.directory!.groups[0]!.id
    await until(()=>Boolean(b.store.load()?.conversations.some(c=>c.targetId===group)))
    const bgroup=String(b.store.load()!.conversations.find(c=>c.targetId===group)!.id)
    await expect(b.client.send({conversationId:bgroup,clientMessageId:randomUUID(),text:'bad-cross-conversation',quoteMessageId:id})).rejects.toThrow('当前会话')
    const forwardId=randomUUID();await b.client.forwardMessage(id,bgroup,forwardId)
    await until(()=>Boolean(a.store.messageByClient(server.serverId,b.uid,forwardId)))
    expect(a.store.messageByClient(server.serverId,b.uid,forwardId)?.forwarded).toMatchObject({messageId:id,senderId:a.uid})
    await expect(b.client.retractMessage(id)).rejects.toThrow('本人')
    await b.client.disconnect(false)
    await a.client.retractMessage(id)
    expect(a.store.message(id)?.text).toBe('')
    await b.client.connect(url,'B');await until(()=>Boolean(b.store.message(id)?.retractedAt))
    expect(b.store.message(id)?.text).toBe('')
    expect(b.store.messageByClient(server.serverId,b.uid,replyId)?.quote).toMatchObject({text:'引用的消息已撤回',retracted:true})
    expect(a.store.messageByClient(server.serverId,b.uid,forwardId)?.text).toBe('original-action-body')
    const replay=b.store.load()!;replay.messages[bid]=[original];b.store.save(replay,undefined,{authoritative:true})
    expect(b.store.message(id)?.text).toBe('')
    const forward= b.store.messageByClient(server.serverId,b.uid,forwardId)!
    await b.client.retractMessage(String(forward.id));await until(()=>Boolean(a.store.message(String(forward.id))?.retractedAt))
    expect(a.store.searchMessages('original-action-body')).toEqual([])
    expect(b.store.searchMessages('original-action-body')).toEqual([])
  })
  it('preserves original attachment metadata when forwarding a reused content-addressed file',async()=>{
    const {a,b,aid,bid,server}=await fixture(),bytes=Buffer.from('same attachment bytes'),ref=await a.files.put(bytes,'original-name.txt','text/plain'),clientId=randomUUID()
    await a.client.send({conversationId:aid,clientMessageId:clientId,text:'',attachmentId:ref.id})
    await until(()=>Boolean(b.store.messageByClient(server.serverId,a.uid,clientId)))
    const source=b.store.messageByClient(server.serverId,a.uid,clientId)!
    await b.files.put(bytes,'later-name.txt','text/plain')
    const forwardId=randomUUID();await b.client.forwardMessage(String(source.id),bid,forwardId)
    await until(()=>Boolean(a.store.messageByClient(server.serverId,b.uid,forwardId)))
    expect(a.store.messageByClient(server.serverId,b.uid,forwardId)?.attachment).toMatchObject({id:ref.id,name:'original-name.txt'})
  })
  it('keeps a withdrawal pending until receiver storage commits despite a disk failure',async()=>{
    const {a,b,aid,server}=await fixture(),clientId=randomUUID()
    await a.client.send({conversationId:aid,clientMessageId:clientId,text:'disk-sensitive-origin'})
    await until(()=>Boolean(b.store.messageByClient(server.serverId,a.uid,clientId)))
    const id=String(b.store.messageByClient(server.serverId,a.uid,clientId)!.id),save=b.store.save.bind(b.store)
    let blocked=true,attempts=0
    vi.spyOn(b.store,'save').mockImplementation((...args)=>{if(blocked&&args[2]?.retraction){attempts++;throw new Error('Injected unavailable disk')}return save(...args)})
    await a.client.retractMessage(id);await until(()=>attempts>0)
    expect(b.store.message(id)?.text).toBe('disk-sensitive-origin')
    expect(server.db.prepare("SELECT 1 FROM queue WHERE recipient=? AND json_extract(payload,'$.retraction.messageId')=?").get(b.uid,id)).toBeDefined()
    blocked=false;await until(()=>Boolean(b.store.message(id)?.retractedAt))
    await until(()=>!server.db.prepare("SELECT 1 FROM queue WHERE recipient=? AND json_extract(payload,'$.retraction.messageId')=?").get(b.uid,id))
    expect(b.store.message(id)?.text).toBe('')
  })
})
