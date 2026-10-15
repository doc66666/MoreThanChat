import {expect,it} from 'vitest'
import {createOpenAiCompatibleProvider,readServerSentEvents} from '../src/openai-compatible'

const call=(index:number)=>({index,id:`call-${index}`,type:'function',function:{name:'inspect_drafts',arguments:'{}'}})
const sse=(calls:unknown[])=>new Response(`data: ${JSON.stringify({choices:[{delta:{tool_calls:calls},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`).body!

it('keeps all calls beyond eight, including out-of-order streaming indexes',async()=>{
  const calls=Array.from({length:20},(_,i)=>call(i)).reverse()
  const result=await readServerSentEvents(sse(calls),()=>{})
  expect(result.map(c=>c.id)).toEqual(Array.from({length:20},(_,i)=>`call-${i}`))
})

it('accepts JSON responses with no index and keeps every call',async()=>{
  const calls=Array.from({length:20},(_,i)=>{const {index,...rest}=call(i);return rest})
  const provider=createOpenAiCompatibleProvider(async()=>new Response(JSON.stringify({choices:[{message:{tool_calls:calls},finish_reason:'tool_calls'}]}),{headers:{'content-type':'application/json'}}))
  const result=await provider.stream({apiKey:'fixture-only',baseUrl:'http://localhost',model:'fixture',messages:[],signal:new AbortController().signal},()=>{})
  expect(result?.toolCalls).toHaveLength(20)
})

it('joins fragmented arguments without creating phantom extra calls',async()=>{
  const chunks=[{id:'one',function:{name:'inspect_drafts',arguments:'{'}},{function:{arguments:'}'}}]
  const body=new Response(chunks.map(c=>`data: ${JSON.stringify({choices:[{delta:{tool_calls:[c]}}]})}\n\n`).join('')+'data: [DONE]\n\n').body!
  expect(await readServerSentEvents(body,()=>{})).toEqual([{id:'one',name:'inspect_drafts',arguments:'{}'}])
})

it.each([
  [call(0),{...call(1),id:'call-0'}],
  [{...call(0),index:-1}],
  [{...call(0),index:0.5}],
  [{...call(0),function:{arguments:'{}'}}],
  [null],
])('rejects malformed batches instead of silently reporting completion: %j',async(...calls)=>{
  await expect(readServerSentEvents(sse(calls),()=>{})).rejects.toThrow('工具调用格式')
})
