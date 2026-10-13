import { expect, it } from 'vitest'
import { parseGroupProgram } from '../src/group-program'
import { diagnoseGroupProgram } from '../src/group-program-diagnostics'

const base=()=>parseGroupProgram({kind:'group-state-machine',initial:{board:[''],count:0},actions:{move:{guard:{ref:'event.cell'},updates:[]}},view:{texts:[{ref:'state.count'}],buttons:[],grids:[{columns:1,cells:{ref:'state.board'},label:{ref:'item'},enabled:{op:'eq',args:[{ref:'index'},0]},action:'move'}]}})
it('accepts action input, grid context and lexically scoped nested predicates',()=>{
  const p=base()
  p.view.texts.push({op:'some',args:[{ref:'state.board'},{op:'eq',args:[{ref:'item'},'']}]})
  expect(diagnoseGroupProgram(p)).toEqual([])
})
it('catches copied action event refs even in lazy branches without breaking wire compatibility',()=>{
  const p=base();p.view.grids[0]!.enabled={op:'and',args:[false,{ref:'event.cell'}]}
  expect(()=>parseGroupProgram(p)).not.toThrow()
  expect(diagnoseGroupProgram(p)).toEqual([expect.stringContaining('view.grids[0].enabled.args[1]：视图没有 event')])
})
it('does not leak item/index from predicate scope to its input or siblings',()=>{
  const p=base();p.view.texts=[{op:'some',args:[{ref:'item'},true]},{ref:'index'}]
  p.actions.move!.guard={ref:'item'}
  expect(diagnoseGroupProgram(p)).toHaveLength(3)
})
it('bounds diagnostics on a valid large program',()=>{
  const p=base();p.view.texts=Array(8).fill(Array(64).fill({ref:'event.cell'}))
  expect(diagnoseGroupProgram(p)).toHaveLength(20)
})
