import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseExecutableClientPackage, type ExecutableClientPackage, type InstalledClientPackage } from '@more-than-chat/plugin-runtime'

export function clientPackageDigest(pack: ExecutableClientPackage): string {
  return createHash('sha256').update(JSON.stringify({manifest: pack.manifest, program: pack.program})).digest('hex')
}

/** Source snapshots only; never imports JS in the kernel. No automatic startup execution. */
export class ClientPluginStore {
  readonly directory: string
  #tail: Promise<unknown> = Promise.resolve()
  constructor(directory: string) { this.directory = path.join(directory, 'client-plugins') }
  async readFile(file: string): Promise<ExecutableClientPackage> {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 700_000) throw new Error('插件文件无效或过大')
    return parseExecutableClientPackage(JSON.parse(await readFile(file, 'utf8')))
  }
  async list(): Promise<InstalledClientPackage[]> {
    await this.#tail
    return this.#read()
  }
  save(pack: ExecutableClientPackage): Promise<InstalledClientPackage> {
    // Snapshot before joining the queue: approval callers must not mutate the input.
    const snapshot = parseExecutableClientPackage(pack)
    const task = this.#tail.then(async () => {
      const installed = await this.#read()
      if (installed.length >= 100 && !installed.some(p => p.manifest.id === snapshot.manifest.id)) throw new Error('本机插件目录已达 100 项')
      const next = {...snapshot, digest: clientPackageDigest(snapshot)}
      const contents = [...installed.filter(p => p.manifest.id !== snapshot.manifest.id), next]
      await mkdir(this.directory, {recursive: true, mode: 0o700})
      if (!(await lstat(this.directory)).isDirectory()) throw new Error('插件目录不可用')
      const temporary = path.join(this.directory, randomUUID() + '.tmp')
      await writeFile(temporary, JSON.stringify(contents), {mode: 0o600, flag: 'wx'})
      await rename(temporary, path.join(this.directory, 'installed.json'))
      return next
    })
    this.#tail = task.catch(() => undefined)
    return task
  }
  async #read(): Promise<InstalledClientPackage[]> {
    try {
      if (!(await lstat(this.directory)).isDirectory()) throw new Error('插件目录不可用')
      const file = path.join(this.directory, 'installed.json'), info = await lstat(file)
      if (!info.isFile() || info.size > 70_000_000) throw new Error('插件索引损坏或过大')
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('插件索引损坏')
      const result = parsed.map(v => {
        const pack = parseExecutableClientPackage({manifest: v.manifest, program: v.program})
        if (v.digest !== clientPackageDigest(pack)) throw new Error('插件内容已被修改；请重新导入确认')
        return {...pack, digest: v.digest as string}
      })
      if (new Set(result.map(p => p.manifest.id)).size !== result.length) throw new Error('插件索引包含重复标识')
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
