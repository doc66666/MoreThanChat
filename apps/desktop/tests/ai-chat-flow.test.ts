import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { createHostErrorResponse, createHostSuccessResponse, safeParseHostMessage, type ChatAccessRequest, type HostEventMessage, type HostRequest } from '@more-than-chat/protocol'
import { createCentralServer } from '../../central-server/src/server.mjs'
import { ModelService } from '../../pc-host/src/model-service'
import { HostCredentialClient, MemoryModelCredentials } from '../../pc-host/src/credential-client'
import { createAuthorToolExecutor } from '../../pc-host/src/author-tools'
import { PluginDraftService } from '../../pc-host/src/plugin-drafts'
import { BUILTIN_ASSISTANT_PROMPT } from '../../pc-host/src/model-context'
import { ChatStore } from '../src/main/chat-store'
import { AttachmentStore } from '../src/main/attachments'
import { ClientIdentity } from '../src/main/identity-store'
import { CentralClient } from '../src/main/central-client'
import { createChatAccess } from '../src/main/chat-access'
import { HostSupervisor, type HostProcess } from '../src/main/host-supervisor'

type ApiMessage={role:string;content:any;tool_call_id?:string;tool_calls?:{id:string;function:{name:string;arguments:string}}[]}
type ApiBody={messages:ApiMessage[];tools?:{function:{name:string}}[];tool_choice?:string}
const cipher={available:()=>true,encrypt:(value:string)=>Buffer.from(value),decrypt:(value:Buffer)=>value.toString()}
async function until(check:()=>boolean){const deadline=Date.now()+9000;while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,10))}throw Error('AI chat flow timeout')}

// Only the Electron process transport is replaced. ModelService, tool executor,
// credential/chat broker, supervisor and their protocol validation are real.
class LoopbackHost implements HostProcess {
  readonly pid=1
  readonly events=new EventEmitter()
  readonly credentials=new HostCredentialClient(message=>this.emit(message))
  readonly drafts:PluginDraftService
  readonly model:ModelService
  readonly ready:Promise<void>
  constructor(dir:string,readonly generation:number){
    this.drafts=new PluginDraftService({dataDir:dir,installedPlugins:()=>[]})
    this.model=new ModelService({dataDir:dir,generation,credentials:this.credentials,authorTools:createAuthorToolExecutor(this.drafts,undefined,request=>this.credentials.accessChat(request))})
    this.ready=Promise.resolve().then(()=>this.model.load())
    queueMicrotask(()=>this.events.emit('spawn'))
  }
  emit(message:unknown){queueMicrotask(()=>this.events.emit('message',structuredClone(message)))}
  send(message:unknown){
    const raw=structuredClone(message)
    if(this.credentials.accept(raw))return
    const parsed=safeParseHostMessage(raw)
    if(!parsed.success||parsed.data.kind!=='request')throw Error('Invalid loopback request')
    const request=parsed.data
    void this.handle(request).catch(error=>this.emit(createHostErrorResponse(request,{code:'INVALID_PAYLOAD',message:String(error),retryable:true})))
  }
  async handle(request:HostRequest){
    await this.ready
    const respond=(payload:unknown)=>this.emit(createHostSuccessResponse(request,payload as never))
    switch(request.method){
      case 'host.handshake':respond({selectedProtocolVersion:1,hostName:'Integration Host',hostVersion:'0.1.0',status:{state:'ready',generation:this.generation}});break
      case 'model.setSettings':respond(await this.model.setSettings(request.payload));break
      case 'model.chat.start':respond(this.model.start(request.payload,event=>this.emit(event)));break
      case 'model.chat.cancel':respond(this.model.cancel(request.payload.streamId));break
      case 'host.shutdown':this.model.close();respond({accepted:true});queueMicrotask(()=>this.events.emit('exit',0));break
      default:throw Error('Unexpected loopback method: '+request.method)
    }
  }
  terminate(){this.model.close();this.events.emit('exit',0);return true}
  onSpawn(listener:()=>void){return this.listen('spawn',listener)}
  onMessage(listener:(message:unknown)=>void){return this.listen('message',listener)}
  onExit(listener:(code:number)=>void){return this.listen('exit',listener)}
  onFatal(listener:(message:string)=>void){return this.listen('fatal',listener)}
  private listen(event:string,listener:(...args:any[])=>void){this.events.on(event,listener);return()=>{this.events.off(event,listener)}}
}

