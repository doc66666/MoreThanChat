import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { MAX_ATTACHMENT_BYTES } from '@more-than-chat/central-protocol'
import { createHostRequest, createHostSuccessResponse, parseHostMessage } from '@more-than-chat/protocol'
import { ChatStore } from '../src/main/chat-store'
import { AttachmentStore } from '../src/main/attachments'
import { createChatAccess } from '../src/main/chat-access'
import { CentralClient } from '../src/main/central-client'
import { ClientIdentity } from '../src/main/identity-store'
import { createCentralServer } from '../../central-server/src/server.mjs'

const folders:string[]=[],stores:ChatStore[]=[]
afterEach(async()=>{for(const s of stores.splice(0))s.close();for(const p of folders.splice(0))await rm(p,{recursive:true,force:true})})
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mtc-chat-access-'));folders.push(root)
 const store=await ChatStore.open(root);stores.push(store)
 const state=createSeedState(),id=state.activeConversationId,template=state.messages[id]![0]!
 state.conversations[0]={...state.conversations[0]!,kind:'direct',serverId:'server',transportId:'builtin.central',unread:120}
 state.messages[id]=Array.from({length:120},(_,i)=>({...template,id:'m'+i,clientMessageId:'m'+i,serverId:'server',role:'peer' as const,status:'sent' as const,text:'message '+i,createdAt:Date.now()+i}))
 store.save(state,undefined,{authoritative:true})
 const files=new AttachmentStore(path.join(root,'files')),send=vi.fn(async()=>({eventId:'sent',acceptedAt:1,queued:true})),access=createChatAccess(store,files,send)
 return {root,store,state,id,files,send,access,read:async(input:unknown)=>JSON.parse((await access(input)).dataJson)}
}
it('paginates full history, locates the first unread outside the projection, and does not read or send implicitly',async()=>{
 const {read,store,id,send}=await fixture()
 expect((await read({action:'list'})).conversations.map((c:{id:string})=>c.id)).toEqual([id])
 const page=await read({action:'history',conversationId:id})
 expect(page.firstUnreadId).toBe('m0')
 expect(page.messages).toHaveLength(50);expect(page.messages[0].id).toBe('m70')
 expect((await read({action:'history',conversationId:id,after:-1,limit:1})).messages[0].id).toBe('m0')
 expect((await read({action:'history',conversationId:id,before:page.before})).messages[0].id).toBe('m20')
 expect((await read({action:'history',conversationId:id,around:'m0'})).messages[0].id).toBe('m0')
 expect(store.firstUnread(id)).toBe('m0');expect(store.conversation(id)?.unread).toBe(120)
 expect(store.pendingReads('server')).toEqual([]);expect(send).not.toHaveBeenCalled()
 await expect(read({action:'history',conversationId:'absent'})).rejects.toThrow('找不到')
 await expect(read({action:'history',conversationId:id,before:3,after:5})).rejects.toThrow('游标')
 store.markConversationRead(id)
 const after=await read({action:'history',conversationId:id,limit:1})
 expect(after.firstUnreadId).toBeNull();expect(after.messages[0].readAt).toBeGreaterThan(0)
})
it('reads text, image and arbitrary bytes through message references, and forwards attachments through the existing sender',async()=>{
 const {read,store,state,id,files,send}=await fixture()
 const text=await files.put(Buffer.from('你好 world'),'hello.txt','text/plain')
 const image=await files.put(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=','base64'),'one.png','image/png')
 const binary=await files.put(Buffer.from([0,255,3,7]),'data.bin','application/octet-stream')
 for(const [i,attachment] of [text,image,binary].entries())state.messages[id]![i]!.attachment=attachment
 store.save(state,undefined,{authoritative:true})
 expect(await read({action:'attachment',conversationId:id,messageId:'m0',format:'text',limit:2})).toMatchObject({text:'你好',nextOffset:2})
 expect(await read({action:'attachment',conversationId:id,messageId:'m0',format:'text',offset:2})).toMatchObject({text:' world',nextOffset:null})
 expect(await read({action:'attachment',conversationId:id,messageId:'m1',format:'image'})).toMatchObject({image:{mime:'image/png',data:(await files.read(image.id)).data}})
 const chunk=await read({action:'attachment',conversationId:id,messageId:'m2',format:'base64',offset:1,limit:2})
 expect([...Buffer.from(chunk.data,'base64')]).toEqual([255,3]);expect(chunk.nextOffset).toBe(3)
 await expect(read({action:'attachment',conversationId:id,messageId:'m2',format:'text'})).rejects.toThrow('UTF-8')
 await expect(read({action:'attachment',conversationId:id,messageId:'m2',format:'image'})).rejects.toThrow('图片')
 await expect(read({action:'attachment',conversationId:id,messageId:'m3',format:'text'})).rejects.toThrow('附件消息')
 await expect(read({action:'attachment',conversationId:id,messageId:'m0',format:'text',path:'C:/secret'})).rejects.toThrow('参数')
 expect(await read({action:'send',conversationId:id,clientMessageId:'reply-1',text:'收到',attachmentMessageId:'m0'})).toMatchObject({queued:true})
 expect(send).toHaveBeenCalledWith({conversationId:id,clientMessageId:'reply-1',text:'收到',attachmentId:text.id,attachmentMessageId:'m0'})
 state.messages[id]![0]!.retractedAt=Date.now();store.save(state,undefined,{authoritative:true})
 await expect(read({action:'attachment',conversationId:id,messageId:'m0',format:'text'})).rejects.toThrow('附件消息')
})
it('delivers assistant sends through the real central queue and deduplicates retries',async()=>{
 const {root,store,files}=await fixture(),otherDir=path.join(root,'other'),other=await ChatStore.open(otherDir);stores.push(other);other.save(createSeedState())
 const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
 const a=new CentralClient(await ClientIdentity.load(root,cipher),store,files,root)
 const b=new CentralClient(await ClientIdentity.load(otherDir,cipher),other,new AttachmentStore(path.join(otherDir,'files')),otherDir)
 const relay=createCentralServer({directory:path.join(root,'relay'),mode:'public',adminToken:'qa-only-chat-access-admin-0001'})
 const url='http://127.0.0.1:'+(await relay.listen(0)).port
 const until=async(check:()=>boolean)=>{const end=Date.now()+6000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,25))}throw Error('chat access integration timeout')}
 try{
  await a.connect(url,'甲');await b.connect(url,'乙');await a.action('friends/request',{userId:b.identity.userId});await b.action('friends/accept',{userId:a.identity.userId})
  await until(()=>store.conversationList().some(c=>c.targetId===b.identity.userId))
  const conversationId=store.conversationList().find(c=>c.targetId===b.identity.userId)!.id
  const access=createChatAccess(store,files,input=>a.send(input)),request={action:'send',conversationId,clientMessageId:randomUUID(),text:'assistant queue integration'}
  await access(request);await until(()=>other.searchMessages(request.text).length===1)
  await access(request);await new Promise(r=>setTimeout(r,100));expect(other.searchMessages(request.text)).toHaveLength(1)
  await b.connect(url,'乙的新昵称');await until(()=>store.conversation(conversationId)?.title==='乙的新昵称')
  expect(b.snapshot().displayName).toBe('乙的新昵称')
 }finally{await a.disconnect(false);await b.disconnect(false);await relay.close()}
})

