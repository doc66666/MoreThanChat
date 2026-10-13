import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  createCipheriv, createDecipheriv, randomBytes, scrypt,
  type KeyObject,
} from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CredentialCipher } from './credential-store'

export class ClientIdentity {
  readonly userId: string
  readonly publicKey: string
  constructor(private readonly privateKey: KeyObject) {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('身份密钥格式不受支持')
    const encoded = createPublicKey(privateKey).export({
      format: 'der',
      type: 'spki',
    })
    this.publicKey = encoded.toString('base64url')
    this.userId = 'usr_' + createHash('sha256').update(encoded).digest('hex')
  }
  sign(challenge: string): string {
    return sign(null, Buffer.from(challenge), this.privateKey).toString(
      'base64url',
    )
  }
  async backup(password: string): Promise<string> {
    checkPassword(password)
    const salt = randomBytes(16), iv = randomBytes(12)
    const key = await backupKey(password, salt)
    const plain = Buffer.from(this.privateKey.export({ format: 'pem', type: 'pkcs8' }))
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(BACKUP_FORMAT))
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
      return JSON.stringify({ format: BACKUP_FORMAT, salt: salt.toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') })
    } finally { key.fill(0); plain.fill(0) }
  }
  static async fromBackup(encoded: string, password: string): Promise<ClientIdentity> {
    checkPassword(password)
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 8192) throw new Error('备份文件过大或无效')
    let key: Buffer | undefined, plain: Buffer | undefined
    try {
      const data = JSON.parse(encoded)
      if (data.format !== BACKUP_FORMAT || Object.keys(data).length !== 5) throw new Error()
      const decode = (value: unknown, size?: number) => {
        if (typeof value !== 'string') throw new Error()
        const bytes = Buffer.from(value, 'base64')
        if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) throw new Error()
        return bytes
      }
      const salt = decode(data.salt, 16), iv = decode(data.iv, 12), tag = decode(data.tag, 16), ciphertext = decode(data.ciphertext)
      if (ciphertext.length > 1024 || ciphertext.length < 32) throw new Error()
      key = await backupKey(password, salt)
      const cipher = createDecipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(BACKUP_FORMAT)); cipher.setAuthTag(tag)
      plain = Buffer.concat([cipher.update(ciphertext), cipher.final()])
      return new ClientIdentity(createPrivateKey(plain))
    } catch { throw new Error('无法解锁身份备份：密码错误、文件损坏或版本不受支持') }
    finally { key?.fill(0); plain?.fill(0) }
  }
  async persistNew(directory: string, cipher: CredentialCipher): Promise<void> {
    if (!cipher.available()) throw new Error('系统身份加密不可用，请启用系统密钥库')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const encrypted = cipher.encrypt(this.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    await writeFile(path.join(directory, 'identity-secret.bin'), encrypted, { flag: 'wx', mode: 0o600 })
  }
  static async load(
    directory: string,
    cipher: CredentialCipher,
  ): Promise<ClientIdentity> {
    if (!cipher.available())
      throw new Error('系统身份加密不可用，请启用系统密钥库')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, 'identity-secret.bin')
    try {
      return new ClientIdentity(
        createPrivateKey(cipher.decrypt(await readFile(file))),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const keys = generateKeyPairSync('ed25519'),
      pem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    await writeFile(file, cipher.encrypt(pem), { flag: 'wx', mode: 0o600 })
    return new ClientIdentity(keys.privateKey)
  }
}

// Fixed versioned parameters: untrusted files cannot request arbitrary KDF work.
const BACKUP_FORMAT = 'more-than-chat.identity.scrypt-aes256gcm.v1'
function checkPassword(value: string): void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256 || !value.trim()) throw new Error('备份密码需要 12–256 个字符')
}
function backupKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
}
