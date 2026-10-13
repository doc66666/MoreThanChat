import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { operatorAddress, operatorRequest, runAccessCli, runStatusCli } from '../src/operator-client.mjs'

const TOKEN = 'operator-test-secret-1234567890'
const env = { MTC_SERVER_ADMIN_TOKEN: TOKEN }
const uid = 'usr_' + 'a'.repeat(64)
const roots = []
const stats = () => ({ version: 1, uptimeMs: 2500, closing: false, runtime: { activeSessions: 2, pendingPolls: 1 }, users: 3, groups: 1, devices: { active: 4, revoked: 1 }, queue: { rows: 5, payloadBytes: 3000, deviceObligations: 8, oldestAgeMs: 900 } })
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function rejectsWithoutSecret(operation) {
  let error
  try { await operation() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  expect(error.message).not.toContain(TOKEN)
}

describe('operator-only address boundaries', () => {
  it.each([
    [undefined, 'http://localhost:8787'], ['http://localhost:8787/', 'http://localhost:8787'],
    ['http://127.0.0.1:1234', 'http://127.0.0.1:1234'], ['http://[::1]:8787', 'http://[::1]:8787'],
    ['https://private.example:8443/', 'https://private.example:8443'], ['https://EXAMPLE.com:443', 'https://example.com'],
  ])('normalizes the permitted server origin %j', (input, expected) => {
    expect(operatorAddress(input)).toBe(expected)
  })

  it.each(['http://remote.example', 'http://0.0.0.0:8787', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?token=secret', 'https://example.com/#fragment', 'file:///tmp/server', 'ftp://example.com', '', 'not a URL'])('refuses insecure or ambiguous address %j', input => {
    expect(() => operatorAddress(input)).toThrow()
  })

  it.each(['@attacker.example/v1/admin/status', '//attacker.example', 'https://attacker.example', '/v1/admin/status?token=bad', '/v1/admin/access/../status', '/v1/messages'])('refuses arbitrary route %j before reading credentials or requesting', async route => {
    const fetchImpl = vi.fn()
    await expect(operatorRequest(route, { env: {}, fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses route/method mismatches before sending a credential', async () => {
    const fetchImpl = vi.fn()
    await expect(operatorRequest('/v1/admin/status', { env, body: {}, fetchImpl })).rejects.toThrow()
    await expect(operatorRequest('/v1/admin/access', { env, fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('operator transport and privacy', () => {
  it('uses a header-only credential, disables redirects and bounds the request deadline', async () => {
    const fetchImpl = vi.fn(async () => response(stats()))
    expect(await runStatusCli(['https://private.example'], { env, fetchImpl })).toEqual(stats())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://private.example/v1/admin/status')
    expect(url).not.toContain(TOKEN)
    expect(options).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer ' + TOKEN }, redirect: 'error' })
    expect(options).not.toHaveProperty('body')
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('uses an explicit token file, or the development fallback only when no source was specified', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mtc-operator-'))
    roots.push(root)
    const file = path.join(root, 'admin-token')
    await writeFile(file, TOKEN + '\n', { mode: 0o600 })
    const fetchImpl = vi.fn(async () => response(stats()))
    await runStatusCli([], { env: {}, defaultTokenFile: file, fetchImpl })
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer ' + TOKEN)
    await runStatusCli([], { env: { MTC_SERVER_ADMIN_TOKEN_FILE: file }, defaultTokenFile: 'missing', fetchImpl })
    await runStatusCli([], { env, defaultTokenFile: 'missing', fetchImpl })
    await expect(runStatusCli([], { env: { MTC_SERVER_ADMIN_TOKEN: '' }, defaultTokenFile: file, fetchImpl })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('rejects dual credential sources without issuing a request', async () => {
    const fetchImpl = vi.fn()
    await expect(runStatusCli([], { env: { ...env, MTC_SERVER_ADMIN_TOKEN_FILE: '/unneeded' }, fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns a fixed HTTP error without parsing an unsuccessful response body', async () => {
    const fetchImpl = vi.fn(async () => new Response(TOKEN, { status: 403 }))
    await rejectsWithoutSecret(() => runStatusCli([], { env, fetchImpl }))
  })

  it('redacts network and invalid JSON errors instead of echoing transport or body details', async () => {
    await rejectsWithoutSecret(() => runStatusCli([], { env, fetchImpl: async () => { throw new Error(TOKEN) } }))
    await rejectsWithoutSecret(() => runStatusCli([], { env, fetchImpl: async () => new Response('{ ' + TOKEN) }))
  })

  it('limits response bytes, including responses whose size is not declared', async () => {
    await rejectsWithoutSecret(() => runStatusCli([], { env, fetchImpl: async () => new Response(JSON.stringify({ value: TOKEN.repeat(2000) })) }))
    const bytes = new TextEncoder().encode(TOKEN.repeat(2000))
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
    await rejectsWithoutSecret(() => runStatusCli([], { env, fetchImpl: async () => new Response(stream) }))
  })

  it('does not return unexpected successful status payload fields', async () => {
    expect(await runStatusCli([], { env, fetchImpl: async () => response({ ...stats(), messages: [TOKEN] }) })).toEqual(stats())
    const withSecret = stats()
    withSecret.queue.body = TOKEN
    expect(await runStatusCli([], { env, fetchImpl: async () => response(withSecret) })).toEqual(stats())
  })

  it.each([
    { users: -1 }, { groups: 1.5 }, { version: 2 }, { closing: 'false' }, { uptimeMs: '2500' },
    { devices: { active: -1, revoked: 0 } }, { runtime: { activeSessions: 1, pendingPolls: null } },
    { queue: { rows: 0, payloadBytes: 0, deviceObligations: 0, oldestAgeMs: -1 } },
  ])('rejects invalid status values %j', async replacement => {
    await expect(runStatusCli([], { env, fetchImpl: async () => response({ ...stats(), ...replacement }) })).rejects.toThrow()
  })

  it('permits an empty queue with null age', async () => {
    const empty = stats()
    empty.queue = { rows: 0, payloadBytes: 0, deviceObligations: 0, oldestAgeMs: null }
    expect(await runStatusCli([], { env, fetchImpl: async () => response(empty) })).toEqual(empty)
  })

  it('keeps access actions scoped to the supplied identity and does not include credentials in results', async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true }))
    expect(await runAccessCli(['allow', uid], { env, fetchImpl })).toEqual({ ok: true, operation: 'allow', userId: uid, origin: 'http://localhost:8787' })
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:8787/v1/admin/access')
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ userId: uid, allowed: true })
    await runAccessCli(['deny', uid, 'https://private.example'], { env, fetchImpl })
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ userId: uid, allowed: false })
  })

  it('rejects malformed CLI arguments without network side effects', async () => {
    const fetchImpl = vi.fn()
    for (const args of [[], ['allow'], ['delete', uid], ['allow', 'bad'], ['allow', uid, 'https://example.com', 'extra']]) {
      await expect(runAccessCli(args, { env, fetchImpl })).rejects.toThrow()
    }
    await expect(runStatusCli(['https://example.com', 'extra'], { env, fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
