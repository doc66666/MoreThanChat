import { describe,it,expect,vi } from 'vitest'
import { CordisPluginRuntime } from '@more-than-chat/runtime-cordis'
import { UiSurfaceRegistry } from '@more-than-chat/plugin-runtime'
import { directPluginScope,parseGroupPluginPack,type ServerSnapshot,type RelayEvent } from '@more-than-chat/central-protocol'
import { SharedClientPlugins } from '../src/renderer/src/shared-client-plugins'
const uid='usr_'+'a'.repeat(64),peer='usr_'+'b'.repeat(64),scope=directPluginScope(uid,peer)
function snapshot():ServerSnapshot {
  const self={id:uid,displayName:'A',online:true},friend={id:peer,displayName:'B',online:true}
  return {status:'connected',serverId:'srv-test',address:'http://localhost',mode:'public',userId:uid,displayName:'A',error:null,directory:{self,friends:[friend],requests:[],groups:[],plugins:[{groupId:scope,pack:parseGroupPluginPack({id:'gplugin_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',version:1,displayName:'Test',kind:'executable',slot:'chat.details',client:{manifest:{manifestVersion:1,id:'test.shared',version:'0.1.0',displayName:'Test',description:'Test',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted'],services:{requires:['ui.surfaces','chat.network']}},program:{kind:'executable-client',code:'test'}}}),digest:'a'.repeat(64),submittedBy:uid,status:'approved',revision:0,state:{}}]}}
}
describe('shared executable lifecycle',()=>{
  it('does not execute before local choice; isolates scope, binds provenance, unloads on switch/update/removal',async()=>{
    const surfaces=new UiSurfaceRegistry(),runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.surfaces':surfaces,'chat.network':{}}})
    let choice:'loaded'|'pending'|'declined'='pending',listener:((event:any)=>void)|undefined,sdk:any
    const cleanup=vi.fn(),bridge={groupPluginConsent:vi.fn(async()=>choice),serverAction:vi.fn(async()=>snapshot()),getPluginInbox:vi.fn(async()=>[]),onPluginEvent:vi.fn((fn:any)=>{listener=fn;return()=>{listener=undefined}})}
    const load=vi.fn(async()=>({default:(ctx:any,value:any)=>{sdk=value;ctx.contribute(ctx.getService('ui.surfaces'),{id:'anywhere',surface:'root',render:()=>true});ctx.effect(cleanup);ctx.effect(value.network.subscribe(()=>{}))}}))
    const manager=new SharedClientPlugins(runtime,bridge,{},load),state=snapshot()
    await manager.update(state,scope);expect(load).not.toHaveBeenCalled()
    choice='loaded';await manager.update(state,scope);expect(load).toHaveBeenCalledTimes(1);expect(surfaces.list()).toHaveLength(1)
    await sdk.network.send('custom',{data:1})
    expect(bridge.serverAction).toHaveBeenCalledWith('plugins/event',expect.objectContaining({serverId:state.serverId,groupId:scope,pluginId:state.directory!.plugins[0]!.pack.id,digest:'a'.repeat(64)}))
    await manager.update(state,scope);expect(load).toHaveBeenCalledTimes(1)
    const previous=sdk;await manager.update(state,null)
    expect(cleanup).toHaveBeenCalledTimes(1);expect(listener).toBeUndefined();expect(surfaces.list()).toHaveLength(0)
    await expect(previous.network.send('late',{})).rejects.toThrow('改变')
    await manager.update(state,scope);expect(load).toHaveBeenCalledTimes(2)
    choice='pending';state.directory!.plugins[0]!.digest='b'.repeat(64)
    await manager.update(state,scope);expect(surfaces.list()).toHaveLength(0)
    choice='loaded';await manager.update(state,scope);expect(surfaces.list()).toHaveLength(1)
    state.directory!.friends=[];await manager.update(state,scope);expect(surfaces.list()).toHaveLength(0)
    await runtime.close()
  })
  it('cleans a stale asynchronous activation and prevents old-instance sends',async()=>{
    const surfaces=new UiSurfaceRegistry(),runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.surfaces':surfaces,'chat.network':{}}})
    let resolve!:()=>void,activeSdk:any
    const gate=new Promise<void>(r=>{resolve=r}),done=vi.fn()
    const bridge={groupPluginConsent:async()=>'loaded' as const,serverAction:async()=>snapshot(),getPluginInbox:async()=>[] as Extract<RelayEvent,{kind:'plugin'}>[],onPluginEvent:()=>()=>{}}
    const manager=new SharedClientPlugins(runtime,bridge,{},async()=>({default:async(ctx,sdk)=>{activeSdk=sdk;ctx.effect(done);ctx.contribute(surfaces,{id:'root',surface:'root',render:()=>true});await gate}}))
    const first=manager.update(snapshot(),scope)
    await vi.waitFor(()=>expect(activeSdk).toBeDefined())
    const second=manager.update(null,null);resolve();await Promise.all([first,second])
    expect(done).toHaveBeenCalledTimes(1);expect(surfaces.list()).toHaveLength(0)
    await expect(activeSdk.network.send('late',{})).rejects.toThrow()
    await runtime.close()
  })
})
