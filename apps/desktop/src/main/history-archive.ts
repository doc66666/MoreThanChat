import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink, type FileHandle } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto'
import path from 'node:path'

const MAGIC = Buffer.from('MTCHIST\n', 'ascii')
const VERSION = 1
const HEADER_BYTES = 40
const TAG_BYTES = 16
const RECORD_BYTES = 12 * 1024 * 1024
const PLAIN_BYTES = 1024 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

type ArchiveErrorCode = 'INVALID_PASSWORD' | 'INVALID_FORMAT' | 'UNSUPPORTED_VERSION' | 'AUTHENTICATION_FAILED'
  | 'LIMIT_EXCEEDED' | 'INVALID_RECORD' | 'TARGET_EXISTS' | 'UNSAFE_FILE' | 'DISPOSED' | 'BUSY'

export class HistoryArchiveError extends Error {
  constructor(public readonly code: ArchiveErrorCode, message: string) {
    super(message)
    this.name = 'HistoryArchiveError'
  }
}

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 || !password.trim()) {
    throw new HistoryArchiveError('INVALID_PASSWORD', '历史备份密码需要 12–256 个字符。')
  }
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

async function writeAll(file: FileHandle, data: Buffer): Promise<void> {
  let offset = 0
  while (offset < data.length) {
    const result = await file.write(data, offset, data.length - offset)
    if (result.bytesWritten === 0) throw new Error('历史备份写入未完成。')
    offset += result.bytesWritten
  }
}

async function readExactly(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const result = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const read = await file.read(result, offset, length - offset, position + offset)
    if (read.bytesRead === 0) throw new HistoryArchiveError('INVALID_FORMAT', '历史备份文件不完整或已损坏。')
    offset += read.bytesRead
  }
  return result
}

