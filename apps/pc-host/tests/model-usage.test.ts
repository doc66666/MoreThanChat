import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServerSentEvents, createOpenAiCompatibleProvider } from '../src/openai-compatible'
import { ModelService } from '../src/model-service'
import type { HostEventMessage } from '@more-than-chat/protocol'

describe('provider token reporting', () => {
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
