import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Directory } from '@more-than-chat/central-protocol'
import { MessageSearchController } from '../src/renderer/src/message-search-controller'
import { AttachmentPreview } from '../src/renderer/src/attachment-preview'
import { friendRequestIssue, selectedCurrentFriends } from '../src/renderer/src/network-form'

function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (error:Error)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve()}

describe('message search recovery',()=>{
  beforeEach(()=>vi.useFakeTimers())
  afterEach(()=>vi.useRealTimers())
  it('debounces requests and trims the actual search input',async()=>{
    const search=vi.fn(async()=>['found']),publish=vi.fn(),controller=new MessageSearchController(search,publish)
    controller.run('old','a');controller.run(' new ','b')
    expect(publish).toHaveBeenLastCalledWith({status:'loading',results:[],error:''})
    vi.advanceTimersByTime(180);await flush()
    expect(search).toHaveBeenCalledOnce();expect(search).toHaveBeenCalledWith('new','b')
    expect(publish).toHaveBeenLastCalledWith({status:'ready',results:['found'],error:''})
  })
  it('clearing an in-flight search stops the spinner and ignores its result',async()=>{
    const pending=deferred<string[]>(),search=vi.fn(()=>pending.promise),publish=vi.fn(),controller=new MessageSearchController(search,publish)
    controller.run('needle');vi.advanceTimersByTime(180);controller.run('   ')
    expect(publish).toHaveBeenLastCalledWith({status:'idle',results:[],error:''})
    pending.resolve(['stale']);await flush()
    expect(publish).toHaveBeenLastCalledWith({status:'idle',results:[],error:''})
    expect(search).toHaveBeenCalledOnce()
  })
  it('clears previous results as soon as a different query is scheduled',async()=>{
    const publish=vi.fn(),controller=new MessageSearchController(async()=>['old'],publish)
    controller.run('old');vi.advanceTimersByTime(180);await flush();controller.run('new')
    expect(publish).toHaveBeenLastCalledWith({status:'loading',results:[],error:''})
    controller.cancel()
  })
  it('changing scope rejects late errors from the old conversation',async()=>{
    const old=deferred<string[]>(),publish=vi.fn(),search=vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(['all'])
    const controller=new MessageSearchController(search,publish)
    controller.run('same','room');vi.advanceTimersByTime(180)
    controller.run('same');vi.advanceTimersByTime(180);await flush()
    old.reject(new Error('late'));await flush()
    expect(publish).toHaveBeenLastCalledWith({status:'ready',results:['all'],error:''})
  })
  it('failed requests can be retried immediately without changing the query',async()=>{
    const publish=vi.fn(),search=vi.fn().mockRejectedValueOnce(new Error('disk busy')).mockResolvedValueOnce(['recovered'])
    const controller=new MessageSearchController(search,publish)
    controller.run('word');vi.advanceTimersByTime(180);await flush()
    expect(publish).toHaveBeenLastCalledWith({status:'error',results:[],error:'disk busy'})
    controller.run('word',undefined,0);vi.advanceTimersByTime(0);await flush()
    expect(publish).toHaveBeenLastCalledWith({status:'ready',results:['recovered'],error:''})
  })
  it('closing before debounce never calls the bridge',()=>{
    const search=vi.fn(),controller=new MessageSearchController(search,vi.fn())
    controller.run('word');controller.cancel();vi.advanceTimersByTime(1000)
    expect(search).not.toHaveBeenCalled()
  })
  it('closing during a request never publishes its late result',async()=>{
    const pending=deferred<string[]>(),publish=vi.fn(),controller=new MessageSearchController(()=>pending.promise,publish)
    controller.run('word');vi.advanceTimersByTime(180);controller.cancel();publish.mockClear()
    pending.resolve(['late']);await flush();expect(publish).not.toHaveBeenCalled()
  })
})

