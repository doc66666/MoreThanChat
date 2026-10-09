import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
import { PLUGIN_AUTHOR_CONTRACT } from './author-contract'
import { MemoryModelCredentials, type ModelCredentials } from './credential-client'
import { ModelServiceError, sanitizeProviderText } from './model-error'
import {
  createMockProvider,
  createOpenAiCompatibleProvider,
  type ChatModelProvider,
  type ProviderChatRequest,
  type ProviderMessage,
} from './openai-compatible'

export const DEFAULT_MODEL_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL_NAME = 'deepseek-flash'
const MAX_REPLY_CHARS = 500_000
const MAX_DELTA_CHARS = 100_000
const SYSTEM_PROMPT = '你是 MoreThanChat 的桌面助手。用户要求插件时实际调用作者工具创建和校验，不要仅描述方案。不要索取或复述 API key。安装由用户确认。不要在聊天正文输出源码。插件契约：' + JSON.stringify(PLUGIN_AUTHOR_CONTRACT)
const MAX_TOOL_ROUNDS = 6
const MAX_TOOL_CALLS = 4

export interface ModelServiceOptions {
  dataDir: string
  generation: number
  fetchImpl?: typeof fetch
  providers?: Partial<Record<ModelProviderMode, ChatModelProvider>>
  authorTools?: AuthorToolExecutor
  credentials?: ModelCredentials
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
  settings: StoredSettings
}

/**
 * Runs model calls inside the PC Host. Main owns encrypted credential storage;
 * Host keeps only a runtime copy, never settings/events/plugin services.
 */
export class ModelService {
  readonly #dataDir: string
  readonly #generation: number
  readonly #settingsPath: string
  readonly #credentials: ModelCredentials
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
  #settingsTail: Promise<unknown> = Promise.resolve()

  constructor(options: ModelServiceOptions) {
    this.#dataDir = options.dataDir
    this.#generation = options.generation
    this.#settingsPath = path.join(options.dataDir, 'model-settings.json')
    this.#credentials = options.credentials ?? new MemoryModelCredentials()
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
    this.#apiKey = await this.#credentials.read().catch(() => null)
  }

  getSettings(): ModelSettingsSnapshot {
    return {
      baseUrl: this.#settings.baseUrl,
      model: this.#settings.model,
      providerMode: this.#settings.providerMode,
      hasApiKey: this.#apiKey !== null,
    }
  }

  setSettings(input: HostRequestPayloadMap['model.setSettings']): Promise<ModelSettingsSnapshot> {
    const next = this.#settingsTail.catch(() => undefined).then(() => this.#setSettings(input))
    this.#settingsTail = next
    return next
  }

  async #setSettings(input: HostRequestPayloadMap['model.setSettings']): Promise<ModelSettingsSnapshot> {
    if (this.#closed) throw new ModelServiceError('MODEL_NOT_CONFIGURED', '模型服务正在关闭。', true)
    const next: StoredSettings = { ...this.#settings }
    if (input.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(input.baseUrl)
    if (input.model !== undefined) next.model = normalizeModelName(input.model)
    if (input.providerMode !== undefined) next.providerMode = input.providerMode
    const key = input.clearApiKey ? null : input.apiKey ?? this.#apiKey
    const changedKey = input.clearApiKey === true || input.apiKey !== undefined
    let credentialCommitted = false
    try {
      if (changedKey) { await this.#credentials.write(key); credentialCommitted = true }
      await this.#persist(next)
    } catch {
      if (credentialCommitted) await this.#credentials.write(this.#apiKey).catch(() => undefined)
      throw new ModelServiceError('CREDENTIAL_UNAVAILABLE', '模型配置未保存，请检查本机加密存储。', true)
    }
    this.#settings = next
    this.#apiKey = key
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
      settings: { ...this.#settings },
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
      const provider = this.#providers[stream.settings.providerMode]
      if (!provider) throw new ModelServiceError('MODEL_NOT_CONFIGURED', '模型提供方不可用。', false)
      const transcript: ProviderMessage[] = providerMessages(stream.messages)
      let unresolvedTools = false
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (stream.cancelRequested || stream.controller.signal.aborted) {
          this.#finishCancelled(stream)
          return
        }
        const request: ProviderChatRequest = {
          baseUrl: stream.settings.baseUrl,
          model: stream.settings.model,
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
      toolCalls: calls.map(call => ({ id: call.id, name: call.name, arguments: redactSecret(call.arguments, secret) })),
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

  async #persist(settings: StoredSettings): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 })
    await chmod(this.#dataDir, 0o700)
    await writePrivateJson(this.#settingsPath, {
      v: 1,
      baseUrl: settings.baseUrl,
      model: settings.model,
      providerMode: settings.providerMode,
    })
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
