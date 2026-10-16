// @vitest-environment happy-dom
// Mount the real App and click its real DOM buttons. Only the native IPC boundary
// and geometry (happy-dom has no layout engine) are substituted. No browser/window.
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSeedState, type ChatState } from '@more-than-chat/chat-core'
import type { UiSurfaceRegistry } from '@more-than-chat/plugin-runtime'

let root:Root,container:HTMLDivElement,state:ChatState,App:typeof import('../src/renderer/src/App')['App'],surfaces:UiSurfaceRegistry
let positions:WeakMap<Element,number>,historyResolve:((page:unknown)=>void)|undefined,disposers:(()=>unknown)[]
const events=new Map<string,(...args:any[])=>void>(),frames=new Map<number,FrameRequestCallback>()
let frameId=0,height=2400
const receipts=vi.fn(async(_id:string|null)=>{}),applied=vi.fn(async(_id:string)=>{})
const node=()=>container.querySelector<HTMLElement>('.message-scroll')!
async function framesTick(){await act(async()=>{const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(0)})}
async function click(selector:string){const element=container.querySelector<HTMLElement>(selector);expect(element,selector).not.toBeNull();await act(async()=>element!.click());await framesTick()}
async function scroll(top:number){await act(async()=>{node().scrollTop=top;node().dispatchEvent(new Event('scroll',{bubbles:true}))})}
function page(id:string,around=false){return {messages:state.messages[id]!.slice(around?27:0,around?30:3),before:around?27:0,after:around?30:2,hasOlder:around,hasNewer:!around}}

beforeEach(async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  state=createSeedState();disposers=[];positions=new WeakMap();events.clear();frames.clear();receipts.mockClear();applied.mockClear();height=2400;historyResolve=undefined
  for(const kind of ['direct','group'] as const){
    state.conversations.push({id:kind,kind,title:kind,subtitle:kind,avatar:'T',accent:'#666',unread:3,pinned:false,updatedAt:1,transportId:'builtin.central',serverId:'test-server',targetId:'target-'+kind})
    state.messages[kind]=Array.from({length:30},(_,i)=>({id:kind+'-'+i,clientMessageId:kind+'-'+i,conversationId:kind,senderId:'test-peer',senderName:'Peer',senderAvatar:'P',role:'peer' as const,type:'text' as const,text:'message '+i,createdAt:1000+i,status:'sent' as const,serverId:'test-server'}))
  }
  state.activeConversationId='direct'
  state.history={direct:{before:30,after:60,hasOlder:true,hasNewer:false,firstUnreadId:'direct-27'},group:{before:0,after:30,hasOlder:false,hasNewer:false,firstUnreadId:'group-27'}}
  const methods:Record<string,unknown>={
    demoPluginsEnabled:false,loadState:async()=>structuredClone(state),saveState:async()=>{},getPendingNavigation:async()=>null,
    getWindowFocus:async()=>true,focusChatWindow:async()=>{},setReadingConversation:receipts,navigationApplied:applied,
    getServerState:async()=>null,getHostStatus:async()=>({state:'ready',generation:1}),getHostPlugins:async()=>({generation:1,plugins:[]}),
    getModelSettings:async()=>({providerMode:'mock',baseUrl:'',model:'test',hasApiKey:false}),setAppearance:async()=>{},
    getChatHistory:async()=>new Promise(resolve=>{historyResolve=resolve}),getFirstUnread:async(id:string)=>id+'-27',
  }
  window.moreThanChat=new Proxy(methods,{get(target,key:string){
    if(key in target)return target[key]
    if(key.startsWith('on'))return (fn:(...args:any[])=>void)=>{events.set(key,fn);return()=>{events.delete(key)}}
    throw Error('Unmocked IPC: '+key)
  }}) as unknown as Window['moreThanChat']
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}})
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId})
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id))
  vi.spyOn(HTMLElement.prototype,'scrollIntoView').mockImplementation(function(this:HTMLElement){node().scrollTop=150})
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.matches('.message-scroll')?500:0})
  vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockImplementation(function(this:HTMLElement){return this.matches('.message-scroll')?height:30})
  vi.spyOn(HTMLElement.prototype,'scrollTop','get').mockImplementation(function(this:HTMLElement){return positions.get(this)??0})
  vi.spyOn(HTMLElement.prototype,'scrollTop','set').mockImplementation(function(this:HTMLElement,value:number){positions.set(this,Math.max(0,Math.min(height-500,value)))})
  const rect=new DOMRect(80,100,600,500)
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>rect)
  vi.spyOn(HTMLElement.prototype,'getClientRects').mockImplementation(()=>[rect] as unknown as DOMRectList)
  vi.spyOn(document,'elementFromPoint').mockImplementation(()=>node())
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
  ;({App}=await import('../src/renderer/src/App'))
  ;({uiSurfaceRegistry:surfaces}=await import('../src/renderer/src/plugin-host'))
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());for(const dispose of disposers)dispose();container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();frames.clear()})

