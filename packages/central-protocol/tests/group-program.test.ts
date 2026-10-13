import { describe, expect, it } from 'vitest'
import { evaluate, parseGroupArtifact, parseGroupProgram, transition, type ProgramContext } from '../src/group-program'
import { groupGameArtifact } from '../../../scripts/fixtures/group-game.mjs'

describe('portable group state machine',()=>{
  const artifact=()=>parseGroupArtifact(structuredClone(groupGameArtifact))
  function game() {
    const program=artifact().program
    const ctx:ProgramContext={state:structuredClone(program.initial),actor:'a',members:['admin','a','b'],event:{}}
    const act=(actor:string,action:string,cell?:number)=>{ctx.actor=actor;ctx.event=cell===undefined?{}:{cell};ctx.state=transition(program,ctx,action)}
    act('a','join');act('b','join')
    return {program,ctx,act}
  }
  it('runs author-defined turns, win, reset and draw without a built-in game handler',()=>{
    const {ctx,act}=game()
    for(const [i,cell] of [0,3,1,4,2].entries())act(i%2?'b':'a','move',cell)
    expect(ctx.state.winner).toBe('a')
    expect(()=>act('b','move',5)).toThrow()
    act('b','reset')
    for(const [i,cell] of [0,1,2,4,3,5,7,6,8].entries())act(i%2?'b':'a','move',cell)
    expect(ctx.state.winner).toBe('draw')
    act('a','leave');expect(ctx.state.players).toEqual(['b']);expect(ctx.state.board).toEqual(Array(9).fill(null))
  })
  it('rejects turn theft, spectators, occupied/invalid cells and departed members atomically',()=>{
    const {ctx,act}=game(),before=structuredClone(ctx.state)
    for(const actor of ['b','admin','outside'])expect(()=>act(actor,'move',0)).toThrow()
    for(const cell of [-1,9,0.5])expect(()=>act('a','move',cell)).toThrow()
    expect(ctx.state).toEqual(before)
    act('a','move',0);expect(()=>act('b','move',0)).toThrow()
    ctx.members=['admin','a'];expect(()=>act('b','move',1)).toThrow()
  })
  it('rejects unknown operators, capabilities, prototype paths, overlong arrays and deep expressions',()=>{
    const bad=artifact();bad.manifest.permissions.push('fs' as never);expect(()=>parseGroupArtifact(bad)).toThrow()
    for(const guard of [{op:'eval',args:['x']},{ref:'state.__proto__'},Array(65).fill(0)]) {
      const p=artifact().program;p.actions.join!.guard=guard;expect(()=>parseGroupProgram(p)).toThrow()
    }
    let nested:any=true;for(let i=0;i<20;i++)nested={op:'not',args:[nested]}
    const p=artifact().program;p.actions.join!.guard=nested;expect(()=>parseGroupProgram(p)).toThrow()
  })
  it('bounds nested predicates and never mutates input when later updates fail',()=>{
    const {program,ctx}=game(),before=structuredClone(ctx.state)
    program.actions.broken={guard:true,updates:[{field:'turn',value:1},{field:'board',value:{op:'setAt',args:[[],9,'bad']}}]}
    expect(()=>transition(program,ctx,'broken')).toThrow();expect(ctx.state).toEqual(before)
    expect(()=>evaluate({op:'every',args:[Array(64).fill(0),{op:'every',args:[Array(64).fill(0),true]}]},ctx,{n:100})).toThrow(/预算/)
  })
  it('supports unrelated state machines, safe missing refs and lazy conditions',()=>{
    const p=parseGroupProgram({kind:'group-state-machine',initial:{count:0},actions:{add:{guard:true,updates:[{field:'count',value:{op:'add',args:[{ref:'state.count'},7]}}]}},view:{texts:[{ref:'state.count'}],buttons:[],grids:[]}})
    const ctx={state:p.initial,actor:'a',members:['a'],event:{}}
    expect(transition(p,ctx,'add')).toEqual({count:7})
    expect(evaluate({op:'if',args:[true,'safe',{op:'setAt',args:[[],9,0]}]},ctx)).toBe('safe')
    expect(evaluate({ref:'event.missing'},ctx)).toBeNull()
  })
})
