import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHostEvent,
  createHostRequest,
  createHostSuccessResponse,
  type HostMethod,
  type HostRequest,
  type HostRequestEnvelope,
} from '@more-than-chat/protocol'
import {
  HostSupervisor,
  type HostProcess,
} from '../src/main/host-supervisor.js'

class FakeHostProcess implements HostProcess {
  readonly sent: unknown[] = []
  readonly #spawnListeners = new Set<() => void>()
  readonly #messageListeners = new Set<(message: unknown) => void>()
  readonly #exitListeners = new Set<(code: number) => void>()
  readonly #fatalListeners = new Set<(message: string) => void>()
  terminateCalls = 0
  pid: number | undefined

  constructor(readonly generation: number) {
    this.pid = 10_000 + generation
  }

  send(message: unknown): void {
    this.sent.push(message)
  }

  terminate(): boolean {
    this.terminateCalls += 1
    return true
  }

  onSpawn(listener: () => void): () => void {
    this.#spawnListeners.add(listener)
    return () => this.#spawnListeners.delete(listener)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener)
    return () => this.#messageListeners.delete(listener)
  }

  onExit(listener: (code: number) => void): () => void {
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }

  onFatal(listener: (message: string) => void): () => void {
    this.#fatalListeners.add(listener)
    return () => this.#fatalListeners.delete(listener)
  }

  emitSpawn(): void {
    for (const listener of this.#spawnListeners) listener()
  }

  emitMessage(message: unknown): void {
    for (const listener of this.#messageListeners) listener(message)
  }

  emitExit(code: number): void {
    this.pid = undefined
    for (const listener of this.#exitListeners) listener(code)
  }

  emitFatal(message: string): void {
    for (const listener of this.#fatalListeners) listener(message)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HostSupervisor', () => {
  it('brokers private credential replies without broadcasting them to UI events', async () => {
    const processes: FakeHostProcess[] = []
    const write = vi.fn(async (_key: string | null) => undefined)
    const supervisor = createSupervisor(processes, { credentials: { read: async () => 'private-test-value', write } })
    const events: unknown[] = []
    supervisor.subscribeEvents(event => events.push(event))
    const started = supervisor.start(); const host = processes[0]!
    host.emitSpawn(); respondToHandshake(host); await started
    host.emitMessage(createHostRequest('credentials.read', 'private-read', {}))
    await vi.waitFor(() => expect(host.sent).toContainEqual(expect.objectContaining({ requestId: 'private-read', payload: { apiKey: 'private-test-value' } })))
    host.emitMessage(createHostRequest('credentials.write', 'private-write', { apiKey: null }))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(null))
    expect(events).toEqual([])
    const stopped = supervisor.stop(); host.emitExit(0); await stopped
  })

  it('terminates a Host that sends a parent request outside the credential whitelist', async () => {
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes)
    const started = supervisor.start(); const host = processes[0]!
    host.emitSpawn(); respondToHandshake(host); await started
    host.emitMessage(createHostRequest('diagnostics.ping', 'illegal-parent-call', { sentAtMs: 1 }))
    expect(host.terminateCalls).toBe(1)
    const stopped = supervisor.stop(); host.emitExit(1); await stopped
  })
  it('rejects restart during shutdown, shares concurrent stops, and can start afterwards', async () => {
    vi.useFakeTimers()
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes)
    const started = supervisor.start()
    processes[0]!.emitSpawn()
    respondToHandshake(processes[0]!)
    await started
    const stopped = supervisor.stop()
    expect(supervisor.stop()).toBe(stopped)
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'SHUTTING_DOWN' })
    await vi.advanceTimersByTimeAsync(100)
    await stopped
    const restarted = supervisor.start()
    expect(processes).toHaveLength(2)
    processes[0]!.emitExit(0)
    processes[1]!.emitSpawn()
    respondToHandshake(processes[1]!)
    await restarted
    expect(supervisor.getStatus()).toEqual({ state: 'ready', generation: 2 })
    const finished = supervisor.stop()
    processes[1]!.emitExit(0)
    await finished
  })

