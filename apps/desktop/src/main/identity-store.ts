import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CredentialCipher } from './credential-store'

export class ClientIdentity {
  readonly userId: string
  readonly publicKey: string
  constructor(private readonly privateKey: KeyObject) {
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
