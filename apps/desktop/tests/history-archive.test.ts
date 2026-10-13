import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readHistoryArchive, writeHistoryArchive } from '../src/main/history-archive'

const password = 'private-history-test-password'
let root: string
let archive: string
let work: string

async function collect(records: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []
  for await (const record of records) result.push(record)
  return result
}

// Produces authenticated, deliberately malformed JSONL to exercise parsing separately from GCM.
async function craftedArchive(plaintext: Buffer): Promise<void> {
  const header = Buffer.alloc(40)
  header.write('MTCHIST\n', 0, 'ascii')
  header.writeUInt32BE(1, 8)
  randomBytes(16).copy(header, 12)
  randomBytes(12).copy(header, 28)
  const key = scryptSync(password, header.subarray(12, 28), 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  try {
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(28, 40))
    cipher.setAAD(header)
    await writeFile(archive, Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]))
  } finally { key.fill(0) }
}

describe('streamed authenticated history archives', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mtc-history-archive-test-'))
    archive = path.join(root, 'backup.mtchistory')
    work = path.join(root, 'work')
    await mkdir(work)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('round-trips async JSONL records larger than 8 MiB in total without exposing plaintext', async () => {
    const records = [{ type: 'metadata', name: '私密历史 marker-not-visible-12345' }, { data: '一'.repeat(1_600_000) }, { data: 'b'.repeat(4_000_000) }]
    async function* stream() { for (const value of records) yield value }
    await writeHistoryArchive(archive, password, stream())
    const encrypted = await readFile(archive)
    expect(encrypted.length).toBeGreaterThan(8 * 1024 * 1024)
    expect(encrypted.includes(Buffer.from('marker-not-visible-12345'))).toBe(false)
    expect(encrypted.subarray(0, 8).toString()).toBe('MTCHIST\n')
    const opened = await readHistoryArchive(archive, password, work)
    try {
      expect(await collect(opened.records())).toEqual(records)
      expect(await collect(opened.records())).toEqual(records)
    } finally { await opened.dispose() }
    await opened.dispose()
    expect(await readdir(work)).toEqual([])
    await expect(collect(opened.records())).rejects.toMatchObject({ code: 'DISPOSED' })
  }, 15_000)

  it('never overwrites an existing target and removes unpublished temporary files', async () => {
    await writeFile(archive, 'keep this original backup')
    await expect(writeHistoryArchive(archive, password, [{ text: 'new data' }])).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
    expect(await readFile(archive, 'utf8')).toBe('keep this original backup')
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects wrong passwords, modified ciphertext and authenticated header tampering before records are exposed', async () => {
    await writeHistoryArchive(archive, password, [{ text: 'secret' }])
    const original = await readFile(archive)
    await expect(readHistoryArchive(archive, 'incorrect-but-long-password', work)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    for (const offset of [12, 28, 40, original.length - 1]) {
      const modified = Buffer.from(original)
      modified[offset] ^= 1
      await writeFile(archive, modified)
      await expect(readHistoryArchive(archive, password, work)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
      expect(await readdir(work)).toEqual([])
    }
  }, 15_000)

  it('rejects truncated, unrelated and unsupported-version files with clear format errors', async () => {
    await writeHistoryArchive(archive, password, [{ text: 'original' }])
    const original = await readFile(archive)
    await writeFile(archive, original.subarray(0, original.length - 1))
    await expect(readHistoryArchive(archive, password, work)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    await writeFile(archive, original.subarray(0, 50))
    await expect(readHistoryArchive(archive, password, work)).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
    const version = Buffer.from(original); version.writeUInt32BE(99, 8)
    await writeFile(archive, version)
    await expect(readHistoryArchive(archive, password, work)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
    const unrelated = Buffer.from(original); unrelated[0] ^= 1
    await writeFile(archive, unrelated)
    await expect(readHistoryArchive(archive, password, work)).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
    expect(await readdir(work)).toEqual([])
  })

  it('validates password character limits before creating output', async () => {
    for (const invalid of ['', 'short', 'a'.repeat(257), '😀'.repeat(129), ' '.repeat(12)]) {
      await expect(writeHistoryArchive(archive, invalid, [])).rejects.toMatchObject({ code: 'INVALID_PASSWORD' })
      await expect(readHistoryArchive(archive, invalid, work)).rejects.toMatchObject({ code: 'INVALID_PASSWORD' })
    }
    expect(await readdir(root)).toEqual(['work'])
    // Match identity backup and Main validation: 12 UTF-16 code units, without trimming the key.
    await writeHistoryArchive(archive, '😀'.repeat(6), [])
    const opened = await readHistoryArchive(archive, '😀'.repeat(6), work)
    try { expect(await collect(opened.records())).toEqual([]) } finally { await opened.dispose() }
  })

  it('cleans up after an input iterator fails and rejects non-JSON or overlong write records', async () => {
    async function* broken() { yield { good: true }; throw new Error('source failed') }
    await expect(writeHistoryArchive(archive, password, broken())).rejects.toThrow('source failed')
    await expect(writeHistoryArchive(archive, password, [undefined])).rejects.toMatchObject({ code: 'INVALID_RECORD' })
    await expect(writeHistoryArchive(archive, password, [{ tooLarge: 'x'.repeat(12 * 1024 * 1024) }])).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(await readdir(root)).toEqual(['work'])
  }, 10_000)

  it('enforces the byte limit per read record and cleans decrypted staging on iteration failure', async () => {
    await craftedArchive(Buffer.from(`"${'x'.repeat(12 * 1024 * 1024)}"\n`))
    const opened = await readHistoryArchive(archive, password, work)
    await expect(collect(opened.records())).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(await readdir(work)).toEqual([])
    await opened.dispose()
  }, 10_000)

  it('rejects authenticated invalid JSON, invalid UTF-8 and unterminated lines and cleans each staging directory', async () => {
    for (const bytes of [Buffer.from('{not json}\n'), Buffer.from([0xff, 10]), Buffer.from('{"unfinished":true}')]) {
      await craftedArchive(bytes)
      const opened = await readHistoryArchive(archive, password, work)
      await expect(collect(opened.records())).rejects.toMatchObject({ code: 'INVALID_RECORD' })
      expect(await readdir(work)).toEqual([])
    }
  }, 15_000)

  it('cleans staging on consumer early return without touching neighbouring work files', async () => {
    await writeFile(path.join(work, 'unrelated.txt'), 'keep')
    await writeHistoryArchive(archive, password, [1, 2, 3])
    const opened = await readHistoryArchive(archive, password, work)
    for await (const record of opened.records()) { expect(record).toBe(1); break }
    expect(await readdir(work)).toEqual(['unrelated.txt'])
    expect(await readFile(path.join(work, 'unrelated.txt'), 'utf8')).toBe('keep')
    await expect(collect(opened.records())).rejects.toMatchObject({ code: 'DISPOSED' })
  })

  it('refuses non-regular input files', async () => {
    await expect(readHistoryArchive(work, password, root)).rejects.toMatchObject({ code: 'UNSAFE_FILE' })
  })

  it.skipIf(process.platform === 'win32')('refuses source symlinks', async () => {
    await writeHistoryArchive(archive, password, [1])
    const linked = path.join(root, 'linked.mtchistory')
    await symlink(archive, linked)
    await expect(readHistoryArchive(linked, password, work)).rejects.toMatchObject({ code: 'UNSAFE_FILE' })
  })
})
