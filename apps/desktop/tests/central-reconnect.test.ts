import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'
import { CentralClient } from '../src/main/central-client'
import { createChatAccess } from '../src/main/chat-access'
import { ClientPluginLoader } from '../src/renderer/src/client-plugin-loader'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { parseExecutableClientPackage } from '@more-than-chat/plugin-runtime'
import { createCentralServer } from '../../central-server/src/server.mjs'

const cipher={available:()=>true,encrypt:(text:string)=>Buffer.from(text),decrypt:(bytes:Buffer)=>bytes.toString()}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
async function until(check:()=>boolean,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20))}throw Error('Reconnect test timeout')}
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'mtc-reconnect-')),stores:ChatStore[]=[],clients:CentralClient[]=[],servers:ReturnType<typeof createCentralServer>[]=[]
  return {
    async client(label:string){
      const directory=path.join(root,label),store=await ChatStore.open(directory);stores.push(store);store.save(createSeedState())
      const attachments=new AttachmentStore(path.join(directory,'files')),client=new CentralClient(await ClientIdentity.load(directory,cipher),store,attachments,directory)
      clients.push(client);return {client,store,attachments}
    },
    async server(label:string,port=0){
      const app=createCentralServer({directory:path.join(root,label),mode:'public',adminToken:'qa-only-strong-admin-token-0001'})
      servers.push(app);return {app,url:'http://127.0.0.1:'+(await app.listen(port)).port}
    },
    async stop(app:ReturnType<typeof createCentralServer>){await app.close();servers.splice(servers.indexOf(app),1)},
    async close(){vi.restoreAllMocks();for(const client of clients)await client.disconnect(false);for(const app of servers)await app.close();for(const store of stores)store.close();await rm(root,{recursive:true,force:true})},
  }
}

async function befriend(a:CentralClient,b:CentralClient,url:string){
  await a.connect(url,'A');await b.connect(url,'B')
  await a.action('friends/request',{userId:b.identity.userId});await b.action('friends/accept',{userId:a.identity.userId})
  await until(()=>Boolean(a.store.conversationList().some(c=>c.serverId===a.serverId&&c.targetId===b.identity.userId)))
  return {
    a:String(a.store.conversationList().find(c=>c.serverId===a.serverId&&c.targetId===b.identity.userId)!.id),
    b:String(b.store.conversationList().find(c=>c.serverId===b.serverId&&c.targetId===a.identity.userId)!.id),
  }
}
async function autoReply(a:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['client']>>,wait:()=>Promise<void>){
  const runtime=new CordisPluginRuntime({target:'pc-ui'}),access=createChatAccess(a.store,a.attachments,input=>a.client.send(input))
  const seen=new Set<string>(),errors:unknown[]=[],jobs:Promise<void>[]=[]
  const pack=parseExecutableClientPackage({manifest:{manifestVersion:1,id:'qa.autoreply',version:'1.0.0',displayName:'Auto reply',description:'Test fixture',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted']},program:{kind:'executable-client',code:'fixture'}})
  const sdk={chat:{request:async(input:unknown)=>JSON.parse((await access(input)).dataJson),subscribe:(fn:(projection:unknown)=>void)=>a.client.onChat(fn)}}
  const loader=new ClientPluginLoader(runtime,sdk,async()=>({default:(_ctx,scoped:any)=>{
    scoped.chat.subscribe((projection:any)=>{
      for(const messages of Object.values(projection.messages) as any[][])for(const message of messages){
        if(message.role!=='peer'||message.retractedAt||!message.text.startsWith('ping:')||seen.has(message.id))continue
        seen.add(message.id)
        jobs.push((async()=>{
          await scoped.chat.request({action:'history',conversationId:message.conversationId})
          await wait()
          await scoped.chat.request({action:'send',conversationId:message.conversationId,clientMessageId:'reply:'+message.clientMessageId,text:'pong:'+message.text.slice(5)})
        })().catch(error=>{errors.push(error)}))
      }
    })
  }}))
  await loader.enable({...pack,digest:'a'.repeat(64)})
  return {loader,seen,errors,jobs,close:()=>runtime.close()}
}

describe('connection generation isolation',()=>{
  it('never projects a late old-server directory into the newly selected server',async()=>{
    const f=await fixture(),release=deferred()
    try{
      const a=await f.client('a'),b=await f.client('b'),first=await f.server('first'),second=await f.server('second')
      await a.client.connect(first.url,'First name')
      await b.client.connect(first.url,'Peer')
      await a.client.action('friends/request',{userId:b.client.identity.userId})
      await b.client.action('friends/accept',{userId:a.client.identity.userId})
      let held=false
      const original=globalThis.fetch
      vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
        const response=await original(input,init)
        if(String(input)===first.url+'/v1/directory'){
          // A fully received response can still be queued for processing when a switch occurs.
          const body=await response.text();held=true;await release.promise
          return new Response(body,{status:response.status})
        }
        return response
      })
      const action=a.client.action('groups',{name:'Only on first',memberIds:[b.client.identity.userId]}).catch(error=>error)
      await until(()=>held)
      await a.client.connect(second.url,'Second name')
      release.resolve()
      expect(await action).toBeInstanceOf(Error)
      expect(a.client.snapshot().serverId).toBe(second.app.serverId)
      expect(a.client.snapshot().displayName).toBe('Second name')
      expect(a.client.snapshot().directory?.groups).toEqual([])
      expect(a.store.conversationList().filter(c=>c.serverId===second.app.serverId)).toEqual([])
    }finally{release.resolve();await f.close()}
  })

  it('does not sign or open a stale reauthentication session after manual disconnect',async()=>{
    const f=await fixture(),release=deferred()
    try{
      const a=await f.client('a'),relay=await f.server('relay')
      let expire=true,held=false,finished=false,sessionRequests=0
      const original=globalThis.fetch
      vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
        const url=String(input)
        if(url.endsWith('/v1/events')&&expire)return new Response(JSON.stringify({error:'expired'}),{status:401})
        if(url.endsWith('/v1/session'))sessionRequests++
        const response=await original(input,init)
        if(url.endsWith('/v1/challenge')&&sessionRequests===1){
          const body=await response.text();held=true;await release.promise;finished=true
          return new Response(body,{status:response.status})
        }
        return response
      })
      await a.client.connect(relay.url,'A')
      await until(()=>held)
      const sign=vi.spyOn(a.client.identity,'sign')
      await a.client.disconnect(false);expire=false;release.resolve()
      await until(()=>finished);await new Promise(r=>setTimeout(r,50))
      expect(sign).not.toHaveBeenCalled()
      expect(sessionRequests).toBe(1)
      expect(a.client.snapshot().status).toBe('disconnected')
    }finally{release.resolve();await f.close()}
  })
})