  it('handshakes, correlates ping, and shuts down cleanly', async () => {
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes)
    const started = supervisor.start()
    const host = processes[0]!
    host.emitSpawn()
    respondToHandshake(host)
    await started

    expect(supervisor.getStatus()).toEqual({ state: 'ready', generation: 1 })
    const ping = supervisor.ping()
    const pingRequest = findRequest(host, 'diagnostics.ping')
    host.emitMessage(createHostSuccessResponse(pingRequest, {
      sentAtMs: pingRequest.payload.sentAtMs,
      receivedAtMs: pingRequest.payload.sentAtMs + 1,
    }))
    await expect(ping).resolves.toMatchObject({ generation: 1, hostReceivedAtMs: pingRequest.payload.sentAtMs + 1 })

    const stopped = supervisor.stop()
    const shutdownRequest = findRequest(host, 'host.shutdown')
    host.emitMessage(createHostSuccessResponse(shutdownRequest, { accepted: true }))
    await Promise.resolve()
    host.emitExit(0)
    await stopped
    expect(host.terminateCalls).toBe(0)
    expect(supervisor.getStatus()).toEqual({ state: 'stopped', generation: 1 })
  })

  it('force-terminates a host that acknowledges shutdown but never exits', async () => {
    vi.useFakeTimers()
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes, { shutdownTimeoutMs: 50 })
    const started = supervisor.start()
    const host = processes[0]!
    host.emitSpawn()
    respondToHandshake(host)
    await started

    const stopped = supervisor.stop()
    const shutdownRequest = findRequest(host, 'host.shutdown')
    host.emitMessage(createHostSuccessResponse(shutdownRequest, { accepted: true }))
    await vi.advanceTimersByTimeAsync(50)
    expect(host.terminateCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    await stopped

    expect(supervisor.getStatus()).toEqual({ state: 'stopped', generation: 1 })
    host.emitExit(0)
    await vi.runAllTimersAsync()
    expect(processes).toHaveLength(1)
  })

  it('restarts with a new generation after a crash', async () => {
    vi.useFakeTimers()
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes, { restartDelaysMs: [25] })
    const started = supervisor.start()
    processes[0]!.emitSpawn()
    respondToHandshake(processes[0]!)
    await started

    processes[0]!.emitExit(86)
    expect(supervisor.getStatus()).toMatchObject({ state: 'restarting', generation: 1 })
    await vi.advanceTimersByTimeAsync(25)
    expect(processes).toHaveLength(2)
    processes[1]!.emitSpawn()
    respondToHandshake(processes[1]!)
    await Promise.resolve()
    expect(supervisor.getStatus()).toEqual({ state: 'ready', generation: 2 })

    const stopped = supervisor.stop()
    const shutdownRequest = findRequest(processes[1]!, 'host.shutdown')
    processes[1]!.emitMessage(createHostSuccessResponse(shutdownRequest, { accepted: true }))
    await Promise.resolve()
    processes[1]!.emitExit(0)
    await stopped
  })

  it('times out a request without poisoning the next request', async () => {
    vi.useFakeTimers()
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes, { requestTimeoutMs: 40 })
    const started = supervisor.start()
    const host = processes[0]!
    host.emitSpawn()
    respondToHandshake(host)
    await started

    const firstPing = supervisor.ping()
    const firstPingExpectation = expect(firstPing).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(40)
    await firstPingExpectation

    const secondPing = supervisor.ping()
    const requests = host.sent.filter(isRequest).filter(request => request.method === 'diagnostics.ping')
    const secondRequest = requests.at(-1) as HostRequestEnvelope<'diagnostics.ping'>
    host.emitMessage(createHostSuccessResponse(secondRequest, {
      sentAtMs: secondRequest.payload.sentAtMs,
      receivedAtMs: secondRequest.payload.sentAtMs,
    }))
    await expect(secondPing).resolves.toMatchObject({ generation: 1 })

    const stopped = supervisor.stop()
    const shutdownRequest = findRequest(host, 'host.shutdown')
    host.emitMessage(createHostSuccessResponse(shutdownRequest, { accepted: true }))
    await Promise.resolve()
    host.emitExit(0)
    await stopped
  })

  it('cancels a queued restart when stopping', async () => {
    vi.useFakeTimers()
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes, { restartDelaysMs: [100] })
    const started = supervisor.start()
    processes[0]!.emitSpawn()
    respondToHandshake(processes[0]!)
    await started

    processes[0]!.emitExit(9)
    await supervisor.stop()
    await vi.advanceTimersByTimeAsync(200)
    expect(processes).toHaveLength(1)
    expect(supervisor.getStatus()).toEqual({ state: 'stopped', generation: 1 })
  })

  it('terminates a host that sends a malformed envelope', async () => {
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes)
    const started = supervisor.start()
    const host = processes[0]!
    host.emitSpawn()
    respondToHandshake(host)
    await started

    host.emitMessage({ kind: 'response', protocolVersion: 99 })
    expect(host.terminateCalls).toBe(1)
    expect(supervisor.getStatus().state).toBe('restarting')
    host.emitExit(1)
    await supervisor.stop()
  })

  it('terminates a host that returns a response for the wrong method', async () => {
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes)
    const started = supervisor.start()
    const host = processes[0]!
    host.emitSpawn()
    respondToHandshake(host)
    await started

    const ping = supervisor.ping()
    const rejected = expect(ping).rejects.toMatchObject({ code: 'RESPONSE_MISMATCH' })
    const pingRequest = findRequest(host, 'diagnostics.ping')
    host.emitMessage({
      protocolVersion: 1,
      kind: 'response',
      requestId: pingRequest.requestId,
      method: 'host.shutdown',
      ok: true,
      payload: { accepted: true },
    })

    await rejected
    expect(host.terminateCalls).toBe(1)
    expect(supervisor.getStatus().state).toBe('restarting')
    host.emitExit(1)
    await supervisor.stop()
  })

  it('stops retrying after the configured start-failure budget', async () => {
    vi.useFakeTimers()
    let spawnCalls = 0
    const supervisor = new HostSupervisor({
      clientVersion: '0.1.0-test',
      createProcess: () => {
        spawnCalls += 1
        throw new Error('fork failed')
      },
      restartDelaysMs: [20],
    })
    const started = supervisor.start()
    const failed = expect(started).rejects.toMatchObject({ code: 'HOST_START_FAILED' })

    await vi.advanceTimersByTimeAsync(20)
    await failed
    expect(spawnCalls).toBe(2)
    expect(supervisor.getStatus()).toMatchObject({ state: 'failed', generation: 2 })
    await supervisor.stop()
  })

  it('forwards current model events and stops the host when an event generation mismatches', async () => {
    const processes: FakeHostProcess[] = []
    const supervisor = createSupervisor(processes)
    const events: unknown[] = []
    supervisor.subscribeEvents(event => { events.push(event) })
    const started = supervisor.start()
    processes[0]!.emitSpawn()
    respondToHandshake(processes[0]!)
    await started
    processes[0]!.emitMessage(createHostEvent('host.statusChanged', { state: 'ready', generation: 1 }))
    const delta = createHostEvent('model.chat.delta', {
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      generation: 1,
      textDelta: 'hi',
    })
    processes[0]!.emitMessage(delta)
    expect(events).toEqual([delta])
    processes[0]!.emitMessage(createHostEvent('model.chat.cancelled', {
      streamId: 'stream-1',
      conversationId: 'conversation-assistant',
      assistantMessageId: 'assistant-1',
      generation: 9,
      partialText: 'hi',
    }))
    expect(processes[0]!.terminateCalls).toBe(1)
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('sk-')
    processes[0]!.emitExit(1)
    await supervisor.stop()
  })
})

function createSupervisor(
  processes: FakeHostProcess[],
  overrides: Partial<ConstructorParameters<typeof HostSupervisor>[0]> = {},
): HostSupervisor {
  return new HostSupervisor({
    clientVersion: '0.1.0-test',
    createProcess: generation => {
      const process = new FakeHostProcess(generation)
      processes.push(process)
      return process
    },
    handshakeTimeoutMs: 100,
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 50,
    stableResetMs: 1_000,
    restartDelaysMs: [10, 20],
    ...overrides,
  })
}

function respondToHandshake(host: FakeHostProcess): void {
  const request = findRequest(host, 'host.handshake')
  host.emitMessage(createHostSuccessResponse(request, {
    selectedProtocolVersion: 1,
    hostName: 'Fake PC Host',
    hostVersion: '0.1.0-test',
    status: { state: 'ready', generation: host.generation },
  }))
}

function findRequest<M extends HostMethod>(host: FakeHostProcess, method: M): HostRequestEnvelope<M> {
  const request = host.sent.filter(isRequest).findLast(item => item.method === method)
  if (!request) throw new Error(`Missing request ${method}`)
  return request as HostRequestEnvelope<M>
}

function isRequest(value: unknown): value is HostRequest {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'request')
}
