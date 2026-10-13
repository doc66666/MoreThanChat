import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createSeedState, type ChatMessage } from '@more-than-chat/chat-core'
import { ChatStore } from '../src/main/chat-store'

const folders:string[]=[],stores:ChatStore[]=[]
afterEach(async()=>{for(const store of stores.splice(0))store.close();for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true})})
async function folder(){const dir=await mkdtemp(path.join(tmpdir(),'mtc-history-'));folders.push(dir);return dir}
async function open(dir:string){const store=await ChatStore.open(dir);stores.push(store);return store}
function history(count:number,body='历史消息') {
  const state=createSeedState(1700000000000),conversationId=state.activeConversationId,template=state.messages[conversationId]![0]!
  state.messages[conversationId]=Array.from({length:count},(_,i):ChatMessage=>({...template,id:'history-'+i,clientMessageId:'client-'+i,text:body+' '+i,createdAt:1700000000000+i}))
  return state
}

describe('bounded SQLite history',()=>{
  it('migrates a history larger than 8 MiB, keeps a backup and loads only the newest page',async()=>{
    const dir=await folder(),state=history(1400,'large-history '+ 'x'.repeat(6500)),raw=JSON.stringify(state)
    expect(Buffer.byteLength(raw)).toBeGreaterThan(8*1024*1024)
    await writeFile(path.join(dir,'chat-state.json'),raw)
    const store=await open(dir),view=store.loadView()!,id=state.activeConversationId
    expect(view.messages[id]).toHaveLength(50)
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(512*1024)
    expect(view.messages[id]![0]!.id).toBe('history-1350')
    expect(view.history[id]).toMatchObject({hasOlder:true,hasNewer:false,before:1350})
    expect(await readFile(path.join(dir,'chat-state.json.migrated'),'utf8')).toBe(raw)
    // Saving a bounded view is not a request to delete messages outside it.
    store.save(view);store.close()
    const restored=await open(dir)
    expect(restored.message('history-0')?.text).toBe(state.messages[id]![0]!.text)
    expect(restored.searchMessages('large-history',id)).toHaveLength(50)
    const db=new DatabaseSync(path.join(dir,'chat.sqlite'),{readOnly:true})
    try{expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n).toBe(1400);expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')}finally{db.close()}
  },20000)

  it('uses stable keyset cursors with no gaps or duplicates during concurrent arrivals',async()=>{
    const store=await open(await folder()),state=history(173),id=state.activeConversationId
    store.save(state)
    const first=store.messagePage(id),seen=first.messages.map(m=>m.id)
    const partial=store.load()!
    partial.messages[id]=[{...state.messages[id]![0]!,id:'arrival',clientMessageId:'arrival',createdAt:1800000000000,text:'new arrival'}]
    store.save(partial)
    let page=first
    while(page.hasOlder){page=store.messagePage(id,{before:page.before!});seen.unshift(...page.messages.map(m=>m.id))}
    expect(seen).toEqual(state.messages[id]!.map(m=>m.id))
    expect(new Set(seen).size).toBe(173)
    expect(store.messagePage(id,{after:first.after!}).messages.map(m=>m.id)).toEqual(['arrival'])
    const around=store.messagePage(id,{around:'history-43'})
    expect(around.messages.some(m=>m.id==='history-43')).toBe(true)
    expect(around.hasOlder).toBe(true);expect(around.hasNewer).toBe(true)
  })

  it('bounds pages by bytes as well as count and does not skip large neighbours',async()=>{
    const store=await open(await folder()),state=history(12,'x'.repeat(180000)),id=state.activeConversationId
    store.save(state)
    const latest=store.messagePage(id)
    expect(latest.messages).toHaveLength(2)
    expect(latest.messages.map(m=>m.id)).toEqual(['history-10','history-11'])
    expect(store.messagePage(id,{before:latest.before!}).messages.map(m=>m.id)).toEqual(['history-8','history-9'])
    const around=store.messagePage(id,{around:'history-5'})
    expect(around.messages.map(m=>m.id)).toEqual(['history-4','history-5'])
    expect(store.messagePage(id,{after:around.after!}).messages[0]!.id).toBe('history-6')
  })

  it('keeps a canonical receipt on the same timeline position and rejects stale renderer mutation',async()=>{
    const store=await open(await folder()),state=history(100),id=state.activeConversationId
    state.conversations[0]!.serverId='server';state.conversations[0]!.transportId='builtin.central'
    for(const m of state.messages[id]!){m.serverId='server';m.senderId='self';m.role='self'}
    state.messages[id]![0]!.status='queued'
    store.save(state,undefined,{authoritative:true,outboxPut:{serverId:'server',conversationId:id,clientMessageId:'client-0',createdAt:1}})
    const stale=store.load()!,canonical=randomUUID(),update=store.load()!,old=store.messageByClient('server','self','client-0')!
    update.messages[id]=[{...old,id:canonical,status:'sent',receipt:{recipientCount:2,deliveredCount:1,readCount:0}}]
    store.save(update,undefined,{authoritative:true,outboxRemove:'client-0'})
    store.save(stale)
    expect(store.message('history-0')).toBeUndefined()
    expect(store.message(canonical)?.status).toBe('sent')
    expect(store.outbox('server')).toEqual([])
    expect(store.messagePage(id,{around:canonical}).before).toBe(0)
    expect(store.messagePage(id,{around:canonical}).messages[0]!.id).toBe(canonical)
    expect(store.messageByClient('server','self','client-0')?.receipt).toEqual({recipientCount:2,deliveredCount:1,readCount:0})
  })

  it('marks and queues reads for unread messages outside the loaded page atomically',async()=>{
    const store=await open(await folder()),state=history(125),id=state.activeConversationId
    state.conversations[0]!.serverId='server';state.conversations[0]!.unread=125
    for(const m of state.messages[id]!){m.id=randomUUID();m.serverId='server'}
    store.save(state,undefined,{authoritative:true})
    expect(store.load()!.messages[id]).toHaveLength(50)
    expect(store.markConversationRead(id)).toBe(true)
    expect(store.message(state.messages[id]![0]!.id)?.readAt).toBeGreaterThan(0)
    expect(store.load()!.conversations[0]!.unread).toBe(0)
    expect(store.pendingReads('server')).toHaveLength(100)
    store.confirmReads('server',store.pendingReads('server'))
    expect(store.pendingReads('server')).toHaveLength(25)
    expect(store.markConversationRead(id)).toBe(false)
  })

  it('migrates v3 archives into visible relationships and builds the search index without losing text',async()=>{
    const dir=await folder(),store=await open(dir),state=history(100)
    store.save(state);store.close()
    const db=new DatabaseSync(path.join(dir,'chat.sqlite'))
    // Reconstruct the old schema too, not just its version number.
    db.exec('DROP INDEX plugin_pending_ack; ALTER TABLE plugin_inbox DROP COLUMN acknowledged;')
    db.exec("DROP TRIGGER message_search_insert;DROP TRIGGER message_search_delete;DROP TRIGGER message_search_update;DROP TABLE message_search;UPDATE conversations SET payload=json_set(payload,'$.archived',1);PRAGMA user_version=3;");db.close()
    const migrated=await open(dir)
    expect(migrated.load()!.conversations[0]!.archived).toBeUndefined()
    expect(migrated.message('history-0')?.text).toBe('历史消息 0')
    expect(migrated.searchMessages('历史消息 0')).toHaveLength(1)
  })

  it('maintains literal substring search across edits, short Chinese words and index updates',async()=>{
    const store=await open(await folder()),state=history(1,'字面词 [hello] "quoted" mixedCASE 接龙'),id=state.activeConversationId
    store.save(state)
    for(const query of ['接龙','[hello]','"quoted"','mixedcase'])expect(store.searchMessages(query,id)).toHaveLength(1)
    state.messages[id]![0]!.text='替换后的新内容';store.save(state)
    expect(store.searchMessages('[hello]',id)).toHaveLength(0)
    expect(store.searchMessages('新内容',id)).toHaveLength(1)
    expect(store.searchMessages("' OR 1=1")).toEqual([])
  })

  it('rejects malformed or mixed page cursors without changing storage',async()=>{
    const store=await open(await folder()),state=history(4),id=state.activeConversationId
    store.save(state)
    for(const input of [{before:-1},{after:NaN},{limit:101},{limit:1.5},{before:0,after:2},{around:'missing'}])expect(()=>store.messagePage(id,input)).toThrow()
    expect(store.messagePage(id).messages).toHaveLength(4)
  })
  it('recovers interrupted AI turns outside the first page without changing network outbox state',async()=>{
    const dir=await folder(),store=await open(dir),state=history(150),id=state.activeConversationId
    state.messages[id]![0]!.status='streaming';state.messages[id]![1]!.status='sending'
    state.messages[id]![2]!.status='queued';state.messages[id]![2]!.serverId='server'
    store.save(state,undefined,{authoritative:true,outboxPut:{serverId:'server',conversationId:id,clientMessageId:'client-2',createdAt:1}})
    store.close()
    const restored=await open(dir)
    expect(restored.load()!.messages[id]!.some(m=>m.id==='history-0')).toBe(false)
    expect(restored.message('history-0')?.status).toBe('cancelled')
    expect(restored.message('history-1')?.status).toBe('failed')
    expect(restored.message('history-2')?.status).toBe('queued')
    expect(restored.outbox('server')).toHaveLength(1)
  })
})