describe('auto replies across offline and server changes',()=>{
  it('reauthenticates after a real server restart, drains offline replies once, and does not mark bot-read history as read',async()=>{
    const f=await fixture(),release=deferred();let plugin:Awaited<ReturnType<typeof autoReply>>|undefined
    try{
      const a=await f.client('a'),b=await f.client('b'),relay=await f.server('relay'),ids=await befriend(a.client,b.client,relay.url)
      plugin=await autoReply(a,()=>release.promise)
      await b.client.send({conversationId:ids.b,clientMessageId:'restart-before',text:'ping:before'})
      await until(()=>plugin!.seen.size===1)
      await f.stop(relay.app)
      await until(()=>a.client.snapshot().status==='error'&&b.client.snapshot().status==='error')
      release.resolve();await Promise.all(plugin.jobs)
      expect(a.store.outbox(relay.app.serverId)).toHaveLength(1)
      expect(a.store.conversation(ids.a)?.unread).toBe(1)
      await b.client.send({conversationId:ids.b,clientMessageId:'restart-during',text:'ping:during'})
      const restarted=await f.server('relay',Number(new URL(relay.url).port))
      expect(restarted.app.serverId).toBe(relay.app.serverId)
      await until(()=>a.client.snapshot().status==='connected'&&b.client.snapshot().status==='connected',12000)
      await until(()=>b.store.searchMessages('pong:').length===2)
      await until(()=>a.store.outbox(restarted.app.serverId).length===0&&b.store.outbox(restarted.app.serverId).length===0)
      expect(a.store.conversation(ids.a)?.unread).toBe(2)
      expect(b.store.conversation(ids.b)?.unread).toBe(2)
      // Replay the projection as if a plugin rebuilt its in-memory seen set.
      plugin.seen.clear();a.client.refreshChat();await Promise.all(plugin.jobs)
      expect(b.store.searchMessages('pong:')).toHaveLength(2)
      expect(restarted.app.db.prepare("SELECT COUNT(*) AS n FROM message_routes WHERE client_id LIKE 'reply:%'").get().n).toBe(2)
      expect(plugin.errors).toEqual([])
      a.client.setReadingConversation(ids.a)
      await until(()=>b.store.messageByClient(restarted.app.serverId,b.client.identity.userId,'restart-during')?.receipt?.readCount===1)
      expect(a.store.conversation(ids.a)?.unread).toBe(0)
    }finally{release.resolve();await plugin?.close();await f.close()}
  },30000)

  it('queues a delayed local-plugin reply only for its original server, even with the same peer on another server',async()=>{
    const f=await fixture(),release=deferred();let plugin:Awaited<ReturnType<typeof autoReply>>|undefined
    try{
      const a=await f.client('a'),b=await f.client('b'),first=await f.server('first'),second=await f.server('second')
      const old=await befriend(a.client,b.client,first.url)
      plugin=await autoReply(a,()=>release.promise)
      await b.client.send({conversationId:old.b,clientMessageId:'switch-original',text:'ping:original-server'})
      await until(()=>plugin!.seen.size===1)
      const next=await befriend(a.client,b.client,second.url)
      expect(next.a).not.toBe(old.a)
      release.resolve();await Promise.all(plugin.jobs)
      expect(plugin.errors).toEqual([])
      expect(a.store.outbox(first.app.serverId)).toHaveLength(1)
      expect(a.store.outbox(second.app.serverId)).toEqual([])
      expect(second.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(0)
      expect(a.store.conversation(old.a)?.unread).toBe(1)
      expect(a.store.conversation(next.a)?.unread).toBe(0)
      await a.client.connect(first.url,'A');await b.client.connect(first.url,'B')
      await until(()=>b.store.searchMessages('pong:original-server').length===1)
      await until(()=>a.store.outbox(first.app.serverId).length===0)
      expect(b.store.searchMessages('pong:original-server')[0]?.conversationId).toBe(old.b)
      expect(second.app.db.prepare('SELECT COUNT(*) AS n FROM message_routes').get().n).toBe(0)
    }finally{release.resolve();await plugin?.close();await f.close()}
  },30000)
})
