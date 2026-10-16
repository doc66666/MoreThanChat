import { pluginScopeMembers, type GroupPlugin, type ServerSnapshot, type RelayEvent } from '@more-than-chat/central-protocol'
import { parseExecutableClientPackage, type PluginRuntime, type UiSurfaceRegistry, type UiSurfaceContribution } from '@more-than-chat/plugin-runtime'
import { ClientPluginLoader, type ClientModule } from './client-plugin-loader'

type Event = Extract<RelayEvent,{kind:'plugin'}>
type Bridge = Pick<Window['moreThanChat'],'groupPluginConsent'|'serverAction'|'getPluginInbox'|'onPluginEvent'>
/** One lifecycle per server / identity / conversation / package, independent of local installs. */
export class SharedClientPlugins {
  #generation=0
  #input:{snapshot:ServerSnapshot|null;scope:string|null}={snapshot:null,scope:null}
  #tail:Promise<void>=Promise.resolve()
  #active=new Map<string,{loader:ClientPluginLoader;id:string;digest:string;live:()=>boolean}>()
  // Includes activations still awaiting plugin code. Once invalidated, an instance
  // cannot revive if the user switches away and back before reconciliation runs.
  #leases=new Set<()=>boolean>()
  readonly errors=new Map<string,string>()
  constructor(readonly runtime:PluginRuntime,readonly bridge:Bridge,readonly sdk:Record<string,unknown>,readonly load:(code:string)=>Promise<ClientModule>,readonly changed:()=>void=()=>{}) {}
  update(snapshot:ServerSnapshot|null,scope:string|null):Promise<void> {
    this.#input={snapshot,scope}
    for(const live of this.#leases)live()
    const generation=++this.#generation
    const run=async()=>{
      if(generation!==this.#generation)return
      const desired=new Map<string,GroupPlugin>()
      if(snapshot?.status==='connected'&&snapshot.serverId&&scope&&snapshot.directory&&pluginScopeMembers(snapshot.directory,scope).some(m=>m.id===snapshot.userId)) {
        for(const plugin of snapshot.directory.plugins.filter(p=>p.groupId===scope&&p.status==='approved'&&p.pack.kind==='executable')) {
          const key=this.#key(snapshot,plugin)
          try {
            if(await this.bridge.groupPluginConsent({groupId:scope,pluginId:plugin.pack.id,digest:plugin.digest})==='loaded')desired.set(key,plugin)
            this.errors.delete(key)
          } catch(error){this.errors.set(key,String(error))}
        }
      }
      if(generation!==this.#generation)return
      for(const [key,entry] of this.#active) if(desired.get(key)?.digest!==entry.digest||!entry.live()) {
        await entry.loader.remove(entry.id);this.#active.delete(key)
      }
      for(const [key,plugin] of desired) {
        if(generation!==this.#generation)break
        if(this.#active.has(key))continue
        let lease:(()=>boolean)|undefined
        try {
          const pack=parseExecutableClientPackage(plugin.pack.client)
          const runtimeId='shared.'+key.replace(/[^a-z0-9.-]/g,'-')
          let disposed=false
          const live=()=>{
            const current=this.#input.snapshot
            if(disposed)return false
            const valid=current?.status==='connected'&&current.serverId===snapshot!.serverId&&current.userId===snapshot!.userId&&this.#input.scope===scope&&current.directory&&pluginScopeMembers(current.directory,scope!).some(m=>m.id===current.userId)&&current.directory.plugins.some(p=>p.groupId===scope&&p.pack.id===plugin.pack.id&&p.status==='approved'&&p.digest===plugin.digest)
            if(!valid)disposed=true
            return Boolean(valid)
          }
          lease=live;this.#leases.add(live)
          const matches=(event:Event)=>live()&&event.groupId===scope&&event.pluginId===plugin.pack.id&&event.trace?.digest===plugin.digest
          const network={
            send:async(channel:string,payload:unknown)=>{
              if(!live())throw new Error('插件会话或版本已改变')
              await this.bridge.serverAction('plugins/event',{serverId:snapshot!.serverId,groupId:scope,pluginId:plugin.pack.id,digest:plugin.digest,channel,payload})
            },
            history:async()=>{
              if(!live())return []
              return (await this.bridge.getPluginInbox(scope!,plugin.pack.id)).filter(matches)
            },
            subscribe:(listener:(event:Event)=>void)=>this.bridge.onPluginEvent(event=>{if(matches(event))listener(event)}),
          }
          const currentSnapshot=()=>this.#input.snapshot
          const scopedSdk={...this.sdk,network,plugin:pack.manifest,conversation:{id:scope,kind:scope!.startsWith('dm_')?'direct':'group',serverId:snapshot!.serverId,userId:snapshot!.userId,
            get members(){const current=currentSnapshot();return current?.directory ? pluginScopeMembers(current.directory,scope!) : []}}}
          // Legacy chat.network calls still work, but always address this exact approved instance.
          const legacy={forPlugin:()=>({send:(target:string,channel:string,payload:unknown)=>{if(target!==scope)throw new Error('会话不匹配');return network.send(channel,payload)},history:()=>network.history(),subscribe:(_target:string,listener:(event:Event)=>void)=>network.subscribe(listener)})}
          const loader=new ClientPluginLoader(this.runtime,scopedSdk,this.load,context=>{
            context.effect(()=>{disposed=true;this.#leases.delete(live)})
            return {...context,getService:<T>(id:string):T=>{
              if(id==='chat.network')return legacy as T
              const service=context.getService<T>(id)
              if(id!=='ui.surfaces')return service
              const registry=service as UiSurfaceRegistry
              return new Proxy(registry,{get(target,key){
                if(key==='register')return (_owner:string,contribution:UiSurfaceContribution)=>target.registerInstance(context.manifest.id,pack.manifest.id,contribution)
                const value=Reflect.get(target,key,target)
                return typeof value==='function'?value.bind(target):value
              }}) as T
            }}
          },()=>Boolean(live()))
          await loader.enable({...pack,manifest:{...pack.manifest,id:runtimeId},digest:plugin.digest})
          this.#active.set(key,{loader,id:runtimeId,digest:plugin.digest,live});this.errors.delete(key)
          // A new directory snapshot is not a new lifecycle. Reconcile consent
          // on the queued update, but preserve this instance if its identity lives.
          if(!live()){await loader.remove(runtimeId);this.#active.delete(key)}
        }catch(error){if(lease)this.#leases.delete(lease);this.errors.set(key,error instanceof Error?error.message:String(error))}
      }
      this.changed()
    }
    this.#tail=this.#tail.then(run,run)
    return this.#tail
  }
  #key(snapshot:ServerSnapshot,plugin:GroupPlugin){return [snapshot.serverId,snapshot.userId,plugin.groupId,plugin.pack.id].join('.')}
}
