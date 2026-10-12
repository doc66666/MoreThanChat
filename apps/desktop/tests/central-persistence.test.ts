import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'

describe('central client durability',()=>{
  it('keeps the main-owned outbox and receipts authoritative despite a stale renderer save',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-outbox-store-')),store=await ChatStore.open(root)
    try{
      store.save(createSeedState())
      const state=store.load()!,id='srv:direct'
      state.conversations.push({id,title:'Friend',subtitle:'Central',avatar:'F',accent:'#123',kind:'direct',unread:2,pinned:false,updatedAt:1,transportId:'builtin.central',serverId:'srv'})
      state.messages[id]=[{id:'pending',clientMessageId:'pending',conversationId:id,senderId:'self',senderName:'Self',senderAvatar:'S',role:'self',type:'text',text:'Example sk-synthetic-preserved-text',createdAt:1,status:'queued',serverId:'srv'}]
      store.save(state,undefined,{authoritative:true,outboxPut:{serverId:'srv',conversationId:id,clientMessageId:'pending',createdAt:1}})
      const stale=structuredClone(store.load()!)
      stale.messages[id]![0]!.status='sent';stale.conversations.find(c=>c.id===id)!.unread=0
      store.save(stale)
      expect(store.outbox('srv')).toHaveLength(1)
      expect(store.load()!.messages[id]![0]!.status).toBe('queued')
      expect(store.load()!.conversations.find(c=>c.id===id)!.unread).toBe(2)
      const accepted=store.load()!;accepted.messages[id]![0]!.status='sent';accepted.messages[id]![0]!.receipt={recipientCount:1,deliveredCount:1,readCount:1}
      store.save(accepted,undefined,{authoritative:true,outboxRemove:'pending'})
      store.save(stale)
      expect(store.outbox('srv')).toHaveLength(0)
      expect(store.load()!.messages[id]![0]!.receipt).toEqual({recipientCount:1,deliveredCount:1,readCount:1})
      expect(store.load()!.messages[id]![0]!.text).toContain('sk-synthetic-preserved-text')
      expect(store.searchMessages('sk-synthetic','srv:direct')).toHaveLength(1)
      expect(store.searchMessages('sk-synthetic','conversation-assistant')).toHaveLength(0)
      expect(store.searchMessages("' OR 1=1")).toEqual([])
    }finally{store.close();await rm(root,{recursive:true,force:true})}
  })
  it('does not erase an acknowledged incoming message with a stale renderer snapshot',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-incoming-')),store=await ChatStore.open(root),stale=createSeedState()
    try{
      store.save(stale)
      const current=store.load()!,id='srv:test'
      current.conversations.push({id,title:'Friend',subtitle:'Central',avatar:'F',accent:'#123',kind:'direct',unread:1,pinned:false,updatedAt:1,transportId:'builtin.central',serverId:'srv'})
      current.messages[id]=[{id:'incoming',clientMessageId:'client',conversationId:id,senderId:'friend',senderName:'Friend',senderAvatar:'F',role:'peer',type:'text',text:'durable',createdAt:1,status:'sent',serverId:'srv'}]
      store.save(current);store.save(stale)
      expect(store.load()?.messages[id]?.[0]?.text).toBe('durable')
    }finally{store.close();await rm(root,{recursive:true,force:true})}
  })
  it('restores the same global identity and commits attachment bytes before providing the reference',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-identity-'))
    const cipher={available:()=>true,encrypt:(text:string)=>Buffer.from(text),decrypt:(bytes:Buffer)=>bytes.toString()}
    try{
      const first=await ClientIdentity.load(root,cipher),second=await ClientIdentity.load(root,cipher)
      expect(second.userId).toBe(first.userId);expect(first.userId).toMatch(/^usr_[a-f0-9]{64}$/)
      const files=new AttachmentStore(path.join(root,'attachments')),bytes=Buffer.from('test file')
      const ref=await files.put(bytes,'file.txt','text/plain'),wire=await files.read(ref.id)
      expect(Buffer.from(wire.data,'base64')).toEqual(bytes)
      await expect(files.receive({...wire,data:Buffer.from('tampered').toString('base64')})).rejects.toThrow()
      await expect(files.read('../identity-secret.bin')).rejects.toThrow()
    }finally{await rm(root,{recursive:true,force:true})}
  })
})
