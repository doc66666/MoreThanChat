// @vitest-environment happy-dom
import {act,createElement} from 'react'
import * as React from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {ContributionRegistry,parseExecutableClientPackage,type UiSlotContribution} from '@more-than-chat/plugin-runtime'
import {CordisPluginRuntime} from '@more-than-chat/runtime-cordis'
import {bundledExamples,prepareExample} from '../src/renderer/src/bundled-examples'
import {clientPackageDigest} from '../src/main/client-plugins'
import {ClientPluginLoader} from '../src/renderer/src/client-plugin-loader'
import {UiSlot} from '../src/renderer/src/UiSlot'

const load=async(code:string)=>import(/* @vite-ignore */ 'data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
afterEach(()=>{localStorage.clear();vi.useRealTimers()})

it('ships independent, parseable executable packages with the same digest as the native store',async()=>{
  expect(new Set(bundledExamples.map(e=>e.id)).size).toBe(5)
  for(const example of bundledExamples){
    const pack=await prepareExample(example)
    expect(pack.digest).toBe(clientPackageDigest(example.pack))
    expect(parseExecutableClientPackage(example.pack).manifest.id).toBe(example.id)
    expect(typeof (await load(pack.program.code)).default).toBe('function')
    expect(pack.enabled).toBeUndefined()
  }
})

it('keeps seats, turns, wins, resets and stale moves inside the game plugin',async()=>{
  const {freshGame,gameAction}=await load(bundledExamples[3]!.pack.program.code)
  let s=freshGame()
  const send=(type:string,actor:string,cell?:number)=>{s=gameAction(s,{type,cell,round:s.round},actor)}
  send('join','a');send('join','a');send('join','b');send('join','c')
  expect(s.players).toEqual(['a','b'])
  send('move','b',0);send('move','c',0);send('move','a',99)
  expect(s.board).toEqual(Array(9).fill(null))
  for(const [actor,cell] of [['a',0],['b',3],['a',1],['b',4],['a',2]] as const)send('move',actor,cell)
  expect(s.winner).toBe('a')
  send('move','b',5);expect(s.board[5]).toBeNull()
  send('reset','c');expect(s.players).toEqual([]);expect(s.round).toBe(2)
  send('join','c');send('join','b')
  expect(gameAction(s,{type:'move',cell:0,round:1},'c')).toEqual(s)
  send('move','c',4);send('leave','b')
  expect(s.players).toEqual(['c']);expect(s.board.every((c:unknown)=>c===null)).toBe(true)
  send('join','a');expect(s.players).toEqual(['c','a'])
})

it('recognizes a draw and does not let a spectator reset an unfinished board',async()=>{
  const {freshGame,gameAction,validGame}=await load(bundledExamples[3]!.pack.program.code)
  let s={...freshGame(),players:['a','b']}
  expect(gameAction(s,{type:'reset',round:1},'c')).toEqual(s)
  for(const [i,cell] of [0,1,2,4,3,5,7,6,8].entries())s=gameAction(s,{type:'move',round:1,cell},i%2?'b':'a')
  expect(s.winner).toBe('draw');expect(validGame(s)).toBe(true)
  expect(validGame({...s,players:['a','a']})).toBe(false)
  expect(validGame({...s,board:Array(9).fill('bad')})).toBe(false)
})

it('late join replays a new action over an older peer snapshot and ignores duplicate delivery',async()=>{
  const example=bundledExamples[3]!,module=await load(example.pack.program.code)
  const slots=new ContributionRegistry<UiSlotContribution>(),runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.slots':slots,'chat.network':{}}})
  let receive!:(event:unknown)=>void
  const off=vi.fn(),network={history:async()=>[],send:vi.fn(async()=>{}),subscribe:(listener:(event:unknown)=>void)=>{receive=listener;return off}}
  const conversation={serverId:'server-a',id:'group-a',userId:'spectator',kind:'group',members:[]}
  const loader=new ClientPluginLoader(runtime,{React,network,conversation},load),pack=await prepareExample(example)
  const event=(revision:number,channel:string,payload:unknown,actor='a')=>({channel,payload,trace:{stateRevision:revision,actorId:actor}})
  try{
    await loader.enable(pack)
    let s={...module.freshGame(),players:['a','b']}
    s=module.gameAction(s,{type:'move',cell:0,round:1},'a')
    // A move arrives before the spectator learns the players and previous board.
    const newMove=event(11,'action',{type:'move',round:1,cell:4},'b')
    receive(newMove)
    receive(event(12,'snapshot',{target:'spectator',state:s,sequence:10}))
    const key='mtc.example.tictactoe:'+JSON.stringify([example.id,'server-a','group-a','spectator'])
    const saved=JSON.parse(localStorage.getItem(key)!)
    expect(saved.state.board).toEqual(['X',null,null,null,'O',null,null,null,null]);expect(saved.sequence).toBe(11)
    receive(newMove)
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved)
    receive(event(13,'snapshot',{target:'spectator',state:{...s,board:[]},sequence:12}))
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved)
  }finally{await runtime.close()}
  expect(off).toHaveBeenCalledOnce();expect(slots.list()).toHaveLength(0)
})

