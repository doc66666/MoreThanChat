import { randomUUID } from 'node:crypto'
import {
  HOST_PROTOCOL_VERSION,
  assertResponseForRequest,
  createHostRequest,
  safeParseHostMessage,
  type HostMethod,
  type HostPluginCatalog,
  type HostEventMessage,
  type HostRequestEnvelope,
  type HostRequestPayloadMap,
  type HostResponsePayloadMap,
  type HostStatusSnapshot,
  type ProtocolErrorCode,
  type ProtocolErrorPayload,
} from '@more-than-chat/protocol'

export interface HostProcess {
  readonly pid: number | undefined
  send(message: unknown): void
  terminate(): boolean
  onSpawn(listener: () => void): () => void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (code: number) => void): () => void
  onFatal(listener: (message: string) => void): () => void
}

export type HostProcessFactory = (generation: number) => HostProcess

export interface HostSupervisorOptions {
  readonly createProcess: HostProcessFactory
  readonly clientVersion: string
  readonly handshakeTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly restartDelaysMs?: readonly number[]
  readonly stableResetMs?: number
}

export interface HostPingResult {
  readonly generation: number
  readonly roundTripMs: number
  readonly sentAtMs: number
  readonly hostReceivedAtMs: number
}

interface ProcessBinding {
  readonly generation: number
  readonly process: HostProcess
  readonly unsubscribe: Array<() => void>
  terminating: boolean
  terminationTimer: ReturnType<typeof setTimeout> | undefined
}

interface PendingRequest {
  readonly generation: number
  readonly request: HostRequestEnvelope<HostMethod>
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (payload: unknown) => void
  readonly reject: (error: Error) => void
}

interface ReadyWaiter {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

const defaultRestartDelays = [100, 300, 1_000, 2_000] as const

export class HostSupervisorError extends Error {
  readonly code: ProtocolErrorCode
  readonly retryable: boolean

  constructor(payload: ProtocolErrorPayload) {
    super(payload.message)
    this.name = 'HostSupervisorError'
    this.code = payload.code
    this.retryable = payload.retryable
  }
}

/** Supervises exactly one generation of the isolated PC Host at a time. */
export class HostSupervisor {
  readonly #createProcess: HostProcessFactory
  readonly #clientVersion: string
  readonly #handshakeTimeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #shutdownTimeoutMs: number
  readonly #restartDelaysMs: readonly number[]
  readonly #stableResetMs: number
  readonly #listeners = new Set<(status: HostStatusSnapshot) => void>()
  readonly #eventListeners = new Set<(event: HostEventMessage) => void>()
  readonly #pending = new Map<string, PendingRequest>()
  readonly #exitWaiters = new Map<number, Set<() => void>>()
  readonly #pluginPreferences = new Map<string, boolean>()

  #status: HostStatusSnapshot = { state: 'stopped', generation: 0 }
  #binding: ProcessBinding | undefined
  #readyWaiter: ReadyWaiter | undefined
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #stableTimer: ReturnType<typeof setTimeout> | undefined
  #restartAttempts = 0
  #generation = 0
  #desiredRunning = false
  #stopPromise: Promise<void> | undefined

  constructor(options: HostSupervisorOptions) {
    this.#createProcess = options.createProcess
    this.#clientVersion = options.clientVersion
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3_000
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 3_000
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 800
    this.#restartDelaysMs = options.restartDelaysMs ?? defaultRestartDelays
    this.#stableResetMs = options.stableResetMs ?? 10_000
  }

