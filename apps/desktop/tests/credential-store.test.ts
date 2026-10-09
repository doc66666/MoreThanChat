import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EncryptedCredentialStore, type CredentialCipher } from '../src/main/credential-store'

const directories: string[] = []
const cipher: CredentialCipher = { available: () => true,
  encrypt: value => Buffer.from([...value].reverse().join(''), 'utf8'),
  decrypt: value => [...value.toString('utf8')].reverse().join(''),
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function directory() { const value = await mkdtemp(path.join(tmpdir(), 'mtc-credential-test-')); directories.push(value); return value }

describe('Main credential storage', () => {
  it('persists only cipher output, reloads and clears it', async () => {
    const root = await directory()
    const store = new EncryptedCredentialStore(root, cipher)
    await store.write('test-secret-value')
    expect((await readFile(path.join(root, 'model-secret.bin'))).toString()).not.toContain('test-secret-value')
    expect(await new EncryptedCredentialStore(root, cipher).read()).toBe('test-secret-value')
    await store.write(null)
    expect(await store.read()).toBeNull()
  })
  it('migrates legacy plaintext only after committing encrypted data', async () => {
    const root = await directory()
    const legacy = path.join(root, 'model-credentials.json')
    await writeFile(legacy, JSON.stringify({ v: 1, apiKey: 'test-secret-value' }))
    const store = new EncryptedCredentialStore(root, cipher)
    expect(await store.read()).toBe('test-secret-value')
    await expect(readFile(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(path.join(root, 'model-secret.bin'))).toString()).not.toContain('test-secret-value')
  })
  it('refuses unprotected storage and leaves the previous credential intact', async () => {
    const root = await directory()
    await writeFile(path.join(root, 'model-credentials.json'), JSON.stringify({ apiKey: 'old-test-value' }))
    const unavailable = new EncryptedCredentialStore(root, { ...cipher, available: () => false })
    await expect(unavailable.read()).rejects.toThrow('unavailable')
    await expect(unavailable.write('new-test-value')).rejects.toThrow('unavailable')
    expect(JSON.parse(await readFile(path.join(root, 'model-credentials.json'), 'utf8')).apiKey).toBe('old-test-value')
    await expect(readFile(path.join(root, 'model-secret.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
