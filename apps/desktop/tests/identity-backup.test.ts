import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verify, createPublicKey } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientIdentity } from '../src/main/identity-store'
import { activeProfile, profilePath, restoreProfile, listProfiles, selectProfile } from '../src/main/identity-profiles'
import { loadDeviceId } from '../src/main/device-store'

const roots:string[]=[]
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'mtc-identity-'));roots.push(root);return root}
const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from('os:'+s),decrypt:(b:Buffer)=>b.toString().slice(3)}
const password='test-only-long-passphrase'
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
describe('portable identity and isolated profiles',()=>{
  it('round trips the same signing identity with randomized authenticated encryption',async()=>{
    const identity=await ClientIdentity.load(await fixture(),cipher)
    const first=await identity.backup(password),second=await identity.backup(password)
    expect(first).not.toEqual(second);expect(first).not.toContain('PRIVATE KEY');expect(first).not.toContain(identity.userId)
    const restored=await ClientIdentity.fromBackup(first,password)
    expect(restored.userId).toBe(identity.userId)
    expect(verify(null,Buffer.from('challenge'),createPublicKey({key:Buffer.from(identity.publicKey,'base64url'),format:'der',type:'spki'}),Buffer.from(restored.sign('challenge'),'base64url'))).toBe(true)
    await expect(ClientIdentity.fromBackup(first,'wrong-password-long')).rejects.toThrow('无法解锁')
    const corrupt=JSON.parse(first);corrupt.tag=Buffer.alloc(16).toString('base64')
    await expect(ClientIdentity.fromBackup(JSON.stringify(corrupt),password)).rejects.toThrow('无法解锁')
    await expect(identity.backup('short')).rejects.toThrow('12–256')
    await expect(ClientIdentity.fromBackup('x'.repeat(8193),password)).rejects.toThrow('过大')
  },15000)
  it('keeps existing files and secrets isolated, reuses existing imports, and safely switches back',async()=>{
    const root=await fixture(),old=await ClientIdentity.load(path.join(root,'host-private'),cipher)
    const original=await readFile(path.join(root,'host-private','identity-secret.bin'))
    await writeFile(path.join(root,'chat.sqlite'),'existing-data')
    const other=await ClientIdentity.load(await fixture(),cipher),backup=await other.backup(password)
    await expect(restoreProfile(root,backup,'invalid-password-000',cipher)).rejects.toThrow('无法解锁')
    expect(activeProfile(root)).toBe('default')
    const id=await restoreProfile(root,backup,password,cipher)
    expect(id).toBe(other.userId);expect(await listProfiles(root,cipher)).toEqual([{id:'default',userId:old.userId},{id,userId:id}])
    expect(await restoreProfile(root,backup,password,cipher)).toBe(id)
    await selectProfile(root,id);expect(activeProfile(root)).toBe(id)
    await selectProfile(root,'default');expect(activeProfile(root)).toBe('default')
    expect(await readFile(path.join(root,'chat.sqlite'),'utf8')).toBe('existing-data')
    expect(await readFile(path.join(root,'host-private','identity-secret.bin'))).toEqual(original)
    await expect(other.persistNew(path.join(root,'host-private'),cipher)).rejects.toThrow()
    expect(()=>profilePath(root,'../escape')).toThrow('无效')
    expect(await loadDeviceId(root)).not.toBe(await loadDeviceId(profilePath(root,id)))
    const stable=await loadDeviceId(root);expect(await loadDeviceId(root)).toBe(stable)
  },15000)
  it('fails closed on missing selected profiles and unavailable system encryption',async()=>{
    const root=await fixture(),identity=await ClientIdentity.load(path.join(root,'host-private'),cipher)
    const backup=await identity.backup(password)
    await expect(restoreProfile(await fixture(),backup,password,{...cipher,available:()=>false})).rejects.toThrow('加密不可用')
    await writeFile(path.join(root,'active-identity.json'),JSON.stringify({id:'usr_'+'a'.repeat(64)}))
    expect(()=>activeProfile(root)).toThrow('原数据已保留')
  },15000)
})
