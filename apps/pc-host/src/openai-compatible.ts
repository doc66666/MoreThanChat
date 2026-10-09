import type { ModelChatMessage } from '@more-than-chat/protocol'
import { AUTHOR_TOOL_DEFINITIONS, type AuthorToolCall } from './author-tools'
import { ModelServiceError } from './model-error'

export type ProviderMessage = ModelChatMessage | {
  role: 'assistant'
  content: string
  toolCalls: readonly AuthorToolCall[]
} | {
  role: 'tool'
  toolCallId: string
  name: string
  content: string
}

export interface ProviderTurn {
  readonly toolCalls: readonly AuthorToolCall[]
}

export interface ProviderChatRequest {
  baseUrl: string
  model: string
  apiKey: string
  messages: readonly ProviderMessage[]
  signal: AbortSignal
}

export interface ChatModelProvider {
  stream(request: ProviderChatRequest, onDelta: (text: string) => void): Promise<ProviderTurn | void>
}

const MAX_ERROR_BODY = 180

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return `${trimmed}/chat/completions`
}

export function createMockProvider(chunkDelayMs = 0): ChatModelProvider {
  return {
    async stream(request, onDelta) {
      const lastUser = [...request.messages].reverse().find(message => message.role === 'user')?.content ?? ''
      const text = `（模拟回复）${lastUser.slice(0, 120)}\n\n这是本地模拟流，没有访问网络。`
      const size = 12
      for (let index = 0; index < text.length; index += size) {
        if (request.signal.aborted) throw abortError()
        onDelta(text.slice(index, index + size))
        if (chunkDelayMs > 0) await delay(chunkDelayMs, request.signal)
      }
    },
  }
}

export function createOpenAiCompatibleProvider(fetchImpl: typeof fetch = globalThis.fetch): ChatModelProvider {
  return {
    async stream(request, onDelta) {
      if (!request.apiKey) throw new ModelServiceError('CREDENTIAL_UNAVAILABLE', '还没有保存 API Key。', false)
      let response: Response
      try {
        response = await fetchImpl(chatCompletionsUrl(request.baseUrl), {
          method: 'POST',
          signal: request.signal,
          headers: {
            accept: 'text/event-stream, application/json',
            authorization: `Bearer ${request.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages.map(toApiMessage),
            tools: AUTHOR_TOOL_DEFINITIONS,
            tool_choice: 'auto',
            stream: true,
          }),
        })
      }
      catch (error) {
        if (request.signal.aborted || isAbortError(error)) throw abortError()
        throw new ModelServiceError('MODEL_REQUEST_FAILED', '无法连接模型服务。', true)
      }
      if (!response.ok) {
        const detail = await readErrorBody(response)
        const retryable = response.status === 429 || response.status >= 500
        throw new ModelServiceError('MODEL_REQUEST_FAILED', `模型请求失败（HTTP ${response.status}）。${detail}`.trim(), retryable)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
        const payload: unknown = await response.json()
        const text = extractMessageText(payload)
        if (text) onDelta(text)
        return { toolCalls: collectToolCalls(payload) }
      }
      if (!response.body) throw new ModelServiceError('MODEL_REQUEST_FAILED', '模型服务没有返回响应体。', true)
      return { toolCalls: await readServerSentEvents(response.body, onDelta) }
    },
  }
}

function toApiMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, name: message.name, content: message.content }
  }
  if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

export async function readServerSentEvents(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<AuthorToolCall[]> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const partials = new Map<number, MutableToolCall>()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) consumeSseLine(line, onDelta, partials)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consumeSseLine(buffer, onDelta, partials)
  return finishToolCalls(partials)
}

function consumeSseLine(line: string, onDelta: (text: string) => void, partials: Map<number, MutableToolCall>): void {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return
  let parsed: unknown
  try {
    parsed = JSON.parse(data) as unknown
  }
  catch {
    throw new ModelServiceError('MODEL_REQUEST_FAILED', '模型流返回了无法解析的数据。', true)
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed && (parsed as { error?: unknown }).error) {
    throw new ModelServiceError('MODEL_REQUEST_FAILED', publicStreamError((parsed as { error?: unknown }).error), true)
  }
  const text = extractDeltaText(parsed)
  if (text) onDelta(text)
  absorbToolCalls(parsed, partials)
}

interface MutableToolCall {
  id: string
  name: string
  arguments: string
}

function collectToolCalls(value: unknown): AuthorToolCall[] {
  const partials = new Map<number, MutableToolCall>()
  absorbToolCalls(value, partials)
  return finishToolCalls(partials)
}

function absorbToolCalls(value: unknown, into: Map<number, MutableToolCall>): void {
  if (!value || typeof value !== 'object') return
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return
  const first = choices[0]
  if (!first || typeof first !== 'object') return
  const record = first as { delta?: unknown; message?: unknown }
  absorbPart(record.delta, into)
  absorbPart(record.message, into)
}

function absorbPart(part: unknown, into: Map<number, MutableToolCall>): void {
  if (!part || typeof part !== 'object') return
  const calls = (part as { tool_calls?: unknown }).tool_calls
  if (!Array.isArray(calls)) return
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const record = call as { index?: unknown; id?: unknown; function?: unknown }
    const index = typeof record.index === 'number' && record.index >= 0 && record.index < 8 ? record.index : into.size
    if (index >= 8) continue
    const current = into.get(index) ?? { id: '', name: '', arguments: '' }
    if (typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 80) current.id = record.id
    const fn = record.function
    if (fn && typeof fn === 'object') {
      const name = (fn as { name?: unknown }).name
      const args = (fn as { arguments?: unknown }).arguments
      if (typeof name === 'string' && current.name.length < 80) current.name = `${current.name}${name}`.slice(0, 80)
      if (typeof args === 'string' && current.arguments.length < 20_000) current.arguments = `${current.arguments}${args}`.slice(0, 20_000)
    }
    into.set(index, current)
  }
}

function finishToolCalls(into: Map<number, MutableToolCall>): AuthorToolCall[] {
  return [...into.entries()].sort((left, right) => left[0] - right[0]).flatMap(([index, call]) => {
    const name = call.name.trim()
    if (!name) return []
    return [{ id: call.id.trim() || `call-${index}`, name, arguments: call.arguments }]
  })
}

function extractDeltaText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const delta = (first as { delta?: unknown }).delta
  if (!delta || typeof delta !== 'object') return ''
  const content = (delta as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

function extractMessageText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const message = (first as { message?: unknown }).message
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

function publicStreamError(error: unknown): string {
  if (!error || typeof error !== 'object') return '模型流返回错误。'
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string' || !message.trim()) return '模型流返回错误。'
  return message.trim().slice(0, MAX_ERROR_BODY)
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.slice(0, MAX_ERROR_BODY)
  }
  catch {
    return ''
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
