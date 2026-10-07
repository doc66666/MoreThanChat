import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { utilityProcess } from 'electron'
import { createElectronHostProcessFactory } from '../src/main/electron-host-process'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function createFakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 123, stdout: null, stderr: null, postMessage: vi.fn(), kill: vi.fn(() => true),
  })
}

describe('Electron Host process boundary', () => {
  it('does not inherit application secrets or Node code-injection environment options', () => {
    vi.stubEnv('MTC_PRIVATE_TOKEN', 'must-not-enter-host')
    vi.stubEnv('NODE_OPTIONS', '--require unexpected-module')
    vi.mocked(utilityProcess.fork).mockReturnValue(createFakeChild() as never)
    createElectronHostProcessFactory({ entryPath: 'host.js', cwd: 'host', environment: { MTC_HOST_QA_CRASH_ONCE: '1' } })(3)
    const options = vi.mocked(utilityProcess.fork).mock.calls[0]![2]!
    expect(options.env).not.toHaveProperty('MTC_PRIVATE_TOKEN')
    expect(options.env).not.toHaveProperty('NODE_OPTIONS')
    expect(options.env).toMatchObject({ MTC_HOST_GENERATION: '3', MTC_HOST_QA_CRASH_ONCE: '1' })
  })

  it('drops the full fatal diagnostic report and removes subscriptions', () => {
    const child = createFakeChild()
    vi.mocked(utilityProcess.fork).mockReturnValue(child as never)
    const process = createElectronHostProcessFactory({ entryPath: 'host.js', cwd: 'host' })(1)
    const messages: string[] = []
    const unsubscribe = process.onFatal(message => messages.push(message))
    child.emit('error', 'FatalError', 'engine\nlocation', 'SECRET_TOKEN=diagnostic-secret')
    expect(messages).toEqual(['Fatal utility-process error at enginelocation.'])
    expect(messages[0]).not.toContain('diagnostic-secret')
    unsubscribe()
    expect(child.listenerCount('error')).toBe(0)
  })
})
