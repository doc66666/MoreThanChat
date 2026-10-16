import type { ChatAccessRequest } from '@more-than-chat/protocol'

type Chat={request:(input:ChatAccessRequest)=>Promise<unknown>;subscribe:(listener:(projection:unknown)=>void)=>()=>void}

/** Lifecycle ownership, not a sandbox: trusted plugins still have the full renderer SDK. */
export function scopePluginChat(sdk:unknown,live:()=>boolean){
  let active=true
  const subscriptions=new Set<()=>void>()
  const dispose=()=>{
    active=false
    for(const unsubscribe of subscriptions){try{unsubscribe()}catch{/* Continue releasing the other subscriptions. */}}
    subscriptions.clear()
  }
  if(!sdk||typeof sdk!=='object'||!('chat' in sdk))return {sdk,dispose}
  const chat=sdk.chat as Chat
  if(typeof chat?.request!=='function'||typeof chat?.subscribe!=='function')return {sdk,dispose}
  const check=()=>{if(!active||!live())throw new Error('插件已停用或会话已改变，此实例不能继续访问聊天')}
  const scopedChat=Object.freeze({
    async request(input:ChatAccessRequest){
      check()
      const result=await chat.request(input)
      // A pending read must not resume work from an obsolete plugin instance.
      check()
      return result
    },
    subscribe(listener:(projection:unknown)=>void){
      check()
      let subscribed=true
      const unsubscribe=chat.subscribe(value=>{if(subscribed&&active&&live())listener(value)})
      const stop=()=>{if(!subscribed)return;subscribed=false;subscriptions.delete(stop);unsubscribe()}
      subscriptions.add(stop)
      return stop
    },
  })
  // Preserve getters (especially sdk.app) rather than eagerly evaluating them on activation.
  const descriptors=Object.getOwnPropertyDescriptors(sdk)
  descriptors.chat={value:scopedChat,enumerable:true,configurable:false,writable:false}
  return {sdk:Object.freeze(Object.create(Object.getPrototypeOf(sdk),descriptors)) as unknown,dispose}
}
