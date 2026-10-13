import { describe, expect, it, vi } from 'vitest'
import { LiveSnapshot } from '../src/renderer/src/live-snapshot'
import { backupPasswordIssue, refreshAfterCompletedAction } from '../src/renderer/src/settings-actions'

function deferred<T>() {
  let resolve!: (value:T)=>void,reject!: (error:Error)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
function fixture() {
  const listeners:((value:number)=>void)[]=[]
  const read=vi.fn(async()=>1),publish=vi.fn(),unsubscribe=vi.fn()
  const resource=new LiveSnapshot(read,listener=>{listeners.push(listener);return unsubscribe},publish)
  return {resource,read,publish,unsubscribe,push:(value:number)=>listeners.at(-1)!(value),listeners}
}
describe('live settings recovery and ordering',()=>{
  it('initial read publishes loading then usable state',async()=>{
    const f=fixture();await f.resource.start()
    expect(f.publish).toHaveBeenNthCalledWith(1,{value:null,loading:true,error:''})
    expect(f.publish).toHaveBeenLastCalledWith({value:1,loading:false,error:''})
    f.resource.stop();expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
  it('retries an initial failure without closing settings',async()=>{
    const f=fixture();f.read.mockRejectedValueOnce(new Error('not ready'))
    await f.resource.start()
    expect(f.publish).toHaveBeenLastCalledWith({value:null,loading:false,error:'not ready'})
    await f.resource.refresh()
    expect(f.publish).toHaveBeenLastCalledWith({value:1,loading:false,error:''})
  })
  it('pushes supersede late read results',async()=>{
    const f=fixture(),pending=deferred<number>();f.read.mockReturnValueOnce(pending.promise)
    const start=f.resource.start();f.push(2);pending.resolve(1);await start
    expect(f.publish).toHaveBeenLastCalledWith({value:2,loading:false,error:''})
  })
  it('pushes supersede late read errors',async()=>{
    const f=fixture(),pending=deferred<number>();f.read.mockReturnValueOnce(pending.promise)
    const start=f.resource.start();f.push(2);pending.reject(new Error('stale'));await start
    expect(f.publish).toHaveBeenLastCalledWith({value:2,loading:false,error:''})
  })
  it('newer refresh wins over earlier refresh',async()=>{
    const f=fixture();await f.resource.start()
    const pending=deferred<number>();f.read.mockReturnValueOnce(pending.promise)
    const old=f.resource.refresh();f.read.mockResolvedValueOnce(3);await f.resource.refresh()
    pending.resolve(2);await old
    expect(f.publish).toHaveBeenLastCalledWith({value:3,loading:false,error:''})
  })
  it('retains the last snapshot on failure and clears the error on a push',async()=>{
    const f=fixture();await f.resource.start();f.read.mockRejectedValueOnce(new Error('offline'));await f.resource.refresh()
    expect(f.publish).toHaveBeenLastCalledWith({value:1,loading:false,error:'offline'})
    f.push(4);expect(f.publish).toHaveBeenLastCalledWith({value:4,loading:false,error:''})
  })
  it('unmount invalidates in-flight results and old subscriptions',async()=>{
    const f=fixture(),pending=deferred<number>();f.read.mockReturnValueOnce(pending.promise)
    const start=f.resource.start();f.resource.stop();f.publish.mockClear();f.push(9)
    pending.resolve(3);await start;await f.resource.refresh()
    expect(f.publish).not.toHaveBeenCalled();expect(f.read).toHaveBeenCalledOnce()
  })
  it('StrictMode restart ignores the prior subscription and pending read',async()=>{
    const f=fixture(),pending=deferred<number>();f.read.mockReturnValueOnce(pending.promise)
    const old=f.resource.start();const oldListener=f.listeners[0]!
    f.resource.stop();await f.resource.start();oldListener(99);pending.resolve(50);await old
    expect(f.publish).toHaveBeenLastCalledWith({value:1,loading:false,error:''})
    f.resource.stop();expect(f.unsubscribe).toHaveBeenCalledTimes(2)
  })
})

describe('backup settings validation and partial success',()=>{
  it('enforces the same password bounds as the main process',()=>{
    expect(backupPasswordIssue('a'.repeat(11))).not.toBeNull()
    expect(backupPasswordIssue('a'.repeat(12))).toBeNull()
    expect(backupPasswordIssue('a'.repeat(256))).toBeNull()
    expect(backupPasswordIssue('a'.repeat(257))).not.toBeNull()
  })
  it('rejects whitespace-only passwords without trimming real passwords',()=>{
    expect(backupPasswordIssue(' '.repeat(12))).not.toBeNull()
    expect(backupPasswordIssue('  pass phrase  ','  pass phrase  ')).toBeNull()
    expect(backupPasswordIssue('  pass phrase  ','pass phrase')).toContain('不一致')
  })
  it('requires exact confirmation only for backup creation',()=>{
    expect(backupPasswordIssue('safe-password','')).toContain('不一致')
    expect(backupPasswordIssue('safe-password','SAFE-password')).toContain('不一致')
    expect(backupPasswordIssue('safe-password')).toBeNull()
  })
  it('returns a refreshed list after a completed mutation',async()=>{
    expect(await refreshAfterCompletedAction(async()=>['profile'])).toEqual({value:['profile'],refreshFailed:false})
  })
  it('does not pretend a completed mutation failed when a list refresh fails',async()=>{
    const read=vi.fn(async()=>{throw new Error('unavailable')})
    expect(await refreshAfterCompletedAction(read)).toEqual({value:null,refreshFailed:true})
    expect(read).toHaveBeenCalledOnce()
  })
})
