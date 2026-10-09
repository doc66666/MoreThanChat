import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createHostEvent,
  type HostEventMessage,
  type HostRequestPayloadMap,
  type ModelChatMessage,
  type ModelChatStreamRef,
  type ModelProviderMode,
  type ModelSettingsSnapshot,
} from '@more-than-chat/protocol'
import { authorToolStarted, type AuthorToolCall, type AuthorToolExecutor, type AuthorToolNotice } from './author-tools'
import { ModelServiceError, sanitizeProviderText } from './model-error'
import {
  createMockProvider,
  createOpenAiCompatibleProvider,
  type ChatModelProvider,
  type ProviderChatRequest,
  type ProviderMessage,
} from './openai-compatible'

export const DEFAULT_MODEL_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL_NAME = 'deepseek-chat'
const MAX_REPLY_CHARS = 500_000
const MAX_DELTA_CHARS = 100_000
const SYSTEM_PROMPT = '你是 MoreThanChat 的桌面助手。根据对话回答。不要索取、复述或猜测 API key。处理插件草稿时只能使用 inspect_drafts、create_draft、validate_draft、diagnose_draft。不要安装插件，安装必须由用户确认。不要复述草稿源码。'
const MAX_TOOL_ROUNDS = 4
const MAX_TOOL_CALLS = 4

export interface ModelServiceOptions {
  dataDir: string
  generation: number
  fetchImpl?: typeof fetch
  providers?: Partial<Record<ModelProviderMode, ChatModelProvider>>
  authorTools?: AuthorToolExecutor
}

interface StoredSettings {
  baseUrl: string
  model: string
  providerMode: ModelProviderMode
}

interface ActiveStream {
  ref: ModelChatStreamRef
  messages: readonly ModelChatMessage[]
  controller: AbortController
  text: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  cancelRequested: boolean
  emit: (event: HostEventMessage) => void
}

/**
 * Runs model calls inside the PC Host. The API key stays in a private credential
 * file and is never copied into settings, events, or plugin services.
 */
