import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServerSentEvents, createOpenAiCompatibleProvider } from '../src/openai-compatible'
import { ModelService } from '../src/model-service'
import { parseHostMessage, MODEL_MAX_REQUESTS, type HostEventMessage } from '@more-than-chat/protocol'

describe('provider token reporting', () => {
  it.each([7, 11, MODEL_MAX_REQUESTS])('emits protocol-valid usage after %i real provider-adapter requests', async requestCount => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mtc-usage-'))
    let calls=0
    const events: HostEventMessage[]=[]
    const provider=createOpenAiCompatibleProvider(async (_url,init) => {
      calls++
      const request=JSON.parse(String(init?.body))
      const last=calls===requestCount
      if(calls===MODEL_MAX_REQUESTS) expect(request.tools).toBeUndefined()
      const delta=last ? {content:'completed'} : {tool_calls:[{index:0,id:'tool-'+calls,type:'function',function:{name:'inspect_drafts',arguments:'{}'}}]}
      return new Response(`data: ${JSON.stringify({choices:[{delta,finish_reason:last?'stop':'tool_calls'}]})}\n\ndata: ${JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
    })
    // In-memory adapter only: no network requests, credentials or user profile.
    const service=new ModelService({dataDir:dir,generation:1,providers:{mock:{stream:(request,delta)=>provider.stream({...request,apiKey:'fixture-only'},delta)}}})
    try {
      await service.load()
      await new Promise<void>((resolve,reject)=>{
        service.start({streamId:'usage',conversationId:'test',assistantMessageId:'reply',messages:[{role:'user',content:'hi'}]},event=>{
          try { parseHostMessage(event); events.push(event) } catch(error) { reject(error); return }
          if(event.event==='model.chat.completed')resolve()
          if(event.event==='model.chat.failed')reject(new Error(event.payload.error.message))
        })
      })
      expect(calls).toBe(requestCount)
      expect(events.at(-1)).toMatchObject({event:'model.chat.completed',payload:{usage:{requestCount,reportedRequests:requestCount,inputTokens:10*requestCount,outputTokens:4*requestCount,totalTokens:14*requestCount}}})
    } finally { service.close(); await rm(dir,{recursive:true,force:true}) }
  })

  it('reads usage-only SSE chunks after the finish marker and does not estimate missing usage', async () => {
    const seen: unknown[] = []
    const body = new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\ndata: [DONE]\n\n').body!
    await readServerSentEvents(body, () => {}, usage => seen.push(usage))
    expect(seen).toEqual([{ inputTokens: 12, outputTokens: 3, totalTokens: 15 }])
    await readServerSentEvents(new Response('data: {"usage":{"prompt_tokens":-1,"completion_tokens":2},"choices":[]}\n\ndata: [DONE]\n\n').body!, () => {}, usage => seen.push(usage))
    expect(seen).toHaveLength(1)
  })
  it('accepts token counts from non-streaming compatibility responses', async () => {
    const provider = createOpenAiCompatibleProvider(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }), { headers: { 'content-type': 'application/json' } }))
    expect(await provider.stream({ apiKey: 'qa-key', baseUrl: 'http://localhost', model: 'qa', messages: [], signal: new AbortController().signal }, () => {})).toMatchObject({ usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } })
  })
  it('aggregates author rounds and marks partly reported counts explicitly', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mtc-usage-'))
    let round = 0
    const events: HostEventMessage[] = []
    const service = new ModelService({ dataDir: dir, generation: 1, providers: { mock: { async stream(_request, delta) {
      round++
      if (round <= 2) return { toolCalls: [{ id: `tool-${round}`, name: 'inspect_drafts', arguments: '{}' }], usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }
      delta('reply'); return { toolCalls: [] }
    } } } })
    try {
      await service.load()
      await new Promise<void>((resolve, reject) => {
        service.start({ streamId: 'usage', conversationId: 'test', assistantMessageId: 'reply', messages: [{ role: 'user', content: 'hi' }] }, event => {
          events.push(event)
          if (event.event === 'model.chat.completed') resolve()
          if (event.event === 'model.chat.failed') reject(new Error(event.payload.error.message))
        })
      })
      expect(events.at(-1)).toMatchObject({ event: 'model.chat.completed', payload: { usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, requestCount: 3, reportedRequests: 2 } } })
    } finally { service.close(); await rm(dir, { recursive: true, force: true }) }
  })
})