/** Authenticated JSONL, without compression. The version also fixes all KDF and size parameters. */
export async function writeHistoryArchive(target: string, password: string, records: AsyncIterable<unknown> | Iterable<unknown>): Promise<void> {
  validatePassword(password)
  const destination = path.resolve(target)
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`)
  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header)
  header.writeUInt32BE(VERSION, 8)
  randomBytes(16).copy(header, 12)
  randomBytes(12).copy(header, 28)
  const key = await deriveKey(password, header.subarray(12, 28))
  let file: FileHandle | undefined
  let ownsTemporary = false
  try {
    file = await open(temporary, 'wx', 0o600)
    ownsTemporary = true
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(28, 40))
    cipher.setAAD(header)
    await writeAll(file, header)
    let total = 0
    for await (const record of records) {
      let serialized: string | undefined
      try { serialized = JSON.stringify(record) } catch { throw new HistoryArchiveError('INVALID_RECORD', '历史备份包含无法编码的记录。') }
      if (serialized === undefined) throw new HistoryArchiveError('INVALID_RECORD', '历史备份包含无法编码的记录。')
      const bytes = Buffer.byteLength(serialized, 'utf8')
      if (bytes > RECORD_BYTES || total + bytes + 1 > PLAIN_BYTES) {
        throw new HistoryArchiveError('LIMIT_EXCEEDED', '历史备份超过单条 12 MiB 或总计 1 GiB 的限制。')
      }
      total += bytes + 1
      await writeAll(file, cipher.update(Buffer.from(`${serialized}\n`, 'utf8')))
    }
    await writeAll(file, cipher.final())
    await writeAll(file, cipher.getAuthTag())
    await file.sync()
    await file.close()
    file = undefined
    try {
      // A rename would silently replace a previously existing user backup on some platforms.
      try { await link(temporary, destination) }
      catch (error) {
        if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(errorCode(error) ?? '')) throw error
        await copyFile(temporary, destination, constants.COPYFILE_EXCL)
        const published = await open(destination, 'r+')
        try { await published.sync() } finally { await published.close() }
      }
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new HistoryArchiveError('TARGET_EXISTS', '目标备份文件已经存在，未覆盖原文件。')
      throw error
    }
    if(process.platform!=='win32'){
      const directory=await open(path.dirname(destination),'r')
      try{await directory.sync()}finally{await directory.close()}
    }
  } finally {
    key.fill(0)
    await file?.close().catch(() => undefined)
    if (ownsTemporary) await unlink(temporary).catch(() => undefined)
  }
}

export interface OpenHistoryArchive {
  records(): AsyncIterable<unknown>
  dispose(): Promise<void>
}

/** No records are exposed until the entire ciphertext has passed GCM authentication. */
export async function readHistoryArchive(source: string, password: string, workDirectory: string): Promise<OpenHistoryArchive> {
  validatePassword(password)
  const sourcePath = path.resolve(source)
  const before = await lstat(sourcePath)
  if (!before.isFile() || before.isSymbolicLink()) throw new HistoryArchiveError('UNSAFE_FILE', '请选择普通历史备份文件，不能使用符号链接。')
  const input = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let key: Buffer | undefined
  let plaintext: FileHandle | undefined
  let temporaryDirectory: string | undefined
  let workRoot: string | undefined
  let temporaryIdentity: { dev: number; ino: number } | undefined
  let disposed = false
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    disposal = (async () => {
      await plaintext?.close()
      plaintext = undefined
      if (temporaryDirectory && workRoot && temporaryIdentity) {
        // Only this invocation's own, still-identical child directory can be removed recursively.
        if (path.dirname(temporaryDirectory) !== workRoot || !path.basename(temporaryDirectory).startsWith('mtc-history-read-')) {
          throw new HistoryArchiveError('UNSAFE_FILE', '历史备份暂存目录校验失败。')
        }
        const current = await lstat(temporaryDirectory).catch(error => {
          if (errorCode(error) === 'ENOENT') return undefined
          throw error
        })
        if (current) {
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== temporaryIdentity.dev || current.ino !== temporaryIdentity.ino) {
            throw new HistoryArchiveError('UNSAFE_FILE', '历史备份暂存目录已改变，未删除未知文件。')
          }
          await rm(temporaryDirectory, { recursive: true, force: true })
        }
      }
    })()
    return disposal
  }
  try {
    const info = await input.stat()
    const after = await lstat(sourcePath)
    if (!info.isFile() || !after.isFile() || after.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino || after.dev !== info.dev || after.ino !== info.ino) {
      throw new HistoryArchiveError('UNSAFE_FILE', '历史备份文件在打开时发生变化。')
    }
    if (info.size < HEADER_BYTES + TAG_BYTES) throw new HistoryArchiveError('INVALID_FORMAT', '历史备份文件不完整或已损坏。')
    if (info.size > PLAIN_BYTES + HEADER_BYTES + TAG_BYTES) throw new HistoryArchiveError('LIMIT_EXCEEDED', '历史备份超过 1 GiB 的限制。')
    const header = await readExactly(input, HEADER_BYTES, 0)
    if (!header.subarray(0, 8).equals(MAGIC)) throw new HistoryArchiveError('INVALID_FORMAT', '这不是有效的 MoreThanChat 历史备份。')
    if (header.readUInt32BE(8) !== VERSION) throw new HistoryArchiveError('UNSUPPORTED_VERSION', '此历史备份版本暂不支持，请更新客户端。')
    key = await deriveKey(password, header.subarray(12, 28))
    await mkdir(workDirectory, { recursive: true, mode: 0o700 })
    workRoot = await realpath(workDirectory)
    temporaryDirectory = await mkdtemp(path.join(workRoot, 'mtc-history-read-'))
    temporaryIdentity = await lstat(temporaryDirectory)
    plaintext = await open(path.join(temporaryDirectory, 'records.jsonl'), 'wx+', 0o600)
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(28, 40))
    decipher.setAAD(header)
    const ciphertextEnd = info.size - TAG_BYTES
    let plaintextBytes = 0
    const append = async (chunk: Buffer): Promise<void> => {
      plaintextBytes += chunk.length
      if (plaintextBytes > PLAIN_BYTES) throw new HistoryArchiveError('LIMIT_EXCEEDED', '历史备份超过 1 GiB 的限制。')
      await writeAll(plaintext!, chunk)
    }
    for (let position = HEADER_BYTES; position < ciphertextEnd;) {
      const chunk = await readExactly(input, Math.min(CHUNK_BYTES, ciphertextEnd - position), position)
      position += chunk.length
      await append(decipher.update(chunk))
    }
    decipher.setAuthTag(await readExactly(input, TAG_BYTES, ciphertextEnd))
    try { await append(decipher.final()) }
    catch (error) {
      if (error instanceof HistoryArchiveError) throw error
      throw new HistoryArchiveError('AUTHENTICATION_FAILED', '历史备份密码不正确，或文件已损坏。')
    }
    const extra = Buffer.alloc(1)
    if ((await input.read(extra, 0, 1, info.size)).bytesRead !== 0 || (await input.stat()).size !== info.size) {
      throw new HistoryArchiveError('INVALID_FORMAT', '历史备份文件在读取时发生变化。')
    }
    let iterating = false
    return {
      dispose,
      async *records(): AsyncIterable<unknown> {
        if (disposed) throw new HistoryArchiveError('DISPOSED', '历史备份暂存数据已清理。')
        if (iterating) throw new HistoryArchiveError('BUSY', '历史备份记录已经在读取中。')
        iterating = true
        let complete = false
        try {
          let parts: Buffer[] = []
          let lineBytes = 0
          const decoder = new TextDecoder('utf-8', { fatal: true })
          for (let position = 0; position < plaintextBytes;) {
            if (disposed) throw new HistoryArchiveError('DISPOSED', '历史备份暂存数据已清理。')
            const chunk = await readExactly(plaintext!, Math.min(CHUNK_BYTES, plaintextBytes - position), position)
            position += chunk.length
            let offset = 0
            while (offset < chunk.length) {
              const newline = chunk.indexOf(10, offset)
              const end = newline < 0 ? chunk.length : newline
              const part = chunk.subarray(offset, end)
              lineBytes += part.length
              if (lineBytes > RECORD_BYTES) throw new HistoryArchiveError('LIMIT_EXCEEDED', '历史备份中的单条记录超过 12 MiB。')
              parts.push(part)
              offset = end + 1
              if (newline < 0) break
              let value: unknown
              try { value = JSON.parse(decoder.decode(Buffer.concat(parts, lineBytes))) }
              catch { throw new HistoryArchiveError('INVALID_RECORD', '历史备份中包含无效的 JSON 记录。') }
              parts = []
              lineBytes = 0
              if (disposed) throw new HistoryArchiveError('DISPOSED', '历史备份暂存数据已清理。')
              yield value
            }
          }
          if (lineBytes !== 0) throw new HistoryArchiveError('INVALID_RECORD', '历史备份最后一条记录不完整。')
          complete = true
        } finally {
          iterating = false
          // Invalid input and a consumer's early break/throw must not leave decrypted records behind.
          if (!complete) await dispose()
        }
      },
    }
  } catch (error) {
    await dispose().catch(() => undefined)
    throw error
  } finally {
    key?.fill(0)
    await input.close()
  }
}
