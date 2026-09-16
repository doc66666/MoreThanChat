import { describe, expect, it, vi } from 'vitest'
import {
  TransportRegistry,
  createSeedState,
  formatRelativeTime,
  normalizeState,
  type ChatTransportPlugin,
} from '../src/index.js'

describe('TransportRegistry', () => {
  const plugin: ChatTransportPlugin = {
    id: 'test.transport',
    version: '1.0.0',
    displayName: 'Test',
    create: () => ({
      id: 'test.transport',
      displayName: 'Test',
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
    }),
  }

  it('registers and disposes a transport contribution', () => {
    const registry = new TransportRegistry()
    const dispose = registry.register(plugin)
    expect(registry.get(plugin.id)).toBe(plugin)
    dispose()
    expect(registry.get(plugin.id)).toBeUndefined()
  })

  it('rejects duplicate ids', () => {
    const registry = new TransportRegistry()
    registry.register(plugin)
    expect(() => registry.register(plugin)).toThrow(/already registered/)
  })
})

describe('chat state', () => {
  it('falls back to a usable seed when persisted data is invalid', () => {
    const state = normalizeState({ version: 99 })
    expect(state.conversations.length).toBeGreaterThan(0)
    expect(state.messages[state.activeConversationId]?.length).toBeGreaterThan(0)
  })

  it('keeps a valid version-one snapshot', () => {
    const state = createSeedState(1_700_000_000_000)
    expect(normalizeState(state)).toEqual(state)
  })

  it('formats a same-day timestamp as a clock time', () => {
    const now = new Date('2026-09-03T10:30:00+08:00').getTime()
    const value = formatRelativeTime(new Date('2026-09-03T09:15:00+08:00').getTime(), now)
    expect(value).toMatch(/09:15/)
  })
})
