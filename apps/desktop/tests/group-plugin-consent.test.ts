import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { directPluginScope, parseGroupPluginPack, type ServerSnapshot } from '@more-than-chat/central-protocol'
import { GroupPluginConsentStore } from '../src/main/group-plugin-consent'
import { groupGameArtifact } from '../../../scripts/fixtures/group-game.mjs'
const dirs:string[]=[]
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true})})
function snapshot():ServerSnapshot {
  const pack=parseGroupPluginPack({id:'gplugin_'+randomUUID(),version:1,displayName:'Game',kind:'declarative',slot:'chat.details',artifact:groupGameArtifact})
  const member={id:'a',displayName:'A',online:true},groupId='grp_'+randomUUID()
  return {status:'connected',address:'http://localhost',serverId:'server-a',mode:'public',userId:'a',displayName:'A',error:null,directory:{self:member,friends:[],requests:[],groups:[{id:groupId,name:'G',ownerId:'a',members:[member]}],plugins:[{groupId,pack,digest:createHash('sha256').update(JSON.stringify(pack)).digest('hex'),submittedBy:'a',status:'approved',revision:0,state:pack.artifact!.program.initial}]}}
}
async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'mtc-consent-'));dirs.push(dir);const s=snapshot(),p=s.directory!.plugins[0]!;return {dir,s,p,store:new GroupPluginConsentStore(dir)}}
it('requires opt-in per device/server/member/group/digest and durably caches the complete verified pack',async()=>{
  const {dir,s,p,store}=await fixture(),args=[s,p.groupId,p.pack.id,p.digest] as const
  expect(await store.get(...args)).toBe('pending')
  await store.set(...args,'declined');expect(await store.get(...args)).toBe('declined')
  await store.set(...args,'loaded');expect(await new GroupPluginConsentStore(dir).get(...args)).toBe('loaded')
  const file=path.join(dir,'group-plugins',(await readdir(path.join(dir,'group-plugins')))[0]!)
  expect(JSON.parse(await readFile(file,'utf8')).pack).toEqual(p.pack)
  const other=structuredClone(s);other.serverId='server-b';expect(await store.get(other,p.groupId,p.pack.id,p.digest)).toBe('pending')
  other.serverId=s.serverId;other.userId='b';other.directory!.groups[0]!.members.push({id:'b',displayName:'B',online:true})
  expect(await store.get(other,p.groupId,p.pack.id,p.digest)).toBe('pending')
  const v2=structuredClone(s),p2=v2.directory!.plugins[0]!;p2.pack.version=2;p2.digest=createHash('sha256').update(JSON.stringify(p2.pack)).digest('hex')
  expect(await store.get(v2,p2.groupId,p2.pack.id,p2.digest)).toBe('pending')
  await store.set(...args,'declined');expect(await new GroupPluginConsentStore(dir).get(...args)).toBe('declined')
})
it('fails closed for pending approvals, stale/tampered content, lost membership and corrupt local files',async()=>{
  const {dir,s,p,store}=await fixture(),args=[s,p.groupId,p.pack.id,p.digest] as const
  p.status='pending';await expect(store.get(...args)).rejects.toThrow();p.status='approved'
  p.pack.artifact!.program.initial.turn=99;await expect(store.get(...args)).rejects.toThrow(/摘要/);p.pack.artifact!.program.initial.turn=0
  s.directory!.groups[0]!.members=[];await expect(store.get(...args)).rejects.toThrow();s.directory!.groups[0]!.members=[s.directory!.self]
  await store.set(...args,'loaded')
  const file=path.join(dir,'group-plugins',(await readdir(path.join(dir,'group-plugins')))[0]!)
  const entry=JSON.parse(await readFile(file,'utf8'));entry.pack.artifact.program.initial.turn=99;await writeFile(file,JSON.stringify(entry))
  await expect(store.get(...args)).rejects.toThrow(/损坏/)
  await writeFile(file,'broken');await expect(store.get(...args)).rejects.toThrow(/不可读/)
})
it('supports executable direct choices and recovery disables code without deleting it or legacy choices',async()=>{
  const {dir,s,p,store}=await fixture()
  await store.set(s,p.groupId,p.pack.id,p.digest,'loaded')
  const userId='usr_'+'a'.repeat(64),peer='usr_'+'b'.repeat(64)
  const client=JSON.parse(await readFile(new URL('../../../examples/shared-tic-tac-toe.mtcplugin',import.meta.url),'utf8'))
  const pack=parseGroupPluginPack({id:'gplugin_'+randomUUID(),version:1,displayName:'Executable',kind:'executable',slot:'chat.details',client})
  const direct=structuredClone(s);direct.userId=userId;direct.directory!.self={id:userId,displayName:'A',online:true};direct.directory!.friends=[{id:peer,displayName:'B',online:true}]
  const item={...p,groupId:directPluginScope(userId,peer),pack,digest:createHash('sha256').update(JSON.stringify(pack)).digest('hex'),submittedBy:peer,state:{}}
  direct.directory!.plugins=[item]
  const args=[direct,item.groupId,item.pack.id,item.digest] as const
  expect(await store.get(...args)).toBe('pending');await store.set(...args,'loaded')
  expect(await new GroupPluginConsentStore(dir).get(...args)).toBe('loaded')
  await store.disableExecutable();expect(await store.get(...args)).toBe('declined')
  expect(await store.get(s,p.groupId,p.pack.id,p.digest)).toBe('loaded')
  const entries=await Promise.all((await readdir(path.join(dir,'group-plugins'))).map(name=>readFile(path.join(dir,'group-plugins',name),'utf8')))
  expect(entries.some(text=>JSON.parse(text).pack?.client?.program.code===client.program.code)).toBe(true)
  direct.directory!.friends=[];await expect(store.get(...args)).rejects.toThrow('成员身份')
})
