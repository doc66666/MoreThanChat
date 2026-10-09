import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface CredentialCipher {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

/** Only Main holds the OS encryptor. Keys never cross the Renderer return path. */
export class EncryptedCredentialStore {
  readonly #file: string
  readonly #legacy: string
  #tail: Promise<unknown> = Promise.resolve()

  constructor(readonly directory: string, readonly cipher: CredentialCipher) {
    this.#file = path.join(directory, 'model-secret.bin')
    this.#legacy = path.join(directory, 'model-credentials.json')
  }

  read(): Promise<string | null> {
    return this.#queue(async () => {
      const encrypted = await this.#readOptional(this.#file)
      if (encrypted) {
        this.#assertAvailable()
        const key = this.cipher.decrypt(encrypted)
        this.#validate(key)
        // A migration interrupted after ciphertext commit can be completed now.
        await rm(this.#legacy, { force: true })
        return key
      }
      const legacy = await this.#readOptional(this.#legacy)
      if (!legacy) return null
      const value = JSON.parse(legacy.toString('utf8')) as { apiKey?: unknown }
      if (typeof value.apiKey !== 'string') throw new Error('Saved credential is invalid.')
      this.#validate(value.apiKey)
      await this.#write(value.apiKey)
      return value.apiKey
    })
  }

  write(key: string | null): Promise<void> { return this.#queue(() => this.#write(key)) }

  async #write(key: string | null): Promise<void> {
    if (key === null) {
      await rm(this.#file, { force: true })
      await rm(this.#legacy, { force: true })
      return
    }
    this.#validate(key)
    this.#assertAvailable()
    const ciphertext = this.cipher.encrypt(key)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.#file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, ciphertext, { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.#file)
      await rm(this.#legacy, { force: true })
    } finally { await rm(temporary, { force: true }) }
  }

  async #readOptional(file: string): Promise<Buffer | null> {
    try {
      const data = await readFile(file)
      if (data.length > 16384) throw new Error('Saved credential is oversized.')
      return data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  #validate(key: string): void { if (!key.trim() || key.length > 4096) throw new Error('Saved credential is invalid.') }
  #assertAvailable(): void { if (!this.cipher.available()) throw new Error('System credential encryption is unavailable.') }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.catch(() => undefined).then(operation)
    this.#tail = next
    return next
  }
}