  getStatus(): HostStatusSnapshot {
    return cloneStatus(this.#status)
  }

  subscribe(listener: (status: HostStatusSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  subscribeEvents(listener: (event: HostEventMessage) => void): () => void {
    this.#eventListeners.add(listener)
    return () => {
      this.#eventListeners.delete(listener)
    }
  }

  start(): Promise<void> {
    if (this.#stopPromise) return Promise.reject(new HostSupervisorError({
      code: 'SHUTTING_DOWN', message: 'Wait for PC Host shutdown before starting again.', retryable: true,
    }))
    if (this.#status.state === 'ready' && this.#desiredRunning) return Promise.resolve()
    if (this.#readyWaiter) return this.#readyWaiter.promise

    if (this.#status.state === 'failed' || this.#status.state === 'stopped') {
      this.#restartAttempts = 0
    }
    this.#desiredRunning = true
    this.#readyWaiter = createReadyWaiter()
    const ready = this.#readyWaiter.promise
    if (!this.#binding && !this.#restartTimer) this.#spawn(false)
    return ready
  }

  async ping(): Promise<HostPingResult> {
    if (this.#status.state !== 'ready' || !this.#binding) {
      throw new HostSupervisorError({
        code: 'HOST_UNAVAILABLE',
        message: 'PC Host is not ready.',
        retryable: true,
      })
    }
    const generation = this.#binding.generation
    const sentAtMs = Date.now()
    const response = await this.#request('diagnostics.ping', { sentAtMs })
    return {
      generation,
      sentAtMs: response.sentAtMs,
      hostReceivedAtMs: response.receivedAtMs,
      roundTripMs: Math.max(0, Date.now() - sentAtMs),
    }
  }

  getPlugins(): Promise<HostPluginCatalog> {
    return this.#request('plugins.list', {})
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<HostPluginCatalog> {
    const result = await this.#request('plugins.setEnabled', { pluginId, enabled })
    this.#pluginPreferences.set(pluginId, enabled)
    return result
  }

  invokeTool(pluginId: string, toolId: string): Promise<HostResponsePayloadMap['tools.invoke']> {
    return this.#request('tools.invoke', { pluginId, toolId })
  }

  getModelSettings(): Promise<HostResponsePayloadMap['model.getSettings']> {
    return this.#request('model.getSettings', {})
  }

  setModelSettings(payload: HostRequestPayloadMap['model.setSettings']): Promise<HostResponsePayloadMap['model.setSettings']> {
    return this.#request('model.setSettings', payload)
  }

  startModelChat(payload: HostRequestPayloadMap['model.chat.start']): Promise<HostResponsePayloadMap['model.chat.start']> {
    return this.#request('model.chat.start', payload)
  }

  cancelModelChat(streamId: string): Promise<HostResponsePayloadMap['model.chat.cancel']> {
    return this.#request('model.chat.cancel', { streamId })
  }

  inspectPluginDrafts(): Promise<HostResponsePayloadMap['pluginDrafts.inspect']> {
    return this.#request('pluginDrafts.inspect', {})
  }

  createPluginDraft(payload: HostRequestPayloadMap['pluginDrafts.create']): Promise<HostResponsePayloadMap['pluginDrafts.create']> {
    return this.#request('pluginDrafts.create', payload)
  }

  validatePluginDraft(draftId: string): Promise<HostResponsePayloadMap['pluginDrafts.validate']> {
    return this.#request('pluginDrafts.validate', { draftId })
  }

  diagnosePluginDraft(draftId: string): Promise<HostResponsePayloadMap['pluginDrafts.diagnose']> {
    return this.#request('pluginDrafts.diagnose', { draftId })
  }

  installPluginDraft(payload: HostRequestPayloadMap['pluginDrafts.install']): Promise<HostResponsePayloadMap['pluginDrafts.install']> {
    return this.#request('pluginDrafts.install', payload)
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    const stopped = createReadyWaiter()
    this.#stopPromise = stopped.promise
    void this.#stop().then(() => {
      this.#stopPromise = undefined
      stopped.resolve()
    }, error => {
      this.#stopPromise = undefined
      stopped.reject(error instanceof Error ? error : new Error(String(error)))
    })
    return stopped.promise
  }

  async #stop(): Promise<void> {
    this.#desiredRunning = false
    this.#clearRestartTimer()
    this.#clearStableTimer()
    const stoppedError = new HostSupervisorError({
      code: 'SHUTTING_DOWN',
      message: 'PC Host supervisor is stopping.',
      retryable: false,
    })
    this.#readyWaiter?.reject(stoppedError)
    this.#readyWaiter = undefined

    const binding = this.#binding
    if (!binding) {
      this.#setStatus({ state: 'stopped', generation: this.#generation })
      return
    }

    const exitPromise = this.#waitForExit(binding.generation, this.#shutdownTimeoutMs)
    try {
      await this.#request('host.shutdown', { reason: 'Application shutdown' }, this.#shutdownTimeoutMs, true)
    }
    catch {
      // A non-responsive host is terminated below.
    }
    const exitedGracefully = await exitPromise
    if (!exitedGracefully && this.#binding?.generation === binding.generation) {
      binding.terminating = true
      binding.process.terminate()
      await this.#waitForExit(binding.generation, this.#shutdownTimeoutMs)
    }
    if (this.#binding?.generation === binding.generation) {
      this.#detachBinding(binding)
      this.#rejectPendingGeneration(binding.generation, stoppedError)
    }
    this.#setStatus({ state: 'stopped', generation: this.#generation })
  }

  #spawn(restarting: boolean): void {
    if (!this.#desiredRunning) return
    this.#generation += 1
    const generation = this.#generation
    this.#setStatus({ state: restarting ? 'restarting' : 'starting', generation })

    let process: HostProcess
    try {
      process = this.#createProcess(generation)
    }
    catch (error) {
      this.#scheduleRestart(toProtocolError(error, 'HOST_START_FAILED'))
      return
    }

    const binding: ProcessBinding = {
      generation,
      process,
      unsubscribe: [],
      terminating: false,
      terminationTimer: undefined,
    }
    binding.unsubscribe.push(
      process.onSpawn(() => this.#onSpawn(binding)),
      process.onMessage(message => this.#onMessage(binding, message)),
      process.onExit(code => this.#onExit(binding, code)),
      process.onFatal(message => this.#onFatal(binding, message)),
    )
    this.#binding = binding
  }

  #onSpawn(binding: ProcessBinding): void {
    if (!this.#isCurrent(binding) || !this.#desiredRunning) return
    void this.#request('host.handshake', {
      clientName: 'MoreThanChat Desktop',
      clientVersion: this.#clientVersion,
      supportedProtocolVersions: [HOST_PROTOCOL_VERSION],
    }, this.#handshakeTimeoutMs, true).then(async response => {
      if (!this.#isCurrent(binding) || !this.#desiredRunning) return
      if (response.status.generation !== binding.generation) {
        throw new HostSupervisorError({
          code: 'RESPONSE_MISMATCH',
          message: `PC Host reported generation ${response.status.generation}; expected ${binding.generation}.`,
          retryable: true,
        })
      }
      if (response.status.state !== 'ready') {
        throw new HostSupervisorError({
          code: 'RESPONSE_MISMATCH',
          message: `PC Host handshake reported '${response.status.state}' instead of 'ready'.`,
          retryable: true,
        })
      }
      for (const [pluginId, enabled] of this.#pluginPreferences) {
        await this.#request('plugins.setEnabled', { pluginId, enabled }, this.#requestTimeoutMs, true)
        if (!this.#isCurrent(binding) || !this.#desiredRunning) return
      }
      this.#setStatus({ state: 'ready', generation: binding.generation })
      this.#readyWaiter?.resolve()
      this.#readyWaiter = undefined
      this.#clearStableTimer()
      this.#stableTimer = setTimeout(() => {
        if (this.#isCurrent(binding) && this.#status.state === 'ready') this.#restartAttempts = 0
      }, this.#stableResetMs)
    }).catch(error => {
      if (this.#isCurrent(binding)) this.#terminateFailedBinding(binding, toProtocolError(error, 'HOST_START_FAILED'))
    })
  }

  #onMessage(binding: ProcessBinding, raw: unknown): void {
    if (!this.#isCurrent(binding)) return
    const parsed = safeParseHostMessage(raw)
    if (!parsed.success) {
      this.#terminateFailedBinding(binding, parsed.error.toPayload())
      return
    }
    if (parsed.data.kind === 'event') {
      this.#onEvent(binding, parsed.data)
      return
    }
    if (parsed.data.kind !== 'response') return
    const pending = this.#pending.get(parsed.data.requestId)
    if (!pending || pending.generation !== binding.generation) return

    try {
      assertResponseForRequest(pending.request, parsed.data)
    }
    catch (error) {
      const mismatch: ProtocolErrorPayload = {
        code: 'RESPONSE_MISMATCH',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      }
      this.#settlePending(pending, undefined, new HostSupervisorError(mismatch))
      this.#terminateFailedBinding(binding, mismatch)
      return
    }
    if (!parsed.data.ok) {
      this.#settlePending(pending, undefined, new HostSupervisorError(parsed.data.error))
      return
    }
    this.#settlePending(pending, parsed.data.payload)
  }

  #onEvent(binding: ProcessBinding, event: HostEventMessage): void {
    if (event.event === 'host.statusChanged') return
    if (event.payload.generation !== binding.generation) {
      this.#terminateFailedBinding(binding, {
        code: 'RESPONSE_MISMATCH',
        message: 'PC Host event generation did not match the supervised process.',
        retryable: true,
      })
      return
    }
    for (const listener of this.#eventListeners) {
      try {
        listener(event)
      }
      catch {
        // A desktop listener must not take down the supervised host.
      }
    }
  }

  #onFatal(binding: ProcessBinding, message: string): void {
    if (!this.#isCurrent(binding) || !this.#desiredRunning) return
    this.#setStatus(withError('restarting', binding.generation, {
      code: 'HOST_CRASHED',
      message,
      retryable: true,
    }))
  }

