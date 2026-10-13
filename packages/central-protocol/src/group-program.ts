/** Portable, data-only state machine. No JS, DOM, IO, timers or ambient authority. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value }
export type Expr = Value
export interface GroupProgram {
  kind: 'group-state-machine'
  initial: Record<string, Value>
  actions: Record<string, { guard: Expr; updates: { field: string; value: Expr }[] }>
  view: {
    texts: Expr[]
    buttons: { label: string; action: string; enabled: Expr }[]
    grids: { columns: number; cells: Expr; label: Expr; action: string; enabled: Expr }[]
  }
}
export interface GroupArtifact {
  manifest: {
    manifestVersion: 1; id: string; version: string; displayName: string; description: string
    targets: ['pc-ui']; engine: { moreThanChat: string }; permissions: ['chat.network']
    services: { requires: ['chat.network'] }
  }
  program: GroupProgram
}
export interface ProgramContext {
  state: Record<string, Value>; actor: string; members: string[]; event: Record<string, Value>
  item?: Value; index?: number
}
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
const keyPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/
const arities: Record<string, [number, number]> = {
  eq:[2,2], ne:[2,2], and:[1,16], or:[1,16], not:[1,1], if:[3,3],
  add:[2,2], sub:[2,2], lt:[2,2], lte:[2,2], get:[2,2], length:[1,1],
  includes:[2,2], append:[2,2], setAt:[3,3], some:[2,2], every:[2,2], filter:[2,2],
}
function fail(): never { throw new Error('群插件定义或状态不符合受限协议') }
function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail()
  return v as Record<string, any>
}
function keys(v: unknown, expected: string[]): Record<string, any> {
  const r = object(v)
  if (Object.keys(r).length !== expected.length || expected.some(k => !Object.hasOwn(r,k))) throw new Error('群插件对象字段必须为：'+expected.join(', '))
  return r
}
function text(v: unknown, max: number): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail()
}
function name(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !keyPattern.test(v) || unsafe.has(v)) fail()
}
function list(v: unknown, max: number): any[] { if (!Array.isArray(v) || v.length > max) fail(); return v }
function data(v: unknown, depth = 0, budget = { n: 4096 }, maxDepth = 16): void {
  if (--budget.n < 0 || depth > maxDepth) fail()
  if (v === null || typeof v === 'boolean') return
  if (typeof v === 'string') { if (v.length > 1000) fail(); return }
  if (typeof v === 'number') { if (!Number.isFinite(v) || Math.abs(v) > 1e9) fail(); return }
  if (Array.isArray(v)) { for (const x of list(v,64)) data(x,depth+1,budget,maxDepth); return }
  for (const [k,x] of Object.entries(object(v))) { name(k); data(x,depth+1,budget,maxDepth) }
}
function expression(v: unknown, depth = 0): void {
  if (depth > 16) fail()
  if (Array.isArray(v)) { for (const x of v) expression(x,depth+1); return }
  if (v === null || typeof v !== 'object') return
  const r=object(v)
  if (Object.hasOwn(r,'ref')) {
    keys(r,['ref']); text(r.ref,160)
    const parts=r.ref.split('.')
    if (!['state','actor','members','event','item','index'].includes(parts[0]!) || parts.length>5) fail()
    for (const part of parts.slice(1)) if (!/^(?:[a-zA-Z][a-zA-Z0-9_]{0,47}|\d{1,2})$/.test(part) || unsafe.has(part)) fail()
    return
  }
  keys(r,['op','args'])
  if (typeof r.op !== 'string' || !Object.hasOwn(arities,r.op)) throw new Error('群插件使用了未支持的表达式运算符，请参照 SDK operators')
  const args=list(r.args,16), [min,max]=arities[r.op]!
  if (args.length<min || args.length>max) throw new Error('群插件表达式参数数量不符合 SDK')
  for (const arg of args) expression(arg,depth+1)
}
export function parseGroupProgram(value: unknown): GroupProgram {
  if (JSON.stringify(value).length>24000) fail()
  data(value,0,{n:4096},40)
  const p=keys(value,['kind','initial','actions','view'])
  if (p.kind!=='group-state-machine') fail()
  validateProgramState(p.initial)
  const fields=Object.keys(p.initial), actions=object(p.actions)
  if (!fields.length || fields.length>24 || !Object.keys(actions).length || Object.keys(actions).length>16) fail()
  for (const [id,value] of Object.entries(actions)) {
    name(id); const a=keys(value,['guard','updates']); expression(a.guard)
    for (const update of list(a.updates,32)) {
      const u=keys(update,['field','value']); if (!fields.includes(u.field)) fail(); expression(u.value)
    }
  }
  const view=keys(p.view,['texts','buttons','grids'])
  for (const e of list(view.texts,8)) expression(e)
  for (const b of list(view.buttons,16)) {
    keys(b,['label','action','enabled']); text(b.label,80); expression(b.enabled)
    if (!Object.hasOwn(actions,b.action)) fail()
  }
  for (const g of list(view.grids,4)) {
    keys(g,['columns','cells','label','action','enabled'])
    if (!Number.isInteger(g.columns)||g.columns<1||g.columns>8||!Object.hasOwn(actions,g.action)) fail()
    expression(g.cells); expression(g.label); expression(g.enabled)
  }
  return JSON.parse(JSON.stringify(p)) as GroupProgram
}
export function validateProgramState(value: unknown): asserts value is Record<string,Value> {
  object(value); data(value)
  if (JSON.stringify(value).length>8000 || Object.keys(value as object).length>24) fail()
}
export function parseGroupArtifact(value: unknown): GroupArtifact {
  const a=keys(value,['manifest','program'])
  const m=keys(a.manifest,['manifestVersion','id','version','displayName','description','targets','engine','permissions','services'])
  text(m.id,128); text(m.version,32); text(m.displayName,80); text(m.description,500)
  if (m.manifestVersion!==1 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(m.id) || !/^\d+\.\d+\.\d+$/.test(m.version)) fail()
  keys(m.engine,['moreThanChat']); if (m.engine.moreThanChat!=='^0.1.0') fail()
  keys(m.services,['requires'])
  if (JSON.stringify(m.targets)!=='["pc-ui"]' || JSON.stringify(m.permissions)!=='["chat.network"]' || JSON.stringify(m.services.requires)!=='["chat.network"]') fail()
  return {manifest:JSON.parse(JSON.stringify(m)),program:parseGroupProgram(a.program)}
}
/** Each evaluation is bounded, including nested array predicates. Missing refs are null. */
export function evaluate(expr: Expr, ctx: ProgramContext, budget = { n: 10000 }): Value {
  if (--budget.n<0) throw new Error('群插件运算预算已耗尽')
  if (Array.isArray(expr)) return expr.map(x=>evaluate(x,ctx,budget))
  if (expr===null || typeof expr!=='object') return expr
  if ('ref' in expr) {
    const parts=String(expr.ref).split('.')
    let value: unknown=ctx
    for (const p of parts) {
      if (unsafe.has(p) || !value || typeof value!=='object' || !Object.hasOwn(value,p)) return null
      value=(value as Record<string,unknown>)[p]
    }
    return (value ?? null) as Value
  }
  const op=String(expr.op), args=expr.args as Expr[]
  if (!Object.hasOwn(arities,op) || !Array.isArray(args)) fail()
  const at=(i:number)=>evaluate(args[i]!,ctx,budget)
  if (op==='if') return at(0)===true ? at(1) : at(2)
  if (op==='and') return args.every(x=>evaluate(x,ctx,budget)===true)
  if (op==='or') return args.some(x=>evaluate(x,ctx,budget)===true)
  if (op==='not') return at(0)!==true
  if (['some','every','filter'].includes(op)) {
    const arr=list(at(0),64)
    const predicate=(item:Value,index:number)=>evaluate(args[1]!,{...ctx,item,index},budget)===true
    return op==='some'?arr.some(predicate):op==='every'?arr.every(predicate):arr.filter(predicate)
  }
  const a=at(0), b=args.length>1?at(1):null
  if (op==='eq') return JSON.stringify(a)===JSON.stringify(b)
  if (op==='ne') return JSON.stringify(a)!==JSON.stringify(b)
  if (op==='get') {
    if (!Array.isArray(a)||!Number.isInteger(b)||Number(b)<0||Number(b)>=a.length) return null
    return a[Number(b)]!
  }
  if (op==='length') return list(a,64).length
  if (op==='includes') return list(a,64).some(x=>JSON.stringify(x)===JSON.stringify(b))
  if (op==='append') { const result=[...list(a,63),b]; return result }
  if (op==='setAt') {
    const arr=[...list(a,64)]
    if (!Number.isInteger(b)||Number(b)<0||Number(b)>=arr.length) fail()
    arr[Number(b)]=at(2); return arr
  }
  if (typeof a!=='number'||typeof b!=='number') fail()
  if (op==='lt') return a<b
  if (op==='lte') return a<=b
  const result=op==='add'?a+b:op==='sub'?a-b:NaN
  if (!Number.isFinite(result)||Math.abs(result)>1e9) fail()
  return result
}
export function transition(program: GroupProgram, context: ProgramContext, action: string): Record<string,Value> {
  const rule=Object.hasOwn(program.actions,action)?program.actions[action]:undefined
  if (!rule || !context.members.includes(context.actor)) throw new Error('无权执行该插件动作')
  validateProgramState(context.state); data(context.event)
  const state=JSON.parse(JSON.stringify(context.state)) as Record<string,Value>, budget={n:10000}
  const ctx={...context,state}
  if (evaluate(rule.guard,ctx,budget)!==true) throw new Error('当前状态不允许这个动作，请等待同步或检查参与资格')
  for (const update of rule.updates) {
    state[update.field]=evaluate(update.value,ctx,budget)
    validateProgramState(state)
  }
  return state
}
