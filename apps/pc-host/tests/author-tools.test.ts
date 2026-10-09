import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostEventMessage } from '@more-than-chat/protocol'
import { createAuthorToolExecutor } from '../src/author-tools'
import { ModelService } from '../src/model-service'
import { createMockProvider, createOpenAiCompatibleProvider, type ChatModelProvider } from '../src/openai-compatible'
import { PluginDraftService } from '../src/plugin-drafts'

const secret = 'sk-test-more-than-chat-secret'
const source = JSON.stringify({ kind: 'composer-transform-action', actionId: 'trim', label: '清理空白', operation: 'trim' })
const directories: string[] = []

afterEach(async () => {
  delete (globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('plugin author tool loop', () => {
  it('creates a draft from a model tool call without executing its source', async () => {
    const seen: string[] = []
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const round = request.messages.filter(message => message.role === 'tool').length
        if (round === 0) {
          return {
            toolCalls: [{
              id: 'call-create',
              name: 'create_draft',
              arguments: JSON.stringify({ manifestJson: manifest('example.note'), source }),
            }],
          }
        }
        if (round === 1) {
          return { toolCalls: [{ id: 'call-validate', name: 'validate_draft', arguments: JSON.stringify({ draftId: 'example.note' }) }] }
        }
        if (round === 2) {
          return { toolCalls: [{ id: 'call-diagnose', name: 'diagnose_draft', arguments: JSON.stringify({ draftId: 'example.note' }) }] }
        }
        seen.push(JSON.stringify(request.messages))
        onDelta('草稿已创建')
        return { toolCalls: [] }
      },
    }
    const { service, drafts, events } = await createLoop(provider)
    await service.setSettings({ providerMode: 'mock', apiKey: secret })
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))

    expect(events.at(-1)).toMatchObject({ event: 'model.chat.completed', payload: { text: '草稿已创建' } })
    expect(JSON.stringify(events)).not.toContain(source)
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(seen.join('\n')).toContain('尚未安装')
    expect(seen.join('\n')).not.toContain(source)
    expect(seen.join('\n')).not.toContain(secret)
    const toolEvents = events.filter(event => event.event === 'model.authorTool')
    expect(toolEvents.map(event => `${event.payload.phase}:${event.payload.tool}`)).toEqual([
      'started:create_draft',
      'finished:create_draft',
      'started:validate_draft',
      'finished:validate_draft',
      'started:diagnose_draft',
      'finished:diagnose_draft',
    ])
    for (const event of toolEvents) {
      if (event.payload.phase === 'finished') {
        expect(event.payload.pendingInstall).toBe(true)
        expect(event.payload.ok).toBe(true)
        expect(event.payload.draft).toMatchObject({ id: 'example.note' })
      }
      else {
        expect(event.payload.pendingInstall).toBe(false)
        expect(event.payload.draft).toBeNull()
        expect(event.payload.summary.startsWith('正在')).toBe(true)
      }
    }
    expect((globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan).toBeUndefined()
    const inspection = await drafts.inspect()
    expect(inspection.drafts.map(draft => draft.id)).toEqual(['example.note'])
    expect(JSON.stringify(inspection)).not.toContain(source)
  })

  it('refuses a model install request and leaves the draft uninstalled', async () => {
    const seen: string[] = []
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const round = request.messages.filter(message => message.role === 'tool').length
        if (round === 0) {
          return { toolCalls: [{ id: 'call-install', name: 'install_draft', arguments: JSON.stringify({ draftId: 'example.note' }) }] }
        }
        seen.push(JSON.stringify(request.messages))
        onDelta('没有安装')
        return { toolCalls: [] }
      },
    }
    const { service, drafts, events } = await createLoop(provider)
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    expect(events.at(-1)).toMatchObject({ payload: { text: '没有安装' } })
    expect(seen.join('\n')).toContain('模型不能安装插件')
    expect(seen.join('\n')).not.toContain(source)
    const finished = events.filter(event => event.event === 'model.authorTool' && event.payload.phase === 'finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]?.payload).toMatchObject({
      tool: 'install_draft',
      ok: false,
      pendingInstall: false,
      draft: null,
    })
    expect(finished[0]?.payload.summary).toContain('模型不能安装插件')
    expect((await drafts.inspect()).installed).toEqual([])
    expect((await drafts.inspect()).drafts).toEqual([])
  })

  it('sends author tools to an OpenAI-compatible model and returns a redacted inspect result', async () => {
    const directory = await tempDir()
    const drafts = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
    await drafts.create({ manifestJson: manifest('example.note'), source })
    const bodies: Array<{ messages: unknown; tools?: Array<{ function?: { name?: string } }> }> = []
    let round = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      round += 1
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown; tools?: Array<{ function?: { name?: string } }> })
      const payload = round === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-inspect', type: 'function', function: { name: 'inspect_drafts', arguments: '{}' } }] } }] }
        : { choices: [{ delta: { content: '草稿已检查' } }] }
      return sse(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n`)
    }
    const service = new ModelService({
      dataDir: directory,
      generation: 2,
      authorTools: createAuthorToolExecutor(drafts),
      providers: { 'openai-compatible': createOpenAiCompatibleProvider(fetchImpl) },
    })
    await service.load()
    await service.setSettings({ providerMode: 'openai-compatible', apiKey: secret, baseUrl: 'https://api.deepseek.com' })
    const events: HostEventMessage[] = []
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))

    expect(events.at(-1)).toMatchObject({ payload: { text: '草稿已检查' } })
    expect(JSON.stringify(events)).not.toContain(source)
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(bodies[0]?.tools?.map(tool => tool.function?.name)).toEqual(['inspect_drafts', 'create_draft', 'validate_draft', 'diagnose_draft'])
    const inspected = events.find(event => event.event === 'model.authorTool' && event.payload.phase === 'finished')
    expect(inspected?.payload).toMatchObject({ tool: 'inspect_drafts', ok: true, pendingInstall: false, draft: null })
    expect(inspected?.payload.summary).toContain('1')
    expect(JSON.stringify(bodies[1]?.messages)).toContain('example.note')
    expect(JSON.stringify(bodies[1]?.messages)).not.toContain(source)
    expect(JSON.stringify(bodies)).not.toContain(secret)
    expect((globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan).toBeUndefined()
  })

  it('stops after the tool-call limit without running draft source', async () => {
    const provider: ChatModelProvider = {
      async stream() {
        return { toolCalls: [{ id: 'call-inspect', name: 'inspect_drafts', arguments: '{}' }] }
      },
    }
    const { service, events } = await createLoop(provider)
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.failed'))
    expect(events.some(event => event.event === 'model.chat.completed')).toBe(false)
    expect(JSON.stringify(events)).toContain('插件作者工具调用次数已达上限')
    expect((globalThis as { __mtcAuthorToolRan?: boolean }).__mtcAuthorToolRan).toBeUndefined()
  })

  it('reports a missing draft as a failure and does not mark it pending', async () => {
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        const round = request.messages.filter(message => message.role === 'tool').length
        if (round === 0) {
          return { toolCalls: [{ id: 'call-missing', name: 'validate_draft', arguments: JSON.stringify({ draftId: 'missing.draft' }) }] }
        }
        onDelta('没有这份草稿')
        return { toolCalls: [] }
      },
    }
    const { service, events } = await createLoop(provider)
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    const finished = events.find(event => event.event === 'model.authorTool' && event.payload.phase === 'finished')
    expect(finished?.payload).toMatchObject({
      tool: 'validate_draft',
      ok: false,
      pendingInstall: false,
      draft: null,
    })
    expect(finished?.payload.summary).toContain('没有找到')
    expect(JSON.stringify(events)).not.toContain(source)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('keeps the mock reply path when the model does not call a tool', async () => {
    const directory = await tempDir()
    let calls = 0
    const service = new ModelService({
      dataDir: directory,
      generation: 3,
      authorTools: {
        async execute() {
          calls += 1
          return {
            content: '不应调用',
            notice: { tool: 'unknown' as const, ok: false, summary: '不应调用', pendingInstall: false, draft: null },
          }
        },
      },
      providers: { mock: createMockProvider() },
    })
    await service.load()
    const events: HostEventMessage[] = []
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    expect(calls).toBe(0)
    expect(events.at(-1)?.event).toBe('model.chat.completed')
  })
})

async function createLoop(provider: ChatModelProvider): Promise<{ service: ModelService; drafts: PluginDraftService; events: HostEventMessage[] }> {
  const directory = await tempDir()
  const drafts = new PluginDraftService({ dataDir: directory, installedPlugins: () => [] })
  const service = new ModelService({
    dataDir: directory,
    generation: 1,
    authorTools: createAuthorToolExecutor(drafts),
    providers: { mock: provider },
  })
  await service.load()
  const events: HostEventMessage[] = []
  return { service, drafts, events }
}

function startInput() {
  return {
    streamId: 'stream-author',
    conversationId: 'conversation-author',
    assistantMessageId: 'assistant-author',
    messages: [{ role: 'user' as const, content: '请处理插件草稿' }],
  }
}

function manifest(id: string): string {
  return JSON.stringify({
    manifestVersion: 1,
    id,
    version: '0.1.0',
    displayName: '草稿示例',
    description: '只保存在草稿目录，不会被安装。',
    targets: ['pc-host'],
    engine: { moreThanChat: '^0.1.0' },
    permissions: [],
    services: { requires: ['host.tools'] },
  })
}

function sse(text: string): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-author-'))
  await chmod(directory, 0o700)
  directories.push(directory)
  return directory
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error('timed out waiting for the model loop')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
