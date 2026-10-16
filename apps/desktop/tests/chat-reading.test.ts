// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UiSurfaceRegistry } from '@more-than-chat/plugin-runtime'
import type { ChatMessage } from '@more-than-chat/chat-core'
import { UiSurface } from '../src/renderer/src/UiSurface'
import { isReadingVisible, useChatReading } from '../src/renderer/src/use-chat-reading'

let root:Root,container:HTMLDivElement,registry:UiSurfaceRegistry
let reading:ReturnType<typeof useChatReading>,focused:(value:boolean)=>void
let props:{id:string;blocked:boolean;historic:boolean;count:number}
let covered=false,height=2200,positions:WeakMap<Element,number>
const receipts=vi.fn(async(_id:string|null)=>{})
const resizeCallbacks=new Set<()=>void>()
function Harness(){
  reading=useChatReading(props.id,[{id:'last-'+props.count,text:'message'} as ChatMessage],props.blocked||props.historic,0,props.historic)
  return h(UiSurface,{registry,name:'root',context:{}},
    h('section',{className:'message-scroll',ref:reading.bindScroll,onScroll:reading.onScroll},
      h('div',{ref:reading.bindContent},'messages')))
}
const node=()=>container.querySelector<HTMLElement>('.message-scroll')!
async function render(patch:Partial<typeof props>={}){Object.assign(props,patch);await act(async()=>root.render(h(Harness)))}
async function scroll(top:number){await act(async()=>{node().scrollTop=top;node().dispatchEvent(new Event('scroll',{bubbles:true}))})}
beforeEach(async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  positions=new WeakMap();covered=false;height=2200;resizeCallbacks.clear();receipts.mockClear()
  vi.stubGlobal('ResizeObserver',class {callback:()=>void;constructor(callback:()=>void){this.callback=callback;resizeCallbacks.add(callback)}observe(){}disconnect(){resizeCallbacks.delete(this.callback)}})
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.matches('.message-scroll')?500:0})
  vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockImplementation(()=>height)
  vi.spyOn(HTMLElement.prototype,'scrollTop','get').mockImplementation(function(this:HTMLElement){return positions.get(this)??0})
  vi.spyOn(HTMLElement.prototype,'scrollTop','set').mockImplementation(function(this:HTMLElement,v:number){positions.set(this,Math.max(0,Math.min(height-500,v)))})
  const rect=new DOMRect(80,100,600,500)
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>rect)
  vi.spyOn(HTMLElement.prototype,'getClientRects').mockImplementation(()=>[rect] as unknown as DOMRectList)
  vi.spyOn(document,'elementFromPoint').mockImplementation(()=>covered?document.body:node())
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
  window.moreThanChat={onWindowFocusChanged:(fn:typeof focused)=>{focused=fn;return()=>{}},getWindowFocus:async()=>true,setReadingConversation:receipts} as unknown as Window['moreThanChat']
  registry=new UiSurfaceRegistry();props={id:'direct',blocked:false,historic:false,count:1}
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})

it('follows entry and latest navigation when a root plugin wraps defaultView, including hot replacement',async()=>{
  let dispose=registry.register('popup',{id:'popup',surface:'root',render:({defaultView})=>h('div',null,defaultView as never,h('button',null,'game'))})
  await render();expect(node().scrollTop).toBe(1700);expect(receipts).toHaveBeenLastCalledWith('direct')
  await scroll(0);expect(reading.atBottom).toBe(false)
  await act(async()=>reading.jumpToLatest());expect(node().scrollTop).toBe(1700)
  await scroll(0);await render({id:'group'});expect(node().scrollTop).toBe(1700)
  await act(async()=>{dispose();dispose=registry.register('popup',{id:'updated',surface:'root',render:({defaultView})=>h('article',null,defaultView as never)})})
  expect(node().scrollTop).toBe(1700)
  height=3000;await act(async()=>{for(const callback of resizeCallbacks)callback()});expect(node().scrollTop).toBe(2500)
})

it('suppresses receipts, not scrolling, when a popup/settings/window focus covers the reader',async()=>{
  await render({blocked:true});expect(node().scrollTop).toBe(1700);expect(receipts).toHaveBeenLastCalledWith(null)
  await scroll(0);await act(async()=>reading.jumpToLatest());expect(node().scrollTop).toBe(1700)
  covered=true;await render({blocked:false,count:2});expect(isReadingVisible(node())).toBe(false);expect(receipts).toHaveBeenLastCalledWith(null)
  covered=false;await render({count:3});expect(receipts).toHaveBeenLastCalledWith('direct')
  await act(async()=>focused(false));expect(receipts).toHaveBeenLastCalledWith(null)
  await act(async()=>focused(true));expect(receipts).toHaveBeenLastCalledWith('direct')
})

it('detaches receipts on a full root replacement and reattaches after restoring the same conversation',async()=>{
  await render();let dispose:()=>unknown=()=>{}
  await act(async()=>{dispose=registry.register('full',{id:'full',surface:'root',render:()=>h('div',null,'custom desktop')})})
  expect(node()).toBeNull();expect(reading.scrollRef.current).toBeNull();expect(receipts).toHaveBeenLastCalledWith(null)
  await act(async()=>{dispose()});expect(node().scrollTop).toBe(1700);expect(receipts).toHaveBeenLastCalledWith('direct')
})

it('keeps history anchored and honors a latest request that arrives before the history state commit',async()=>{
  await render();await act(async()=>reading.pauseReading());await render({historic:true});await scroll(0)
  await act(async()=>reading.jumpToLatest());expect(node().scrollTop).toBe(0)
  await render({historic:false});expect(node().scrollTop).toBe(1700);expect(receipts).toHaveBeenLastCalledWith('direct')
  await scroll(0);await render({count:2});expect(node().scrollTop).toBe(0);expect(receipts).toHaveBeenLastCalledWith(null)
})

it('rechecks a plugin popup opening/closing without App state changes or ResizeObserver events',async()=>{
  const frames=new Map<number,FrameRequestCallback>();let id=0
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id})
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id))
  const flush=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));for(const callback of frames.values())callback(0);frames.clear()})}
  await render();expect(receipts).toHaveBeenLastCalledWith('direct')
  const popup=document.createElement('div');covered=true;document.body.append(popup);await flush()
  expect(receipts).toHaveBeenLastCalledWith(null)
  covered=false;popup.remove();await flush();expect(receipts).toHaveBeenLastCalledWith('direct')
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
  document.dispatchEvent(new Event('visibilitychange'));expect(receipts).toHaveBeenLastCalledWith(null)
})