export class ModelService {
  readonly #dataDir: string
  readonly #generation: number
  readonly #settingsPath: string
  readonly #credentialPath: string
  readonly #providers: Record<ModelProviderMode, ChatModelProvider>
  readonly #authorTools: AuthorToolExecutor | undefined
  readonly #streams = new Map<string, ActiveStream>()
  #settings: StoredSettings = {
    baseUrl: DEFAULT_MODEL_BASE_URL,
    model: DEFAULT_MODEL_NAME,
    providerMode: 'mock',
  }
  #apiKey: string | null = null
  #closed = false

  constructor(options: ModelServiceOptions) {
    this.#dataDir = options.dataDir
    this.#generation = options.generation
    this.#settingsPath = path.join(options.dataDir, 'model-settings.json')
    this.#credentialPath = path.join(options.dataDir, 'model-credentials.json')
    const fetchImpl = options.fetchImpl
    this.#providers = {
      mock: options.providers?.mock ?? createMockProvider(),
      'openai-compatible': options.providers?.['openai-compatible'] ?? (
        fetchImpl ? createOpenAiCompatibleProvider(fetchImpl) : createOpenAiCompatibleProvider()
      ),
    }
    this.#authorTools = options.authorTools
  }

  async load(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 })
    await chmod(this.#dataDir, 0o700)
    const settings = parseStoredSettings(await readPrivateJson(this.#settingsPath))
    if (settings) this.#settings = settings
    this.#apiKey = parseStoredKey(await readPrivateJson(this.#credentialPath))
  }

  getSettings(): ModelSettingsSnapshot {
    return {
      baseUrl: this.#settings.baseUrl,
      model: this.#settings.model,
      providerMode: this.#settings.providerMode,
      hasApiKey: this.#apiKey !== null,
    }
  }

  async setSettings(input: HostRequestPayloadMap['model.setSettings']): Promise<ModelSettingsSnapshot> {
    if (this.#closed) throw new ModelServiceError('MODEL_NOT_CONFIGURED', '模型服务正在关闭。', true)
    const next: StoredSettings = { ...this.#settings }
    if (input.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(input.baseUrl)
    if (input.model !== undefined) next.model = normalizeModelName(input.model)
    if (input.providerMode !== undefined) next.providerMode = input.providerMode
    this.#settings = next
    if (input.clearApiKey === true) this.#apiKey = null
    else if (input.apiKey !== undefined) this.#apiKey = input.apiKey
    await this.#persist()
    return this.getSettings()
  }

  start(input: HostRequestPayloadMap['model.chat.start'], emit: (event: HostEventMessage) => void): ModelChatStreamRef {
    if (this.#closed) throw new ModelServiceError('MODEL_NOT_CONFIGURED', '模型服务正在关闭。', true)
    if (this.#settings.providerMode === 'openai-compatible' && !this.#apiKey) {
      throw new ModelServiceError('CREDENTIAL_UNAVAILABLE', '还没有保存 API Key。', false)
    }
    if (this.#streams.has(input.streamId)) {
      throw new ModelServiceError('MODEL_REQUEST_FAILED', '这个回复已经在生成。', false)
    }
    const ref: ModelChatStreamRef = {
      streamId: input.streamId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
      generation: this.#generation,
    }
    const stream: ActiveStream = {
      ref,
      messages: input.messages,
      controller: new AbortController(),
      text: '',
      state: 'running',
      cancelRequested: false,
      emit,
    }
    this.#streams.set(input.streamId, stream)
    const secret = this.#settings.providerMode === 'openai-compatible' ? (this.#apiKey ?? '') : ''
    queueMicrotask(() => {
      void this.#run(stream, secret)
    })
    return ref
  }

  cancel(streamId: string): { streamId: string; cancelled: true } {
    const stream = this.#streams.get(streamId)
    if (!stream || stream.state !== 'running') {
      throw new ModelServiceError('MODEL_STREAM_NOT_FOUND', '没有正在生成的回复。', false)
    }
    stream.cancelRequested = true
    stream.controller.abort()
    return { streamId, cancelled: true }
  }

  close(): void {
    this.#closed = true
    for (const stream of this.#streams.values()) {
      if (stream.state !== 'running') continue
      stream.cancelRequested = true
      stream.controller.abort()
    }
  }

  async #run(stream: ActiveStream, secret: string): Promise<void> {
    try {
      if (stream.cancelRequested || stream.controller.signal.aborted) {
        this.#finishCancelled(stream)
        return
      }
      const provider = this.#providers[this.#settings.providerMode]
      if (!provider) throw new ModelServiceError('MODEL_NOT_CONFIGURED', '模型提供方不可用。', false)
      const transcript: ProviderMessage[] = providerMessages(stream.messages)
      let unresolvedTools = false
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (stream.cancelRequested || stream.controller.signal.aborted) {
          this.#finishCancelled(stream)
          return
        }
        const request: ProviderChatRequest = {
          baseUrl: this.#settings.baseUrl,
          model: this.#settings.model,
          apiKey: secret,
          messages: transcript,
          signal: stream.controller.signal,
        }
        const turn = await provider.stream(request, delta => this.#appendDelta(stream, delta))
        if (stream.state !== 'running') return
        const calls = (turn?.toolCalls ?? []).slice(0, MAX_TOOL_CALLS)
        if (calls.length === 0) {
          unresolvedTools = false
          break
        }
        unresolvedTools = true
        await this.#recordToolRound(stream, transcript, calls, secret)
        if (stream.state !== 'running') return
      }
      if (stream.cancelRequested) {
        this.#finishCancelled(stream)
        return
      }
      if (unresolvedTools) {
        this.#finishFailed(stream, new ModelServiceError('MODEL_REQUEST_FAILED', '插件作者工具调用次数已达上限。', false), secret)
        return
      }
      if (!stream.text.trim()) {
        this.#finishFailed(stream, new ModelServiceError('MODEL_REQUEST_FAILED', '模型没有返回文本。', true), secret)
        return
      }
      stream.state = 'completed'
      this.#streams.delete(stream.ref.streamId)
      stream.emit(createHostEvent('model.chat.completed', { ...stream.ref, text: stream.text }))
    }
    catch (error) {
      if (stream.state !== 'running') return
      if (stream.cancelRequested) {
        this.#finishCancelled(stream)
        return
      }
      this.#finishFailed(stream, error, secret)
    }
  }

  async #recordToolRound(stream: ActiveStream, transcript: ProviderMessage[], calls: readonly AuthorToolCall[], secret: string): Promise<void> {
    transcript.push({
      role: 'assistant',
      content: '',
      toolCalls: calls.map(call => ({ id: call.id, name: call.name, arguments: '{}' })),
    })
    for (const call of calls) {
      if (stream.cancelRequested || stream.controller.signal.aborted) {
        this.#finishCancelled(stream)
        return
      }
      this.#emitAuthorTool(stream, 'started', authorToolStarted(call.name), secret)
      const execution = this.#authorTools
        ? await this.#authorTools.execute(call)
        : {
            content: '作者工具不可用。源码没有执行。',
            notice: { ...authorToolStarted(call.name), ok: false, summary: '作者工具不可用。源码没有执行。' },
          }
      if (stream.state !== 'running') return
      this.#emitAuthorTool(stream, 'finished', execution.notice, secret)
      transcript.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: redactSecret(execution.content, secret),
      })
    }
  }

  #emitAuthorTool(stream: ActiveStream, phase: 'started' | 'finished', notice: AuthorToolNotice, secret: string): void {
    const draft = publishDraft(notice.draft, secret)
    stream.emit(createHostEvent('model.authorTool', {
      ...stream.ref,
      phase,
      tool: notice.tool,
      ok: notice.ok,
      summary: publishSummary(redactSecret(notice.summary, secret)),
      pendingInstall: notice.pendingInstall && draft !== null,
      draft,
    }))
  }

  #appendDelta(stream: ActiveStream, delta: string): void {
    if (stream.state !== 'running' || stream.cancelRequested || delta.length === 0) return
    let remaining = delta
    while (remaining.length > 0) {
      if (stream.text.length >= MAX_REPLY_CHARS) {
        throw new ModelServiceError('MODEL_REQUEST_FAILED', '模型回复超出长度限制。', false)
      }
      const piece = remaining.slice(0, Math.min(MAX_DELTA_CHARS, MAX_REPLY_CHARS - stream.text.length))
      remaining = remaining.slice(piece.length)
      stream.text += piece
      stream.emit(createHostEvent('model.chat.delta', { ...stream.ref, textDelta: piece }))
    }
  }

  #finishCancelled(stream: ActiveStream): void {
    if (stream.state !== 'running') return
    stream.state = 'cancelled'
    this.#streams.delete(stream.ref.streamId)
    stream.emit(createHostEvent('model.chat.cancelled', { ...stream.ref, partialText: stream.text }))
  }

  #finishFailed(stream: ActiveStream, error: unknown, secret: string): void {
    if (stream.state !== 'running') return
    stream.state = 'failed'
    this.#streams.delete(stream.ref.streamId)
    const known = error instanceof ModelServiceError ? error : undefined
    stream.emit(createHostEvent('model.chat.failed', {
      ...stream.ref,
      partialText: stream.text,
      error: {
        code: known?.code ?? 'MODEL_REQUEST_FAILED',
        message: sanitizeProviderText(known?.message ?? '模型请求失败。', secret),
        retryable: known?.retryable ?? true,
      },
    }))
  }

  async #persist(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 })
    await chmod(this.#dataDir, 0o700)
    await writePrivateJson(this.#settingsPath, {
      v: 1,
      baseUrl: this.#settings.baseUrl,
      model: this.#settings.model,
      providerMode: this.#settings.providerMode,
    })
    if (this.#apiKey) {
      await writePrivateJson(this.#credentialPath, { v: 1, apiKey: this.#apiKey })
    }
    else {
      await rm(this.#credentialPath, { force: true })
    }
  }
}