function calls(...items:[string,string,Record<string,unknown>][]){return {choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:items.map(([id,name,args])=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}}))}}]}}
const answer=(content:string)=>({choices:[{finish_reason:'stop',message:{content}}]})
function result(body:ApiBody,id:string){const message=body.messages.find(m=>m.role==='tool'&&m.tool_call_id===id);expect(message,`missing tool result ${id}`).toBeDefined();return JSON.parse(message!.content)}

async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'mtc-ai-chat-flow-')),clients:CentralClient[]=[],stores:ChatStore[]=[],closers:(()=>Promise<void>)[]=[]
  const relay=createCentralServer({directory:path.join(root,'relay'),mode:'public',adminToken:'ai-chat-flow-test-admin-token-000001'})
  const url='http://127.0.0.1:'+(await relay.listen(0)).port
  return {
    relay,url,
    async member(name:string){
      const dir=path.join(root,name),store=await ChatStore.open(dir),files=new AttachmentStore(path.join(dir,'files'));stores.push(store);store.save(createSeedState())
      const client=new CentralClient(await ClientIdentity.load(dir,cipher),store,files,dir);clients.push(client)
      await client.connect(url,name)
      return {client,store,files}
    },
    async assistant(member:{store:ChatStore;files:AttachmentStore;client:CentralClient},script:(body:ApiBody,round:number)=>unknown|Promise<unknown>,sse=false,afterAccess?:(request:ChatAccessRequest)=>void){
      const bodies:ApiBody[]=[],errors:unknown[]=[],events:HostEventMessage[]=[]
      // Real HTTP request serialization and response parsing; no paid model or key.
      const endpoint=createServer(async(request,response)=>{
        try{
          expect(request.url).toBe('/v1/chat/completions')
          const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
          const body=JSON.parse(Buffer.concat(chunks).toString()) as ApiBody;bodies.push(body)
          expect(body.messages[0]).toEqual({role:'system',content:BUILTIN_ASSISTANT_PROMPT})
          const payload:any=await script(body,bodies.length-1)
          if(!sse){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(payload));return}
          response.writeHead(200,{'content-type':'text/event-stream'})
          const choice=payload.choices[0],toolCalls=choice.message.tool_calls??[]
          // Split function arguments into separate SSE deltas to exercise assembly.
          for(const [index,call] of toolCalls.entries()){
            const middle=Math.floor(call.function.arguments.length/2)
            for(const delta of [
              {index,id:call.id,function:{name:call.function.name,arguments:call.function.arguments.slice(0,middle)}},
              {index,function:{arguments:call.function.arguments.slice(middle)}},
            ])response.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[delta]}}]})+'\n\n')
          }
          response.write('data: '+JSON.stringify({choices:[{delta:{content:choice.message.content??''},finish_reason:choice.finish_reason}]})+'\n\n')
          response.end('data: [DONE]\n\n')
        }catch(error){errors.push(error);response.writeHead(500,{'content-type':'application/json'});response.end('{"error":"fixture assertion failed"}')}
      })
      await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve))
      closers.push(()=>new Promise<void>((resolve,reject)=>{endpoint.close(error=>error?reject(error):resolve());endpoint.closeAllConnections()}))
      let host!:LoopbackHost
      const access=createChatAccess(member.store,member.files,input=>member.client.send(input))
      const supervisor=new HostSupervisor({clientVersion:'0.3.0',credentials:new MemoryModelCredentials(),chatAccess:async request=>{const response=await access(request);afterAccess?.(request);return response},createProcess:generation=>(host=new LoopbackHost(path.join(root,'host'),generation))})
      closers.push(()=>supervisor.stop())
      supervisor.subscribeEvents(event=>events.push(event))
      await supervisor.start()
      await supervisor.setModelSettings({providerMode:'openai-compatible',apiKey:'local-test-only',baseUrl:'http://127.0.0.1:'+(endpoint.address() as {port:number}).port+'/v1',model:'scripted-test-model'})
      return {supervisor,host,bodies,errors,events,async run(){
        await supervisor.startModelChat({streamId:'flow',conversationId:'conversation-assistant',assistantMessageId:'reply',messages:[{role:'user',content:'读取我指定的好友或群记录和附件，再按我的要求发送消息。'}]})
        await until(()=>events.some(e=>['model.chat.completed','model.chat.failed','model.chat.cancelled'].includes(e.event)))
        expect(errors).toEqual([])
        return events.at(-1)
      }}
    },
    async close(){for(const close of closers.reverse())await close();for(const client of clients)await client.disconnect(false);await relay.close();for(const store of stores)store.close();await rm(root,{recursive:true,force:true})},
  }
}