function previewFixture(){
  const options={read:vi.fn(async()=>({data:'encoded'})),create:vi.fn(()=> 'blob:preview'),revoke:vi.fn(),publish:vi.fn()}
  return {options,loader:new AttachmentPreview(options)}
}
describe('attachment preview ownership',()=>{
  it('loads and releases an object URL exactly once on unmount',async()=>{
    const {loader,options}=previewFixture();await loader.load('a','image/png');loader.dispose();loader.dispose()
    expect(options.create).toHaveBeenCalledWith('encoded','image/png')
    expect(options.publish).toHaveBeenLastCalledWith({status:'ready',url:'blob:preview'})
    expect(options.revoke).toHaveBeenCalledExactlyOnceWith('blob:preview')
  })
  it('does not allocate a URL for a read that resolves after unmount',async()=>{
    const {loader,options}=previewFixture(),pending=deferred<{data:string}>()
    options.read.mockReturnValueOnce(pending.promise)
    const load=loader.load('a','image/png');loader.dispose();options.publish.mockClear()
    pending.resolve({data:'late'});await load
    expect(options.create).not.toHaveBeenCalled();expect(options.publish).not.toHaveBeenCalled()
  })
  it('ignores old failures after a different attachment is loaded',async()=>{
    const {loader,options}=previewFixture(),old=deferred<{data:string}>()
    options.read.mockReturnValueOnce(old.promise)
    const first=loader.load('a','image/png');await loader.load('b','image/jpeg')
    old.reject(new Error('missing'));await first
    expect(options.publish).toHaveBeenLastCalledWith({status:'ready',url:'blob:preview'})
  })
  it('supports retry after disk or decoding errors',async()=>{
    const {loader,options}=previewFixture();options.read.mockRejectedValueOnce(new Error('not found'))
    await loader.load('a','image/png');expect(options.publish).toHaveBeenLastCalledWith({status:'error',url:null})
    await loader.load('a','image/png');expect(options.publish).toHaveBeenLastCalledWith({status:'ready',url:'blob:preview'})
    loader.mediaError('blob:preview');expect(options.revoke).toHaveBeenCalledOnce()
    expect(options.publish).toHaveBeenLastCalledWith({status:'error',url:null})
    options.create.mockReturnValueOnce('blob:retry');await loader.load('a','image/png')
    loader.mediaError('blob:preview')
    expect(options.publish).toHaveBeenLastCalledWith({status:'ready',url:'blob:retry'})
    loader.dispose()
  })
  it('releases the previous preview before reloading',async()=>{
    const {loader,options}=previewFixture();await loader.load('a','audio/webm')
    const pending=deferred<{data:string}>();options.read.mockReturnValueOnce(pending.promise)
    const reload=loader.load('a','audio/webm')
    expect(options.revoke).toHaveBeenCalledOnce()
    expect(options.publish).toHaveBeenLastCalledWith({status:'loading',url:null})
    loader.dispose();pending.resolve({data:'ignored'});await reload
  })
  it('turns invalid encoded content into a recoverable preview failure',async()=>{
    const {loader,options}=previewFixture();options.create.mockImplementationOnce(()=>{throw new Error('invalid base64')})
    await loader.load('a','image/png')
    expect(options.publish).toHaveBeenLastCalledWith({status:'error',url:null})
    expect(options.revoke).not.toHaveBeenCalled()
  })
})

const self='usr_'+'a'.repeat(64),friend='usr_'+'b'.repeat(64),other='usr_'+'c'.repeat(64)
const directory={friends:[{id:friend}],requests:[],outgoingRequests:[]} as unknown as Directory
describe('contact form checks',()=>{
  it('explains empty, incomplete, own and already-added IDs',()=>{
    expect(friendRequestIssue('',self,directory)).toContain('粘贴')
    expect(friendRequestIssue('usr_incomplete',self,directory)).toContain('格式')
    expect(friendRequestIssue(self,self,directory)).toContain('自己')
    expect(friendRequestIssue(friend,self,directory)).toContain('已经是好友')
    expect(friendRequestIssue(' '+other+' ',self,directory)).toBeNull()
  })
  it('routes incoming requests to acceptance and outgoing requests to waiting',()=>{
    const member={id:other,displayName:'Other',online:true}
    expect(friendRequestIssue(other,self,{...directory,requests:[member]})).toContain('直接接受')
    expect(friendRequestIssue(other,self,{...directory,outgoingRequests:[member]})).toContain('等待')
  })
  it('only keeps unique friends from the currently connected server',()=>{
    expect(selectedCurrentFriends([friend,friend,other],directory)).toEqual([friend])
    expect(selectedCurrentFriends([friend],null)).toEqual([])
    expect(selectedCurrentFriends([friend],{...directory,friends:[]})).toEqual([])
  })
})