it('rechecks an attachment after asynchronous I/O if its message is withdrawn meanwhile',async()=>{
 const {read,store,state,id,files}=await fixture()
 const ref=await files.put(Buffer.from('withdraw during read'),'note.txt','text/plain')
 state.messages[id]![0]!.attachment=ref;store.save(state,undefined,{authoritative:true})
 const original=files.read.bind(files)
 vi.spyOn(files,'read').mockImplementation(async key=>{
  const wire=await original(key)
  state.messages[id]![0]!.retractedAt=Date.now();store.save(state,undefined,{authoritative:true})
  return wire
 })
 await expect(read({action:'attachment',conversationId:id,messageId:'m0',format:'text'})).rejects.toThrow('附件消息')
})

it('does not enqueue an attachment copy withdrawn while the sender reads its file',async()=>{
 const {root,read,store,state,id,files}=await fixture()
 const ref=await files.put(Buffer.from('withdraw during send'),'note.txt','text/plain')
 state.messages[id]![0]!.attachment=ref;store.save(state,undefined,{authoritative:true});store.rememberServerOrigin('server','http://localhost:9998')
 const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
 const client=new CentralClient(await ClientIdentity.load(root,cipher),store,files,root)
 const original=files.read.bind(files)
 vi.spyOn(files,'read').mockImplementation(async key=>{
  const wire=await original(key);state.messages[id]![0]!.retractedAt=Date.now();store.save(state,undefined,{authoritative:true});return wire
 })
 const access=createChatAccess(store,files,input=>client.send(input))
 await expect(access({action:'send',conversationId:id,clientMessageId:'withdraw-copy',text:'copy',attachmentMessageId:'m0'})).rejects.toThrow('未发送')
 expect(store.outbox('server')).toEqual([])
 expect((await read({action:'history',conversationId:id})).messages.some((m:{text:string})=>m.text==='copy')).toBe(false)
})