async function fixture(index:number,context:unknown={}){
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  const slots=new ContributionRegistry<UiSlotContribution>(),runtime=new CordisPluginRuntime({target:'pc-ui',services:{'ui.slots':slots}})
  const loader=new ClientPluginLoader(runtime,{React},load),pack=await prepareExample(bundledExamples[index]!)
  await loader.enable(pack)
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
  const render=()=>act(async()=>root.render(createElement(UiSlot,{name:'chat.header',entries:slots.list(),context})))
  await render()
  return {container,loader,pack,slots,runtime,render,close:async()=>{await act(async()=>{root.unmount();await runtime.close()});container.remove()}}
}

it('timer catches up after sleep, hot replacement leaves one timer, and disable releases it',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-08T00:00:00Z'))
  const f=await fixture(1)
  try{
    const click=async(selector:string)=>act(async()=>{f.container.querySelector<HTMLButtonElement>(selector)!.click()})
    await click('[data-focus-toggle]')
    vi.setSystemTime(new Date('2026-11-08T00:26:00Z'))
    await act(async()=>vi.advanceTimersByTime(600))
    expect(f.container.querySelector('[data-focus-clock]')?.textContent).toBe('00:00')
    expect(f.container.querySelector('[data-focus-status]')?.textContent).toContain('完成')
    await click('[data-focus-reset]');await click('[data-focus-toggle]')
    const next={...f.pack,manifest:{...f.pack.manifest,version:'1.0.1'},digest:'test-new-version'}
    await act(async()=>{await f.loader.enable(next)});await f.render()
    expect(f.slots.list()).toHaveLength(1);expect(vi.getTimerCount()).toBe(1)
    await act(async()=>{await f.loader.disable(f.pack.manifest.id)})
    expect(f.slots.list()).toHaveLength(0);expect(vi.getTimerCount()).toBe(0)
  }finally{await f.close()}
})

it('phrases append to a draft without sending or replacing existing user text',async()=>{
  let text='我已经写好的内容'
  const send=vi.fn(),setDraft=vi.fn((update:(v:string)=>string)=>{text=update(text)})
  const f=await fixture(0,{setDraft,send})
  // Native dialog behavior is verified in Electron; happy-dom has no close().
  f.container.querySelector('dialog')!.close=()=>{}
  try{
    await act(async()=>f.container.querySelector<HTMLButtonElement>('[data-phrase-insert="0"]')!.click())
    expect(text).toBe('我已经写好的内容\n收到，我稍后回复你。');expect(send).not.toHaveBeenCalled()
  }finally{await f.close()}
})
