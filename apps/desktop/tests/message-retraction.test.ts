import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach,describe,expect,it } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { createMessageReference,type MessageRetraction } from '@more-than-chat/central-protocol'
import { ChatStore } from '../src/main/chat-store'

const folders:string[]=[],stores:ChatStore[]=[]
afterEach(async()=>{for(const store of stores)store.close();for(const folder of folders)await rm(folder,{recursive:true,force:true});folders.length=stores.length=0})
async function setup(){
  const dir=await mkdtemp(path.join(tmpdir(),'mtc-retraction-')),store=await ChatStore.open(dir);folders.push(dir);stores.push(store)
  const state=createSeedState(),conversationId=state.activeConversationId,serverId='srv_test',senderId='usr_'+'a'.repeat(64),messageId=randomUUID(),clientMessageId=randomUUID()
  state.profile.id=senderId;state.conversations[0]!.serverId=serverId;state.conversations[0]!.transportId='builtin.central'
  const message={...state.messages[conversationId]![0]!,id:clientMessageId,clientMessageId,senderId,senderName:'A',role:'self' as const,text:'withdraw-secret-body-72891',serverId,status:'queued' as const,actionsSupported:true,attachment:{id:'a'.repeat(64),name:'private-note.txt',mime:'text/plain',size:2}}
  const reference=createMessageReference({...message,id:messageId})
  const quote={...message,id:randomUUID(),clientMessageId:randomUUID(),text:'reply-keep',status:'sent' as const,quote:reference,attachment:undefined}
  const forwarded={...quote,id:randomUUID(),clientMessageId:randomUUID(),text:message.text,quote:undefined,forwarded:reference}
  state.messages[conversationId]=[message,quote,forwarded]
  const notice:MessageRetraction={messageId,clientMessageId,conversationId,senderId,senderName:'A',createdAt:message.createdAt,retractedAt:message.createdAt+1,targetKind:'direct',targetId:'usr_'+'b'.repeat(64),targetName:'B'}
  store.save(state,undefined,{authoritative:true,outboxPut:{serverId,conversationId,clientMessageId,createdAt:message.createdAt}})
  return{dir,store,state,message,quote,forwarded,notice,serverId,conversationId}
}
describe('durable message tombstones',()=>{
  it('redacts canonical and pending aliases, reference excerpts and diagnostic copies while preserving independent forwards',async()=>{
    const f=await setup(),stale=structuredClone(f.state)
    f.store.save(f.store.load()!,undefined,{authoritative:true,retraction:{serverId:f.serverId,notice:f.notice}})
    expect(f.store.message(f.message.id)).toBeUndefined()
    expect(f.store.message(f.notice.messageId)).toMatchObject({text:'',retractedAt:f.notice.retractedAt,status:'sent'})
    expect(f.store.message(f.notice.messageId)).not.toHaveProperty('attachment')
    expect(f.store.message(f.quote.id)?.quote).toMatchObject({text:'引用的消息已撤回',retracted:true})
    expect(f.store.message(f.quote.id)?.quote).not.toHaveProperty('attachmentName')
    expect(f.store.message(f.forwarded.id)?.text).toBe(f.message.text)
    expect(f.store.searchMessages('withdraw-secret-body')).toHaveLength(1)
    expect(f.store.outbox(f.serverId)).toEqual([])
    const db=new DatabaseSync(path.join(f.dir,'chat.sqlite'),{readOnly:true})
    try{expect(JSON.stringify(db.prepare('SELECT payload FROM chat_events WHERE entity_id IN (?,?,?)').all(f.message.id,f.notice.messageId,f.quote.id))).not.toContain(f.message.text)}finally{db.close()}
    // Neither a stale renderer nor a delayed Main delivery can resurrect the body.
    f.store.save(stale);f.store.save(stale,undefined,{authoritative:true,outboxPut:{serverId:f.serverId,conversationId:f.conversationId,clientMessageId:f.notice.clientMessageId,createdAt:f.notice.createdAt},readMessages:[{serverId:f.serverId,messageId:f.notice.messageId}]})
    expect(f.store.message(f.notice.messageId)?.text).toBe('');expect(f.store.outbox(f.serverId)).toEqual([]);expect(f.store.pendingReads(f.serverId)).toEqual([])
    f.store.close();const reopened=await ChatStore.open(f.dir);stores.push(reopened)
    expect(reopened.retraction(f.serverId,f.notice.messageId)).toEqual(f.notice)
    expect(reopened.message(f.notice.messageId)?.text).toBe('')
  })
  it('rolls back body redaction, tombstones, outbox and full-text index together when the transaction fails',async()=>{
    const f=await setup(),db=new DatabaseSync(path.join(f.dir,'chat.sqlite'))
    try{
      db.exec("CREATE TRIGGER fail_retraction BEFORE INSERT ON chat_events WHEN new.kind='message.retracted' BEGIN SELECT RAISE(ABORT,'injected retraction failure'); END")
      expect(()=>f.store.save(f.store.load()!,undefined,{authoritative:true,retraction:{serverId:f.serverId,notice:f.notice}})).toThrow('injected retraction failure')
      expect(f.store.message(f.message.id)?.text).toBe(f.message.text)
      expect(f.store.retraction(f.serverId,f.notice.messageId)).toBeUndefined()
      expect(f.store.outbox(f.serverId)).toHaveLength(1)
      expect(f.store.searchMessages('withdraw-secret-body')).toHaveLength(2)
    }finally{db.close()}
  })
  it('never redacts the same message id under another server namespace',async()=>{
    const f=await setup()
    f.store.save(f.store.load()!,undefined,{authoritative:true,retraction:{serverId:'other-server',notice:f.notice}})
    expect(f.store.message(f.message.id)?.text).toBe(f.message.text)
    expect(f.store.outbox(f.serverId)).toHaveLength(1)
    expect(f.store.retraction(f.serverId,f.notice.messageId)).toBeUndefined()
  })
})