it.each(['direct','group'] as const)('completes built-in AI list/history/attachment/send/retry flow for %s without plugins',async kind=>{
  const f=await fixture()
  try{
    const a=await f.member('A'),b=await f.member('B'),c=await f.member('C')
    await a.client.action('friends/request',{userId:b.client.identity.userId});await b.client.action('friends/accept',{userId:a.client.identity.userId})
    if(kind==='group'){await a.client.action('friends/request',{userId:c.client.identity.userId});await c.client.action('friends/accept',{userId:a.client.identity.userId})}
    const group=kind==='group'?(await a.client.action('groups',{name:'AI接口验收',memberIds:[b.client.identity.userId,c.client.identity.userId]})).directory!.groups[0]:undefined
    const source=a.store.conversationList().find(entry=>entry.targetId===(group?.id??b.client.identity.userId))!
    const text=await a.files.put(Buffer.from('第一行🙂\nBearer example-token\n尾行'),'记录.txt','text/plain')
    const image=await a.files.put(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=','base64'),'图片.png','image/png')
    for(const [key,ref] of [['source-text',text],['source-image',image]] as const)await a.client.send({conversationId:String(source.id),clientMessageId:key,text:key,attachmentId:ref.id,attachmentRef:ref})
    await until(()=>Boolean(b.store.messageByClient(f.relay.serverId,a.client.identity.userId,'source-image')))
    const incoming=b.store.messageByClient(f.relay.serverId,a.client.identity.userId,'source-text')!,conversationId=String(incoming.conversationId),unread=b.store.conversation(conversationId)!.unread
    await b.client.disconnect(false) // Model sends must honestly report offline queueing.
    let selected='',textId='',imageId='',cursor=0
    const ai=await f.assistant(b,async(body,round)=>{
      if(round===0){expect(body.tools?.map(t=>t.function.name)).toEqual(expect.arrayContaining(['list_conversations','read_chat_history','read_chat_attachment','send_chat_message']));return calls(['list','list_conversations',{}])}
      if(round===1){selected=result(body,'list').conversations.find((entry:any)=>entry.kind===kind&&entry.targetId===(group?.id??a.client.identity.userId)).id;return calls(['page1','read_chat_history',{conversationId:selected,after:-1,limit:1}])}
      if(round===2){const page=result(body,'page1');textId=page.messages[0].id;expect(page.messages[0].text).toBe('source-text');cursor=page.after;expect(Number.isSafeInteger(cursor)).toBe(true);expect(page.hasNewer).toBe(true);return calls(['page2','read_chat_history',{conversationId:selected,after:cursor,limit:1}])}
      if(round===3){imageId=result(body,'page2').messages[0].id;return calls(['text','read_chat_attachment',{conversationId:selected,messageId:textId,format:'text'}],['image','read_chat_attachment',{conversationId:selected,messageId:imageId,format:'image'}])}
      if(round===4){
        expect(result(body,'text').text).toBe('第一行🙂\nBearer [redacted]\n尾行')
        expect(result(body,'image')).not.toHaveProperty('image')
        expect(body.messages.at(-1)?.content).toEqual(expect.arrayContaining([{type:'image_url',image_url:{url:'data:image/png;base64,'+(await a.files.read(image.id,image)).data}}]))
        return calls(['send','send_chat_message',{conversationId:selected,clientMessageId:'ai-send',text:'用户指定的消息',attachmentMessageId:textId}])
      }
      if(round===5){expect(result(body,'send')).toMatchObject({queued:true,eventId:'ai-send'});return calls(['retry','send_chat_message',{conversationId:selected,clientMessageId:'ai-send',text:'用户指定的消息',attachmentMessageId:textId}])}
      if(round===6){
        expect(result(body,'retry')).toMatchObject({queued:true,eventId:'ai-send'})
        expect(b.store.outbox(f.relay.serverId)).toHaveLength(1)
        await b.client.connect(f.url,'B')
        await until(()=>b.store.outbox(f.relay.serverId).length===0&&Boolean(a.store.messageByClient(f.relay.serverId,b.client.identity.userId,'ai-send')))
        return calls(['final-history','read_chat_history',{conversationId:selected,limit:1}])
      }
      expect(round).toBe(7);expect(result(body,'final-history').messages[0]).toMatchObject({clientMessageId:'ai-send',status:'sent'})
      return answer('已按指定会话发送；接口读取不会改变未读状态。')
    },kind==='group')
    expect((await ai.run())?.event).toBe('model.chat.completed')
    expect(selected).toBe(conversationId);expect(ai.bodies).toHaveLength(8)
    expect(ai.supervisor.getStatus()).toEqual({state:'ready',generation:1})
    expect(b.store.conversation(conversationId)!.unread).toBe(unread);expect(b.store.pendingReads(f.relay.serverId)).toEqual([])
    const received=a.store.messageByClient(f.relay.serverId,b.client.identity.userId,'ai-send')!
    expect(received.text).toBe('用户指定的消息');expect(received.attachment).toMatchObject({name:'记录.txt',id:text.id})
    if(group)await until(()=>Boolean(c.store.messageByClient(f.relay.serverId,b.client.identity.userId,'ai-send')))
    else expect(c.store.messageByClient(f.relay.serverId,b.client.identity.userId,'ai-send')).toBeUndefined()
    expect(f.relay.db.prepare('SELECT COUNT(*) AS n FROM message_routes WHERE sender=? AND client_id=?').get(b.client.identity.userId,'ai-send').n).toBe(1)
    expect(JSON.stringify(ai.events)).not.toContain(image.id);expect(JSON.stringify(ai.events)).not.toContain('example-token')
    expect((await ai.host.drafts.inspect()).drafts).toEqual([])
  }finally{await f.close()}
},30000)

it('lets AI reconcile a send whose local acknowledgement failed without duplicating its queued message',async()=>{
  const f=await fixture()
  try{
    const a=await f.member('A'),b=await f.member('B')
    await a.client.action('friends/request',{userId:b.client.identity.userId});await b.client.action('friends/accept',{userId:a.client.identity.userId})
    const conversationId=String(b.store.conversationList().find(entry=>entry.targetId===a.client.identity.userId)!.id)
    await b.client.disconnect(false)
    let dropped=false
    const payload={conversationId,clientMessageId:'uncertain-send',text:'只应收到一次'}
    const ai=await f.assistant(b,async(body,round)=>{
      if(round===0)return calls(['list','list_conversations',{}])
      if(round===1){expect(result(body,'list').conversations.some((entry:any)=>entry.id===conversationId)).toBe(true);return calls(['send','send_chat_message',payload])}
      if(round===2){
        expect(result(body,'send')).toMatchObject({ok:false,conversationId,clientMessageId:'uncertain-send',error:'本机发送回执连接中断'})
        expect(result(body,'send').hint).toContain('超时不代表消息没有进入发送队列')
        return calls(['reconcile','read_chat_history',{conversationId,limit:1}])
      }
      if(round===3){expect(result(body,'reconcile').messages[0]).toMatchObject({clientMessageId:'uncertain-send',status:'queued'});return calls(['retry','send_chat_message',payload])}
      expect(round).toBe(4);expect(result(body,'retry')).toMatchObject({queued:true,eventId:'uncertain-send'})
      return answer('消息已在队列中，等待连接恢复；尚未确认对方收到。')
    },false,request=>{if(request.action==='send'&&!dropped){dropped=true;throw Error('本机发送回执连接中断')}})
    expect((await ai.run())?.event).toBe('model.chat.completed')
    expect(b.store.outbox(f.relay.serverId)).toHaveLength(1)
    await b.client.connect(f.url,'B')
    await until(()=>b.store.outbox(f.relay.serverId).length===0&&Boolean(a.store.messageByClient(f.relay.serverId,b.client.identity.userId,'uncertain-send')))
    expect(f.relay.db.prepare('SELECT COUNT(*) AS n FROM message_routes WHERE sender=? AND client_id=?').get(b.client.identity.userId,'uncertain-send').n).toBe(1)
    expect(ai.supervisor.getStatus()).toEqual({state:'ready',generation:1})
  }finally{await f.close()}
},30000)

it('stops only after five consecutive chat tool failures and requests a task-appropriate summary without tools',async()=>{
  const f=await fixture()
  try{
    const a=await f.member('A')
    const ai=await f.assistant(a,(body,round)=>{
      if(round<5)return calls(['read-'+round,'read_chat_history',{conversationId:'missing-'+round}])
      expect(round).toBe(5);expect(body.tools).toBeUndefined();expect(body.tool_choice).toBeUndefined()
      expect(body.messages.filter(m=>m.role==='tool')).toHaveLength(5)
      expect(body.messages.at(-1)?.content).toContain('说明已完成的操作和实际错误')
      expect(body.messages.at(-1)?.content).not.toContain('草稿')
      return answer('未找到指定会话，本轮未读取到记录，也没有发送消息。')
    })
    expect((await ai.run())?.event).toBe('model.chat.completed')
    expect(ai.bodies).toHaveLength(6)
    expect(ai.events.filter(e=>e.event==='model.authorTool'&&e.payload.phase==='finished'&&!e.payload.ok)).toHaveLength(5)
    expect(a.store.outbox(f.relay.serverId)).toEqual([])
  }finally{await f.close()}
},30000)

it('returns tool errors to AI, recovers with an exact conversation ID, and stops a later send batch on cancel',async()=>{
  const f=await fixture();let release=()=>{}
  try{
    const a=await f.member('A'),b=await f.member('B')
    await a.client.action('friends/request',{userId:b.client.identity.userId});await b.client.action('friends/accept',{userId:a.client.identity.userId})
    const conversationId=String(b.store.conversationList().find(entry=>entry.targetId===a.client.identity.userId)!.id)
    let waiting=false
    const originalRead=b.files.read.bind(b.files),gate=new Promise<void>(resolve=>{release=resolve})
    const file=await b.files.put(Buffer.from('测试文件'),'测试.txt','text/plain')
    await b.client.send({conversationId,clientMessageId:'source',text:'保留附件',attachmentId:file.id,attachmentRef:file})
    await until(()=>b.store.outbox(f.relay.serverId).length===0)
    const sourceId=String(b.store.messageByClient(f.relay.serverId,b.client.identity.userId,'source')!.id)
    b.files.read=async(...args)=>{const value=await originalRead(...args);waiting=true;await gate;return value}
    const ai=await f.assistant(b,(body,round)=>{
      if(round===0)return calls(['bad-send','send_chat_message',{conversationId:'不存在',clientMessageId:'bad-send',text:'不应发送'}],['bad-read','read_chat_history',{conversationId:'不存在'}])
      if(round===1){
        expect(result(body,'bad-send')).toMatchObject({ok:false,conversationId:'不存在',clientMessageId:'bad-send'})
        expect(result(body,'bad-read')).toMatchObject({ok:false})
        return calls(['list','list_conversations',{}])
      }
      expect(result(body,'list').conversations.some((entry:any)=>entry.id===conversationId)).toBe(true)
      return calls(['read','read_chat_attachment',{conversationId,messageId:sourceId,format:'text'}],['must-not-send','send_chat_message',{conversationId,clientMessageId:'must-not-send',text:'取消之后不可发送'}])
    })
    const running=ai.run()
    await until(()=>waiting)
    await ai.supervisor.cancelModelChat('flow');release()
    expect((await running)?.event).toBe('model.chat.cancelled')
    expect(ai.events.filter(e=>e.event==='model.authorTool'&&e.payload.phase==='finished'&&!e.payload.ok)).toHaveLength(2)
    expect(b.store.messageByClient(f.relay.serverId,b.client.identity.userId,'bad-send')).toBeUndefined()
    expect(b.store.messageByClient(f.relay.serverId,b.client.identity.userId,'must-not-send')).toBeUndefined()
    expect(ai.events.some(e=>e.event==='model.chat.failed')).toBe(false)
    expect(ai.supervisor.getStatus()).toEqual({state:'ready',generation:1})
  }finally{release();await f.close()}
},30000)
