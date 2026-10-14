import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseGroupPluginPack, pluginScopeMembers, type ServerSnapshot, type GroupPlugin, type GroupPluginPack } from '@more-than-chat/central-protocol'

export type Consent = 'pending' | 'loaded' | 'declined'
export function approvedPlugin(snapshot: ServerSnapshot, groupId: string, pluginId: string, digest: string): GroupPlugin {
  const members=snapshot.directory ? pluginScopeMembers(snapshot.directory,groupId) : []
  const plugin=snapshot.directory?.plugins.find(p=>p.groupId===groupId&&p.pack.id===pluginId&&p.status==='approved'&&p.digest===digest)
  if (snapshot.status!=='connected'||!snapshot.serverId||!members.some(m=>m.id===snapshot.userId)||!plugin) throw new Error('插件版本或会话成员身份已改变，请刷新后重试')
  const pack=parseGroupPluginPack(plugin.pack)
  if (createHash('sha256').update(JSON.stringify(pack)).digest('hex')!==digest) throw new Error('插件内容摘要不匹配，禁止载入')
  return plugin
}
/** Consent is local, durable, profile/server/group/content scoped; updates never inherit it. */
export class GroupPluginConsentStore {
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string) {}
  disableExecutable():Promise<void> {
    const run=this.#tail.catch(()=>undefined).then(async()=>{
      const directory=path.join(this.directory,'group-plugins')
      const files=await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error})
      for(const name of files.filter(name=>/^[a-f0-9]{64}\.json$/.test(name))) {
        const file=path.join(directory,name),entry=await this.#read(file)
        if(entry?.pack?.kind!=='executable'||entry.decision!=='loaded')continue
        await writeFile(file+'.tmp',JSON.stringify({...entry,decision:'declined'}),{encoding:'utf8',mode:0o600})
        await rename(file+'.tmp',file)
      }
    })
    this.#tail=run;return run
  }
  #file(snapshot: ServerSnapshot, groupId: string, pluginId: string): string {
    const key=JSON.stringify([snapshot.userId,snapshot.serverId,groupId,pluginId])
    return path.join(this.directory,'group-plugins',createHash('sha256').update(key).digest('hex')+'.json')
  }
  async #read(file:string): Promise<{digest:string;decision:Consent;pack?:GroupPluginPack}|null> {
    try {
      const value=JSON.parse(await readFile(file,'utf8'))
      if (!value||typeof value!=='object'||Array.isArray(value)) throw new Error('Invalid consent')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') return null
      throw new Error('本机插件授权记录不可读，已阻止载入')
    }
  }
  async get(snapshot:ServerSnapshot, groupId:string, pluginId:string,digest:string):Promise<Consent> {
    approvedPlugin(snapshot,groupId,pluginId,digest)
    await this.#tail.catch(()=>undefined)
    const entry=await this.#read(this.#file(snapshot,groupId,pluginId))
    if (entry?.digest===digest&&entry.decision==='loaded') {
      const cached=parseGroupPluginPack(entry.pack)
      if (createHash('sha256').update(JSON.stringify(cached)).digest('hex')!==digest) throw new Error('本机插件包已损坏，禁止载入')
    }
    return entry?.digest===digest && ['loaded','declined'].includes(entry.decision) ? entry.decision : 'pending'
  }
  set(snapshot:ServerSnapshot,groupId:string,pluginId:string,digest:string,decision:Consent):Promise<void> {
    const plugin=approvedPlugin(snapshot,groupId,pluginId,digest)
    if (!['loaded','declined'].includes(decision)) throw new Error('无效的本机授权选择')
    const run=this.#tail.catch(()=>undefined).then(async()=>{
      const file=this.#file(snapshot,groupId,pluginId),temp=file+'.tmp'
      await mkdir(path.dirname(file),{recursive:true})
      await writeFile(temp,JSON.stringify({digest,decision,...(decision==='loaded'?{pack:plugin.pack}:{})}),{encoding:'utf8',mode:0o600})
      await rename(temp,file)
    })
    this.#tail=run; return run
  }
}