it('rejects cross-conversation attachment/history references without sending or changing reads',async()=>{
 const {read,store,state,id,files,send}=await fixture()
 state.conversations.push({...state.conversations[0]!,id:'second',kind:'group'})
 const ref=await files.put(Buffer.from('second conversation'),'other.txt','text/plain')
 state.messages.second=[{...state.messages[id]![0]!,id:'foreign-message',clientMessageId:'foreign-message',conversationId:'second',attachment:ref}]
 store.save(state,undefined,{authoritative:true})
 await expect(read({action:'history',conversationId:id,around:'foreign-message'})).rejects.toThrow('消息不存在')
 await expect(read({action:'attachment',conversationId:id,messageId:'foreign-message',format:'text'})).rejects.toThrow('附件消息')
 await expect(read({action:'send',conversationId:id,clientMessageId:'cross',text:'copy',attachmentMessageId:'foreign-message'})).rejects.toThrow('附件消息')
 expect(send).not.toHaveBeenCalled();expect(store.pendingReads('server')).toEqual([])
 expect((await read({action:'attachment',conversationId:'second',messageId:'foreign-message',format:'text'})).text).toBe('second conversation')
})

it('does not reuse a sent logical message ID across servers and lose a new outbox entry',async()=>{
 const {root,store,state,id,files}=await fixture()
 const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
 const identity=await ClientIdentity.load(root,cipher),client=new CentralClient(identity,store,files,root)
 const second='server-two:conversation'
 state.conversations.push({...state.conversations[0]!,id:second,serverId:'server-two'})
 state.messages[second]=[]
 const canonical=randomUUID()
 state.messages[id]!.push({...state.messages[id]![0]!,id:canonical,clientMessageId:'same-logical-id',senderId:identity.userId,role:'self',status:'sent'})
 store.save(state,undefined,{authoritative:true});store.rememberServerOrigin('server-two','http://localhost:9999')
 const access=createChatAccess(store,files,input=>client.send(input))
 await expect(access({action:'send',conversationId:second,clientMessageId:'same-logical-id',text:'another server'})).rejects.toThrow('消息 ID')
 expect(store.outbox('server-two')).toEqual([])
 expect(store.message(canonical)?.text).toBe('message 0')
})

it('cannot overwrite a received message by using its message ID as the new send ID',async()=>{
 const {root,store,id,files}=await fixture()
 const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
 const client=new CentralClient(await ClientIdentity.load(root,cipher),store,files,root)
 store.rememberServerOrigin('server','http://localhost:9998')
 const before=store.message('m0'),access=createChatAccess(store,files,input=>client.send(input))
 await expect(access({action:'send',conversationId:id,clientMessageId:'m0',text:'accidental collision'})).rejects.toThrow('消息 ID')
 expect(store.message('m0')).toEqual(before);expect(store.outbox('server')).toEqual([])
})

it('retries concurrently without duplicates, but cannot change the target or content of a queued send',async()=>{
 const {root,store,state,id,files}=await fixture()
 const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
 const client=new CentralClient(await ClientIdentity.load(root,cipher),store,files,root)
 state.conversations.push({...state.conversations[0]!,id:'other-target'});state.messages['other-target']=[]
 store.save(state,undefined,{authoritative:true});store.rememberServerOrigin('server','http://localhost:9998')
 const access=createChatAccess(store,files,input=>client.send(input)),request={action:'send',conversationId:id,clientMessageId:'one-send',text:'original'}
 await Promise.all([access(request),access(request)])
 expect(store.outbox('server')).toHaveLength(1)
 expect(store.searchMessages('original',id)).toHaveLength(1)
 await expect(access({...request,text:'replacement'})).rejects.toThrow('不能替换内容')
 await expect(access({...request,conversationId:'other-target'})).rejects.toThrow('不能替换会话')
 expect(store.message('one-send')?.text).toBe('original');expect(store.outbox('server')).toHaveLength(1)
})

it('keeps each source message attachment name and media type when identical bytes were stored again',async()=>{
 const {root,store,state,id,files}=await fixture()
 const bytes=Buffer.from('same bytes with different names'),first=await files.put(bytes,'original.txt','text/plain')
 state.messages[id]![0]!.attachment=first;store.save(state,undefined,{authoritative:true})
 const second=await files.put(bytes,'renamed.bin','application/octet-stream')
 state.messages[id]![1]!.attachment=second;store.save(state,undefined,{authoritative:true})
 const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
 const client=new CentralClient(await ClientIdentity.load(root,cipher),store,files,root)
 store.rememberServerOrigin('server','http://localhost:9998')
 const access=createChatAccess(store,files,input=>client.send(input))
 await access({action:'send',conversationId:id,clientMessageId:'copy-original',text:'',attachmentMessageId:'m0'})
 expect(store.message('copy-original')?.attachment).toEqual(first)
 // Same content hash is not the same message attachment: do not mutate a queued copy on retry.
 await expect(access({action:'send',conversationId:id,clientMessageId:'copy-original',text:'',attachmentMessageId:'m1'})).rejects.toThrow('不能替换内容')
 await client.retryMessage('copy-original')
 expect(store.message('copy-original')?.attachment).toEqual(first)
})

