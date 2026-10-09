import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostEventMessage } from '@more-than-chat/protocol'
import { ModelService } from '../src/model-service'
import { MemoryModelCredentials } from '../src/credential-client'
import { createOpenAiCompatibleProvider, type ChatModelProvider } from '../src/openai-compatible'

const secret = 'sk-test-more-than-chat-secret'
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('ModelService', () => {
  it('does not clear an unreadable stored credential when encryption rejects a replacement', async () => {
    const root = await tempDir()
    const write = vi.fn(async (_key: string | null) => { throw new Error('Encryption unavailable') })
    const service = new ModelService({ dataDir: root, generation: 1, credentials: {
      read: async () => { throw new Error('Encryption unavailable') }, write,
    } })
    await service.load()
    await expect(service.setSettings({ apiKey: 'replacement-test-value' })).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalledWith(null)
  })
  it('streams a mock reply and keeps the API key out of settings, events, and the mock provider', async () => {
    const seen: string[] = []
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        seen.push(request.apiKey)
        onDelta('模拟')
        onDelta('回复')
      },
    }
    const { service, events, directory } = await createService({ mock: provider })
    await service.setSettings({
      providerMode: 'mock',
      apiKey: secret,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    })

    const ref = service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))

    expect(ref.generation).toBe(3)
    expect(seen).toEqual([''])
    expect(events.map(event => event.event)).toEqual(['model.chat.delta', 'model.chat.delta', 'model.chat.completed'])
    expect(events.at(-1)).toMatchObject({ event: 'model.chat.completed', payload: { text: '模拟回复' } })
    expect(JSON.stringify(service.getSettings())).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
    const settings = await readFile(path.join(directory, 'model-settings.json'), 'utf8')
    expect(settings).not.toContain(secret)
    await expect(readFile(path.join(directory, 'model-credentials.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }
  })

  it('reloads the credential without returning it, and clear removes the file', async () => {
    const directory = await tempDir()
    const credentials = new MemoryModelCredentials()
    const first = new ModelService({ dataDir: directory, generation: 1, credentials })
    await first.load()
    await first.setSettings({ apiKey: secret, providerMode: 'openai-compatible', model: 'deepseek-chat' })
    const second = new ModelService({ dataDir: directory, generation: 2, credentials })
    await second.load()
    expect(second.getSettings()).toMatchObject({ hasApiKey: true, providerMode: 'openai-compatible', model: 'deepseek-chat' })
    expect(JSON.stringify(second.getSettings())).not.toContain(secret)

    await second.setSettings({ clearApiKey: true, apiKey: secret })
    expect(second.getSettings().hasApiKey).toBe(false)
    await expect(readFile(path.join(directory, 'model-credentials.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const settings = await readFile(path.join(directory, 'model-settings.json'), 'utf8')
    expect(settings).not.toContain(secret)
  })

  it('does not call the network provider when no API key is stored', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const directory = await tempDir()
    const service = new ModelService({ dataDir: directory, generation: 1, fetchImpl })
    await service.load()
    await service.setSettings({ providerMode: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' })
    expect(() => service.start(startInput(), () => undefined)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE' }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('marks a cancelled stream as cancelled and keeps later completion from winning', async () => {
    let release: (() => void) | undefined
    const provider: ChatModelProvider = {
      async stream(request, onDelta) {
        onDelta('部分')
        await new Promise<void>(resolve => {
          release = resolve
          if (request.signal.aborted) resolve()
          else request.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const { service, events } = await createService({ mock: provider })
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.delta'))
    expect(service.cancel('stream-1')).toEqual({ streamId: 'stream-1', cancelled: true })
    release?.()
    await waitFor(() => events.some(event => event.event === 'model.chat.cancelled'))
    expect(events.some(event => event.event === 'model.chat.completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ event: 'model.chat.cancelled', payload: { partialText: '部分' } })
    expect(() => service.cancel('stream-1')).toThrow(expect.objectContaining({ code: 'MODEL_STREAM_NOT_FOUND' }))
  })

  it('reports provider failures without echoing the credential or marking the reply complete', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
    const provider: ChatModelProvider = {
      async stream() {
        throw new Error(`Authorization: Bearer ${secret}`)
      },
    }
    const { service, events } = await createService({ 'openai-compatible': provider })
    await service.setSettings({ providerMode: 'openai-compatible', apiKey: secret })
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.failed'))
    const failed = events.at(-1)
    expect(failed?.event).toBe('model.chat.failed')
    expect(events.some(event => event.event === 'model.chat.completed')).toBe(false)
    expect(JSON.stringify(events)).not.toContain(secret)
    if (failed?.event === 'model.chat.failed') expect(failed.payload.error.message).not.toContain(secret)
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    }
  })

  it('redacts a credential that a compatible endpoint echoes in an error body', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${secret}`)
      return new Response(JSON.stringify({ error: { message: `bad key ${secret}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    const directory = await tempDir()
    const service = new ModelService({
      dataDir: directory,
      generation: 4,
      providers: { 'openai-compatible': createOpenAiCompatibleProvider(fetchImpl) },
    })
    await service.load()
    await service.setSettings({ providerMode: 'openai-compatible', apiKey: secret, baseUrl: 'https://api.deepseek.com' })
    const events: HostEventMessage[] = []
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.failed'))
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(events.some(event => event.event === 'model.chat.completed')).toBe(false)
  })

  it('assembles an OpenAI-compatible event stream from split chunks', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"choices":[{"delta":{"content":"你',
      '好"}}]}\n\ndata: {"choices":[{"delta":{"content":"！"}}]}\n\ndata: [DONE]\n',
    ]
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const directory = await tempDir()
    const service = new ModelService({
      dataDir: directory,
      generation: 8,
      providers: { 'openai-compatible': createOpenAiCompatibleProvider(fetchImpl) },
    })
    await service.load()
    await service.setSettings({ providerMode: 'openai-compatible', apiKey: secret, baseUrl: 'https://api.openai.com/v1' })
    const events: HostEventMessage[] = []
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.completed'))
    expect(events.at(-1)).toMatchObject({ event: 'model.chat.completed', payload: { text: '你好！' } })
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('rejects a base URL that embeds credentials and leaves the saved key untouched', async () => {
    const { service, directory } = await createService()
    await service.setSettings({ apiKey: secret })
    await expect(service.setSettings({ baseUrl: `https://user:${secret}@example.com/v1` })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' })
    expect(service.getSettings()).toMatchObject({ baseUrl: 'https://api.deepseek.com', hasApiKey: true })
    const settings = await readFile(path.join(directory, 'model-settings.json'), 'utf8')
    expect(settings).not.toContain(secret)
  })

  it('cancels an in-flight reply when the host closes', async () => {
    const provider: ChatModelProvider = {
      stream(request, onDelta) {
        onDelta('还在')
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      },
    }
    const { service, events } = await createService({ mock: provider })
    service.start(startInput(), event => events.push(event))
    await waitFor(() => events.some(event => event.event === 'model.chat.delta'))
    service.close()
    await waitFor(() => events.some(event => event.event === 'model.chat.cancelled'))
    expect(events.some(event => event.event === 'model.chat.completed')).toBe(false)
  })
})

async function createService(providers?: ConstructorParameters<typeof ModelService>[0]['providers']) {
  const directory = await tempDir()
  const service = new ModelService({ dataDir: directory, generation: 3, ...(providers ? { providers } : {}) })
  await service.load()
  const events: HostEventMessage[] = []
  return { service, events, directory }
}

function startInput() {
  return {
    streamId: 'stream-1',
    conversationId: 'conversation-assistant',
    assistantMessageId: 'assistant-1',
    messages: [{ role: 'user' as const, content: '你好' }],
  }
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mtc-model-'))
  await chmod(directory, 0o700)
  directories.push(directory)
  return directory
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error('Timed out waiting for a model event')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
