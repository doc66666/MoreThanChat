import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESPONSE_BUDGET, RESPONSE_LIMIT, responseBudget, writeResponse } from '../src/response-flow.mjs'

class Response extends EventEmitter {
  destroyed = false
  chunks = []
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return false }
  end() { this.emit('finish') }
  destroy() { this.destroyed = true; this.emit('close') }
}
afterEach(() => vi.useRealTimers())
describe('bounded response flow', () => {
  it('caps bytes and per-user responses without resetting counters on repeated cleanup', () => {
    const budget = responseBudget()
    const a = budget.acquire(RESPONSE_LIMIT, 'a'), b = budget.acquire(RESPONSE_LIMIT, 'b')
    expect(budget.snapshot()).toMatchObject({ bytes: RESPONSE_BUDGET, active: 2 })
    expect(budget.acquire(1, 'c')).toBeNull()
    a(); a(); b()
    const one = budget.acquire(1, 'a'), two = budget.acquire(1, 'a')
    expect(budget.acquire(1, 'a')).toBeNull()
    expect(budget.acquire(RESPONSE_LIMIT + 1, 'b')).toBeNull()
    for (const size of [-1, NaN, Infinity, 0.5]) expect(budget.acquire(size, 'b')).toBeNull()
    one(); two()
    expect(budget.snapshot()).toEqual({ bytes: 0, active: 0, peakBytes: RESPONSE_BUDGET, rejected: 7, timeouts: 0 })
  })
  it('waits for drain, preserves emoji boundaries, and releases only at finish', async () => {
    const response = new Response(), release = vi.fn()
    const payload = 'x'.repeat(16383) + '😀' + '中'.repeat(20000)
    const pending = writeResponse(response, payload, release)
    expect(response.chunks.length).toBe(1)
    expect(release).not.toHaveBeenCalled()
    for (let i = 0; i < 5; i++) response.emit('drain')
    expect(await pending).toBe(true)
    expect(Buffer.concat(response.chunks).toString()).toBe(payload)
    expect(response.chunks.every(chunk => chunk.length <= 65536)).toBe(true)
    response.emit('close')
    expect(release).toHaveBeenCalledTimes(1)
    for (const event of ['drain', 'finish', 'close', 'error']) expect(response.listenerCount(event)).toBe(0)
  })
  it('destroys a stalled response at its absolute deadline and clears listeners', async () => {
    vi.useFakeTimers()
    const response = new Response(), release = vi.fn(), onTimeout = vi.fn()
    const pending = writeResponse(response, 'x'.repeat(100000), release, { timeoutMs: 30000, onTimeout })
    await vi.advanceTimersByTimeAsync(29999)
    expect(response.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe(false)
    expect(response.destroyed).toBe(true)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases disconnected and failed writes without retrying a destroyed stream', async () => {
    const response = new Response(), release = vi.fn()
    const pending = writeResponse(response, 'x'.repeat(100000), release)
    response.destroy()
    response.emit('drain')
    expect(await pending).toBe(false)
    expect(response.chunks.length).toBe(1)
    expect(release).toHaveBeenCalledTimes(1)
    const broken = new Response(), second = vi.fn()
    broken.write = () => { throw new Error('injected') }
    expect(await writeResponse(broken, 'test', second)).toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
