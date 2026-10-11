import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_ATTACHMENT_BYTES,
  validateWireAttachment,
  type AttachmentRef,
  type WireAttachment,
} from '@more-than-chat/central-protocol'

export class AttachmentStore {
  constructor(readonly directory: string) {}
  async put(
    bytes: Buffer,
    name: string,
    mime: string,
    durationMs?: number,
  ): Promise<AttachmentRef> {
    if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES)
      throw new Error('附件限制为 5 MiB')
    const id = createHash('sha256').update(bytes).digest('hex')
    const ref: AttachmentRef = {
      id,
      name: path.basename(name).slice(0, 200),
      mime: mime.slice(0, 100),
      size: bytes.length,
      ...(durationMs === undefined ? {} : { durationMs }),
    }
    validateWireAttachment({ ...ref, data: bytes.toString('base64') })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = path.join(this.directory, `${id}.${randomUUID()}.tmp`),
      handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path.join(this.directory, id))
    const metadataTemp = path.join(
        this.directory,
        `${id}.${randomUUID()}.json.tmp`,
      ),
      metadata = await open(metadataTemp, 'wx', 0o600)
    try {
      await metadata.writeFile(JSON.stringify(ref))
      await metadata.sync()
    } finally {
      await metadata.close()
    }
    await rename(metadataTemp, path.join(this.directory, id + '.json'))
    if (process.platform !== 'win32') {
      const folder = await open(this.directory, 'r')
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
    }
    return ref
  }
  async receive(wire: WireAttachment): Promise<AttachmentRef> {
    validateWireAttachment(wire)
    const bytes = Buffer.from(wire.data, 'base64')
    if (
      bytes.length !== wire.size ||
      createHash('sha256').update(bytes).digest('hex') !== wire.id
    )
      throw new Error('附件校验失败')
    return this.put(bytes, wire.name, wire.mime, wire.durationMs)
  }
  async read(id: string): Promise<WireAttachment> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效附件标识')
    const ref = JSON.parse(
      await readFile(path.join(this.directory, id + '.json'), 'utf8'),
    ) as AttachmentRef
    const bytes = await readFile(path.join(this.directory, id)),
      wire = { ...ref, data: bytes.toString('base64') }
    validateWireAttachment(wire)
    if (
      bytes.length !== ref.size ||
      createHash('sha256').update(bytes).digest('hex') !== id
    )
      throw new Error('本地附件已损坏')
    return wire
  }
}