  #onExit(binding: ProcessBinding, code: number): void {
    this.#resolveExitWaiters(binding.generation)
    if (!this.#isCurrent(binding)) return
    this.#detachBinding(binding)
    this.#rejectPendingGeneration(binding.generation, new HostSupervisorError({
      code: this.#desiredRunning ? 'HOST_CRASHED' : 'SHUTTING_DOWN',
      message: `PC Host generation ${binding.generation} exited with code ${code}.`,
      retryable: this.#desiredRunning,
    }))
    if (!this.#desiredRunning) {
      this.#setStatus({ state: 'stopped', generation: binding.generation })
      return
    }
    this.#scheduleRestart({
      code: 'HOST_CRASHED',
      message: `PC Host generation ${binding.generation} exited unexpectedly (code ${code}).`,
      retryable: true,
    })
  }

  #terminateFailedBinding(binding: ProcessBinding, error: ProtocolErrorPayload): void {
    if (!this.#isCurrent(binding) || binding.terminating) return
    binding.terminating = true
    if (this.#desiredRunning) this.#setStatus(withError('restarting', binding.generation, error))
    if (!binding.process.terminate()) {
      this.#detachBinding(binding)
      this.#rejectPendingGeneration(binding.generation, new HostSupervisorError(error))
      this.#scheduleRestart(error)
      return
    }
    binding.terminationTimer = setTimeout(() => {
      if (!this.#isCurrent(binding)) return
      this.#detachBinding(binding)
      this.#rejectPendingGeneration(binding.generation, new HostSupervisorError(error))
      this.#scheduleRestart(error)
    }, this.#shutdownTimeoutMs)
  }

  #scheduleRestart(error: ProtocolErrorPayload): void {
    if (!this.#desiredRunning || this.#restartTimer) return
    this.#clearStableTimer()
    if (this.#restartAttempts >= this.#restartDelaysMs.length) {
      this.#setStatus(withError('failed', this.#generation, error))
      this.#readyWaiter?.reject(new HostSupervisorError(error))
      this.#readyWaiter = undefined
      return
    }
    const delayMs = this.#restartDelaysMs[this.#restartAttempts] ?? 0
    this.#restartAttempts += 1
    this.#setStatus(withError('restarting', this.#generation, error))
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      this.#spawn(true)
    }, delayMs)
  }

  #request<M extends HostMethod>(
    method: M,
    payload: HostRequestPayloadMap[M],
    timeoutMs = this.#requestTimeoutMs,
    allowBeforeReady = false,
  ): Promise<HostResponsePayloadMap[M]> {
    const binding = this.#binding
    if (!binding || (!allowBeforeReady && (!this.#desiredRunning || this.#status.state !== 'ready'))) {
      return Promise.reject(new HostSupervisorError({
        code: 'HOST_UNAVAILABLE',
        message: 'PC Host is unavailable.',
        retryable: true,
      }))
    }
    const request = createHostRequest(method, randomUUID(), payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(request.requestId)
        if (!pending) return
        this.#pending.delete(request.requestId)
        reject(new HostSupervisorError({
          code: 'REQUEST_TIMEOUT',
          message: `${method} timed out after ${timeoutMs} ms.`,
          retryable: true,
        }))
      }, timeoutMs)
      const pending: PendingRequest = {
        generation: binding.generation,
        request: request as HostRequestEnvelope<HostMethod>,
        timer,
        resolve: value => resolve(value as HostResponsePayloadMap[M]),
        reject,
      }
      this.#pending.set(request.requestId, pending)
      try {
        binding.process.send(request)
      }
      catch (error) {
        this.#settlePending(pending, undefined, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #settlePending(pending: PendingRequest, payload?: unknown, error?: Error): void {
    if (!this.#pending.delete(pending.request.requestId)) return
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(payload)
  }

  #rejectPendingGeneration(generation: number, error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.generation === generation) this.#settlePending(pending, undefined, error)
    }
  }

  #detachBinding(binding: ProcessBinding): void {
    if (binding.terminationTimer) clearTimeout(binding.terminationTimer)
    binding.terminationTimer = undefined
    for (const unsubscribe of binding.unsubscribe) unsubscribe()
    binding.unsubscribe.length = 0
    if (this.#binding === binding) this.#binding = undefined
  }

  #isCurrent(binding: ProcessBinding): boolean {
    return this.#binding === binding && binding.generation === this.#generation
  }

  #waitForExit(generation: number, timeoutMs: number): Promise<boolean> {
    if (!this.#binding || this.#binding.generation !== generation) return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (exited: boolean): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const activeWaiters = this.#exitWaiters.get(generation)
        activeWaiters?.delete(onExit)
        if (activeWaiters?.size === 0) this.#exitWaiters.delete(generation)
        resolve(exited)
      }
      const onExit = (): void => finish(true)
      const waiters = this.#exitWaiters.get(generation) ?? new Set<() => void>()
      waiters.add(onExit)
      this.#exitWaiters.set(generation, waiters)
      timer = setTimeout(() => finish(false), timeoutMs)
    })
  }

  #resolveExitWaiters(generation: number): void {
    const waiters = this.#exitWaiters.get(generation)
    if (!waiters) return
    this.#exitWaiters.delete(generation)
    for (const resolve of waiters) resolve()
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
  }

  #clearStableTimer(): void {
    if (this.#stableTimer) clearTimeout(this.#stableTimer)
    this.#stableTimer = undefined
  }

  #setStatus(status: HostStatusSnapshot): void {
    this.#status = cloneStatus(status)
    for (const listener of this.#listeners) {
      try {
        listener(this.getStatus())
      }
      catch {
        // A renderer listener cannot influence supervision.
      }
    }
  }
}

function createReadyWaiter(): ReadyWaiter {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function cloneStatus(status: HostStatusSnapshot): HostStatusSnapshot {
  return status.error
    ? { state: status.state, generation: status.generation, error: { ...status.error } }
    : { state: status.state, generation: status.generation }
}

function withError(state: HostStatusSnapshot['state'], generation: number, error: ProtocolErrorPayload): HostStatusSnapshot {
  return { state, generation, error }
}

function toProtocolError(error: unknown, code: ProtocolErrorCode): ProtocolErrorPayload {
  if (error instanceof HostSupervisorError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  }
}