export function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  }
  catch {
    throw new ModelServiceError('INVALID_PAYLOAD', 'Base URL 必须是 http 或 https 地址。', false)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ModelServiceError('INVALID_PAYLOAD', 'Base URL 必须是 http 或 https 地址。', false)
  }
  if (url.username || url.password) {
    throw new ModelServiceError('INVALID_PAYLOAD', 'Base URL 不能包含用户名或密码。', false)
  }
  if (url.search || url.hash) {
    throw new ModelServiceError('INVALID_PAYLOAD', 'Base URL 不能包含查询参数或片段。', false)
  }
  return url.toString().replace(/\/+$/, '')
}

function normalizeModelName(value: string): string {
  const model = value.trim()
  if (!model || model.length > 256) throw new ModelServiceError('INVALID_PAYLOAD', '模型名称无效。', false)
  return model
}

function redactSecret(text: string, secret: string): string {
  const token = secret.trim()
  const withoutToken = token.length < 4 ? text : text.split(token).join('[redacted]')
  return withoutToken
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

function publishSummary(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '作者工具没有完成。源码没有执行。'
  return trimmed.length > 240 ? `${trimmed.slice(0, 239)}…` : trimmed
}

function publishDraft(draft: AuthorToolNotice['draft'], secret: string): AuthorToolNotice['draft'] {
  if (!draft) return null
  const id = redactSecret(draft.id, secret).trim().slice(0, 128)
  const displayName = redactSecret(draft.displayName, secret).trim().slice(0, 80)
  if (!id || !displayName || !Number.isSafeInteger(draft.revision) || draft.revision < 0) return null
  return { id, displayName, revision: draft.revision, ok: draft.ok }
}

function providerMessages(messages: readonly ModelChatMessage[]): ProviderMessage[] {
  if (messages.some(message => message.role === 'system')) return [...messages]
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
}

function parseStoredSettings(value: unknown): StoredSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.baseUrl !== 'string' || typeof record.model !== 'string') return undefined
  if (record.providerMode !== 'mock' && record.providerMode !== 'openai-compatible') return undefined
  try {
    return {
      baseUrl: normalizeBaseUrl(record.baseUrl),
      model: normalizeModelName(record.model),
      providerMode: record.providerMode,
    }
  }
  catch {
    return undefined
  }
}

function parseStoredKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const apiKey = (value as { apiKey?: unknown }).apiKey
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0 || apiKey.length > 4096) return null
  return apiKey
}

async function readPrivateJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  }
  catch {
    return undefined
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
  await chmod(file, 0o600)
}
