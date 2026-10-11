import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'

describe('central client durability',()=>{
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