it('keeps text attachment chunks well-formed at supplementary Unicode boundaries',async()=>{
 const {read,store,state,id,files}=await fixture(),text='A🙂𠮷字B'
 const ref=await files.put(Buffer.from(text),'unicode.txt','text/plain')
 state.messages[id]![0]!.attachment=ref;store.save(state,undefined,{authoritative:true})
 const parts:string[]=[];let offset=0
 do{
  const page=await read({action:'attachment',conversationId:id,messageId:'m0',format:'text',offset,limit:1})
  expect(page.text.isWellFormed()).toBe(true)
  parts.push(page.text);offset=page.nextOffset??-1
 }while(offset>=0)
 expect(parts.join('')).toBe(text)
 // Arbitrary offsets must not expose a dangling low surrogate either.
 await expect(read({action:'attachment',conversationId:id,messageId:'m0',format:'text',offset:2,limit:1})).rejects.toThrow('字符中间')
 const eof=await read({action:'attachment',conversationId:id,messageId:'m0',format:'text',offset:text.length,limit:1})
 expect(eof).toMatchObject({text:'',nextOffset:null,total:text.length})
})

it.each(['direct','group'] as const)('returns delivery errors in %s history without sending or marking it read',async kind=>{
 const {read,store,state,id,send}=await fixture()
 state.conversations[0]!.kind=kind
 const message=state.messages[id]!.at(-1)!
 Object.assign(message,{role:'self',status:'failed',errorMessage:'当前好友或群关系已不可用'})
 store.save(state,undefined,{authoritative:true})
 expect((await read({action:'history',conversationId:id,limit:1})).messages[0]).toMatchObject({status:'failed',errorMessage:'当前好友或群关系已不可用'})
 expect(send).not.toHaveBeenCalled();expect(store.pendingReads('server')).toEqual([])
})

it('reports a missing local attachment clearly and leaves its message available to read',async()=>{
 const {read,store,state,id,files}=await fixture()
 const ref=await files.put(Buffer.from('file missing'),'missing.txt','text/plain')
 state.messages[id]![0]!.attachment=ref;store.save(state,undefined,{authoritative:true})
 await unlink(path.join(files.directory,ref.id))
 await expect(read({action:'attachment',conversationId:id,messageId:'m0',format:'text'})).rejects.toThrow('本机附件文件不存在')
 expect((await read({action:'history',conversationId:id,around:'m0'})).messages[0].attachment).toEqual(ref)
 expect(store.pendingReads('server')).toEqual([])
})

it('paginates all saved friend/group entries and excludes the assistant without changing their availability',async()=>{
 const {read,store,state,id}=await fixture(),base=state.conversations[0]!
 const expected=[id]
 for(let i=0;i<137;i++){
  const conversationId='page-'+i;expected.push(conversationId)
  state.conversations.push({...base,id:conversationId,title:'同名',kind:i%2?'direct':'group',serverId:'server-'+(i%3),unavailable:i%5===0})
  state.messages[conversationId]=[]
 }
 state.conversations.push({...base,id:'assistant-only',kind:'assistant',serverId:undefined})
 state.messages['assistant-only']=[];store.save(state,undefined,{authoritative:true})
 const found:{id:string;available:boolean}[]=[];let offset=0
 do{
  const page=await read({action:'list',offset,limit:31});expect(page.conversations.length).toBeLessThanOrEqual(31)
  found.push(...page.conversations);offset=page.nextOffset??-1
 }while(offset>=0)
 expect(found.map(entry=>entry.id)).toEqual(expected)
 expect(found.find(entry=>entry.id==='page-0')?.available).toBe(false)
 expect(found.find(entry=>entry.id==='page-1')?.available).toBe(true)
 expect(await read({action:'list',offset:999})).toMatchObject({conversations:[],nextOffset:null})
 expect(store.conversation(id)?.unread).toBe(120)
})

it('round trips a maximum-size image through the same result envelope used by the assistant',async()=>{
 const {read,store,state,id,files}=await fixture()
 const bytes=Buffer.alloc(MAX_ATTACHMENT_BYTES,7),ref=await files.put(bytes,'max-image.png','image/png')
 state.messages[id]![0]!.attachment=ref;store.save(state,undefined,{authoritative:true})
 const value=await read({action:'attachment',conversationId:id,messageId:'m0',format:'image'})
 const request=createHostRequest('chat.access','image-maximum',{action:'attachment',conversationId:id,messageId:'m0',format:'image'})
 const response=createHostSuccessResponse(request,{dataJson:JSON.stringify(value)})
 expect(parseHostMessage(response)).toEqual(response)
 expect(Buffer.from(value.image.data,'base64').equals(bytes)).toBe(true)
 // This checks byte transport, not image decoding or model vision capability.
})
