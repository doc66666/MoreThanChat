// @vitest-environment happy-dom
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import type {ChatMessage} from '@more-than-chat/chat-core'
import {UiSurfaceRegistry} from '@more-than-chat/plugin-runtime'
import {UiSurface} from '../src/renderer/src/UiSurface'
import {MessageBodyView,MarkdownMessageView,MessageBodyFallback,MessageFrame} from '../src/renderer/src/message-content'
import {bundledExamples} from '../src/renderer/src/bundled-examples'

it('renders both directions as Markdown and re-renders existing custom messages on install/update/remove',async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  const registry=new UiSurfaceRegistry(),message={id:'m',text:'**摘要**',role:'self',status:'sent'} as ChatMessage
  registry.register('builtin.body',{id:'body',surface:'message.body',render:({context,renderSurface})=>h(MessageBodyView,{context:context as any,renderSurface:renderSurface as any})})
  registry.register('builtin.md',{id:'md',surface:'message.body.markdown',render:({context})=>h(MarkdownMessageView,{context:context as any})})
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
  const render=()=>act(async()=>root.render(h(UiSurface,{registry,name:'message.body',context:{message}},h(MessageBodyFallback,{message}))))
  let dispose=()=>{}
  try{
    await render();expect(container.querySelector('strong')?.textContent).toBe('摘要')
    message.role='peer';await render();expect(container.querySelector('strong')?.textContent).toBe('摘要')
    message.content={format:'demo.card',version:1,body:'卡片数据'};await render()
    expect(container.querySelector('[data-message-fallback]')).not.toBeNull()
    await act(async()=>{dispose=registry.register('user.card',{id:'card',surface:'message.body.demo.card',render:({context}:any)=>h('section',{'data-card':true},context.message.content.body)})})
    expect(container.querySelector('[data-card]')?.textContent).toBe('卡片数据')
    await act(async()=>{dispose();dispose=registry.register('user.card',{id:'card',surface:'message.body.demo.card',render:()=>h('section',{'data-card':true},'新版')})})
    expect(container.querySelectorAll('[data-card]')).toHaveLength(1);expect(container.textContent).toBe('新版')
    await act(async()=>dispose());expect(container.textContent).toContain('摘要')
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{})
    try{await act(async()=>{dispose=registry.register('user.broken',{id:'broken',surface:'message.body.demo.card',render:()=>{throw Error('bad renderer')}})})
      expect(container.querySelector('[data-message-fallback]')).not.toBeNull()
    }finally{errors.mockRestore()}
  }finally{await act(async()=>root.unmount());container.remove();dispose()}
})

it('keeps the timeline location when a plugin replaces the entire message',async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  const registry=new UiSurfaceRegistry(),message={id:'stable-location',text:'摘要',role:'peer',status:'sent'} as ChatMessage
  const container=document.createElement('div'),root=createRoot(container)
  let dispose=registry.register('user.bubble',{id:'bubble',surface:'message',render:()=>h('section',null,'自定义消息')})
  const render=()=>act(async()=>root.render(h(MessageFrame,{message,highlighted:true,children:h(UiSurface,{registry,name:'message',context:{message}},h(MessageBodyFallback,{message}))})))
  try{
    await render();const anchor=container.querySelector('[data-message-id="stable-location"]')
    expect(container.querySelector<HTMLElement>('.message-highlight')?.dataset.messageId).toBe('stable-location')
    expect(anchor?.textContent).toBe('自定义消息')
    await act(async()=>{dispose();dispose=registry.register('user.bubble',{id:'bubble',surface:'message',render:()=>h('p',null,'更新后的消息')})})
    expect(container.querySelector('[data-message-id="stable-location"]')).toBe(anchor)
    expect(anchor?.textContent).toBe('更新后的消息')
    await act(async()=>dispose());expect(anchor?.textContent).toBe('摘要')
    message.retractedAt=1;await render();expect(anchor?.hasAttribute('data-retracted-message')).toBe(true)
  }finally{await act(async()=>root.unmount());dispose()}
})

async function cardModule(){return import(/* @vite-ignore */ 'data:text/javascript;base64,'+Buffer.from(bundledExamples.find(e=>e.id==='example.html-message')!.pack.program.code).toString('base64'))}
it('keeps uncertain send IDs through reloads, but sends identical content as a new intent after success',async()=>{
  const {cardDraftStore}=await cardModule();localStorage.clear()
  const draft=cardDraftStore(localStorage,'one')
  draft.edit({summary:'摘要',body:'<h2>正文</h2>'})
  const first=draft.begin('chat',()=> 'one-id')
  const restored=cardDraftStore(localStorage,'one')
  expect(restored.begin('chat',()=> 'should-not-be-used')).toEqual(first)
  expect(restored.complete(first.clientMessageId)).toBe(true)
  expect(restored.get()).toMatchObject({summary:'',body:''})
  restored.edit({summary:'摘要',body:'<h2>正文</h2>'})
  expect(restored.begin('chat',()=> 'new-intent').clientMessageId).toBe('new-intent')
})
it('isolates drafts by conversation and preserves newer edits when an old send finishes',async()=>{
  const {cardDraftStore}=await cardModule();localStorage.clear()
  const old=cardDraftStore(localStorage,'one');old.edit({summary:'原稿',body:'old'});old.begin('chat',()=> 'old-id')
  expect(cardDraftStore(localStorage,'two').get()).toMatchObject({summary:'',body:''})
  const updated=cardDraftStore(localStorage,'one');updated.edit({summary:'新稿',body:'new'})
  expect(old.complete('old-id')).toBe(false)
  expect(cardDraftStore(localStorage,'one').get()).toMatchObject({summary:'新稿',body:'new'})
  const unavailable={getItem(){throw Error('unavailable')},setItem(){throw Error('full')},removeItem(){throw Error('full')}}
  const memory=cardDraftStore(unavailable,'memory');expect(memory.edit({summary:'摘要',body:'body'})).toBe(false)
  const request=memory.begin('chat',()=> 'memory-id');expect(memory.complete(request.clientMessageId)).toBe(true)
})

it('HTML message documents retain layout but do not carry active markup or external URLs',async()=>{
  const pack=bundledExamples.find(e=>e.id==='example.html-message')!.pack
  const {messageDocument}=await import(/* @vite-ignore */ 'data:text/javascript;base64,'+Buffer.from(pack.program.code).toString('base64'))
  const value=messageDocument('<h2 style="color:red" onclick="steal()">标题</h2><script>steal()</script><meta http-equiv="refresh" content="0;url=https://example.com"><iframe src="https://example.com"></iframe><a href="https://example.com">link</a><img src="https://example.com/pixel.png">',{text:'#000',background:'#fff',border:'#ccc'})
  const doc=new DOMParser().parseFromString(value,'text/html')
  expect(doc.querySelector('h2')?.getAttribute('style')).toBe('color:red')
  expect(doc.querySelectorAll('script,iframe,[onclick],[href],[src],meta[http-equiv="refresh"]')).toHaveLength(0)
  expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'")
})
