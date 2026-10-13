import { describe, expect, it } from 'vitest'
import { TRAFFIC, tokenBuckets, bodyAdmission, bodyLimit, isControlRequest, trafficClass } from '../src/traffic-policy.mjs'

describe('bounded traffic policy', () => {
  it('has exact bursts, monotonic refill and a usable retry delay', () => {
    let now = 0
    const buckets = tokenBuckets({ now: () => now }), policy = { burst: 2, rate: 0.5 }
    expect(buckets.take('a', policy)).toBe(0)
    expect(buckets.take('a', policy)).toBe(0)
    expect(buckets.take('a', policy)).toBe(2)
    now = 1000
    expect(buckets.take('a', policy)).toBe(1)
    now = 2000
    expect(buckets.take('a', policy)).toBe(0)
    now = 1000
    expect(buckets.take('a', policy)).toBe(2)
    now = 4000
    expect(buckets.take('a', policy)).toBe(0)
  })
  it('does not reset existing limits when its bounded key table is full', () => {
    let now = 0
    const buckets = tokenBuckets({ now: () => now, maxKeys: 2, idleMs: 300000 })
    const policy = { burst: 1, rate: 1 }
    expect(buckets.take('a', policy)).toBe(0)
    expect(buckets.take('b', policy)).toBe(0)
    for (let i = 0; i < 10000; i++) expect(buckets.take(`new${i}`, policy)).toBe(1)
    expect(buckets.size).toBe(2)
    expect(buckets.take('a', policy)).toBe(1)
    now = 300001
    expect(buckets.take('c', policy)).toBe(0)
    expect(buckets.size).toBe(1)
  })
  it('separates control, plugin and ordinary traffic; fake method does not reserve control capacity', () => {
    expect(trafficClass('POST', '/v1/messages')).toBe('write')
    expect(trafficClass('POST', '/v1/plugins/event')).toBe('plugin')
    expect(trafficClass('GET', '/v1/events')).toBe('inbox')
    expect(trafficClass('POST', '/v1/ack')).toBe('delivery')
    expect(trafficClass('GET', '/v1/directory')).toBe('query')
    expect(isControlRequest('GET', '/v1/ack')).toBe(false)
    expect(isControlRequest('POST', '/v1/read')).toBe(true)
    expect(bodyLimit('/v1/messages')).toBe(8 * 1024 * 1024)
    expect(bodyLimit('/v1/challenge')).toBe(8192)
    expect(bodyLimit('/v1/ack')).toBe(16384)
    expect(bodyLimit('/v1/plugins/event')).toBe(128 * 1024)
    for (const policy of Object.values(TRAFFIC)) expect(policy.burst / policy.rate * 1000).toBeLessThan(300000)
  })
  it('caps upload reservations and reclaims every slot exactly once', () => {
    const admission = bodyAdmission()
    const releases = Array.from({ length: 4 }, () => admission.acquire('a', '/v1/messages', false))
    expect(releases.every(Boolean)).toBe(true)
    expect(admission.acquire('b', '/v1/messages', false)).toBeNull()
    expect(admission.acquire('a', '/v1/friends/request', false)).toBeNull()
    const control = admission.acquire('a', '/v1/ack', true)
    expect(control).toBeTypeOf('function')
    releases[0](); releases[0]()
    const next = admission.acquire('b', '/v1/messages', false)
    expect(next).toBeTypeOf('function')
    expect(admission.acquire('c', '/v1/messages', false)).toBeNull()
    for (const release of releases) release()
    next(); control()
    expect(admission.acquire('a', '/v1/messages', false)).toBeTypeOf('function')
  })
})