it('uses the actual entry/latest buttons through a defaultView root plugin and clears unread via the host projection',async()=>{
  disposers.push(surfaces.register('popup',{id:'popup',surface:'root',render:({defaultView})=>h('div',null,defaultView as never,h('button',null,'game'))}))
  await act(async()=>root.render(h(App)));await framesTick()
  expect(node().scrollTop).toBe(1900);expect(receipts).toHaveBeenLastCalledWith('direct')
  expect(container.querySelector('[data-unread-entry]')?.textContent).toContain('3 条新消息')
  state.conversations.find(c=>c.id==='direct')!.unread=0
  await act(async()=>events.get('onCentralChat')!(structuredClone(state)))
  expect(container.querySelector('[data-conversation-id="direct"] .conversation-preview-row b')).toBeNull()
  expect(container.querySelector('[data-unread-entry]')?.textContent).toContain('进入时有 3 条未读')
  await scroll(0);await click('.jump-latest');expect(node().scrollTop).toBe(1900)
  await scroll(0);await click('[data-conversation-id="group"]');expect(node().scrollTop).toBe(1900)
  await scroll(0);await click('[data-conversation-id="direct"]');expect(node().scrollTop).toBe(1900)
})

it('returns from historic pages and unread highlights, and ignores a delayed history response after latest navigation',async()=>{
  await act(async()=>root.render(h(App)));await framesTick()
  await click('[data-history-older]');expect(historyResolve).toBeTypeOf('function')
  await act(async()=>historyResolve!(page('direct')));await framesTick();expect(node().scrollTop).toBe(0)
  expect(receipts).toHaveBeenLastCalledWith(null)
  await click('[data-history-latest]');expect(node().scrollTop).toBe(1900)
  await click('[data-unread-entry] button');await act(async()=>historyResolve!(page('direct',true)));await framesTick()
  expect(node().scrollTop).toBe(150)
  await click('.jump-latest');expect(node().scrollTop).toBe(1900)
  await click('[data-history-older]');const stale=historyResolve!
  await click('.jump-latest');await act(async()=>stale(page('direct')));await framesTick()
  expect(container.querySelector('[data-history-latest]')).toBeNull();expect(node().scrollTop).toBe(1900)
})

it('notification navigation to the already selected conversation exits history and resumes latest following',async()=>{
  await act(async()=>root.render(h(App)));await framesTick();await scroll(0)
  await act(async()=>events.get('onOpenConversation')!({id:'notice-1',conversationId:'direct'}));await framesTick()
  expect(node().scrollTop).toBe(1900);expect(applied).toHaveBeenCalledWith('notice-1')
  await click('[data-history-older]');await act(async()=>historyResolve!(page('direct')));await framesTick()
  await act(async()=>events.get('onOpenConversation')!({id:'notice-2',conversationId:'direct'}));await framesTick()
  expect(container.querySelector('[data-history-latest]')).toBeNull();expect(node().scrollTop).toBe(1900)
})

it('does not let an old latest animation frame move a newer history navigation',async()=>{
  await act(async()=>root.render(h(App)));await framesTick();await scroll(0)
  // Two clicks before the next frame: the history gesture supersedes Latest.
  await act(async()=>container.querySelector<HTMLElement>('.jump-latest')!.click())
  await act(async()=>container.querySelector<HTMLElement>('[data-history-older]')!.click())
  await act(async()=>historyResolve!(page('direct')));await framesTick()
  expect(node().scrollTop).toBe(0);expect(receipts).toHaveBeenLastCalledWith(null)
})
