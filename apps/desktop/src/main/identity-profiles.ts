import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ClientIdentity } from './identity-store'
import type { CredentialCipher } from './credential-store'

const valid = (id: string) => id === 'default' || /^usr_[a-f0-9]{64}$/.test(id)
export function profilePath(root: string, id: string): string {
  if (!valid(id)) throw new Error('无效身份空间')
  return id === 'default' ? root : path.join(root, 'identities', id)
}
export function activeProfile(root: string): string {
  try {
    const id = JSON.parse(readFileSync(path.join(root, 'active-identity.json'), 'utf8')).id
    if (typeof id !== 'string' || !valid(id)) throw new Error('身份空间配置损坏')
    // Never silently generate a replacement identity for a missing restored profile.
    if (id !== 'default') readFileSync(path.join(profilePath(root, id), 'host-private', 'identity-secret.bin'))
    return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { readFileSync(path.join(root, 'active-identity.json')) } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return 'default'
      }
    }
    throw new Error('无法打开选中的身份空间，原数据已保留')
  }
}
export async function selectProfile(root: string, id: string): Promise<void> {
  await readFile(path.join(profilePath(root, id), 'host-private', 'identity-secret.bin'))
  const temporary = path.join(root, 'active-identity.' + randomUUID() + '.tmp')
  await writeFile(temporary, JSON.stringify({ id }), { flag: 'wx', mode: 0o600 })
  await rename(temporary, path.join(root, 'active-identity.json'))
}
export async function listProfiles(root: string, cipher: CredentialCipher): Promise<{ id: string; userId: string }[]> {
  const ids = ['default']
  try { ids.push(...(await readdir(path.join(root, 'identities'))).filter(id => valid(id) && id !== 'default')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const result = []
  for (const id of ids) {
    const directory = path.join(profilePath(root, id), 'host-private')
    try { await readFile(path.join(directory, 'identity-secret.bin')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const identity = await ClientIdentity.load(directory, cipher)
    if (id !== 'default' && identity.userId !== id) throw new Error('身份空间与密钥不匹配')
    result.push({ id, userId: identity.userId })
  }
  return result
}
export async function restoreProfile(root: string, backup: string, password: string, cipher: CredentialCipher): Promise<string> {
  const identity = await ClientIdentity.fromBackup(backup, password)
  const existing = (await listProfiles(root, cipher)).find(item => item.userId === identity.userId)
  if (existing) return existing.id
  const parent = path.join(root, 'identities')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  // Stage separately; interrupted import cannot leave a selected, half-written profile.
  const staged = path.join(parent, '.import-' + randomUUID())
  await identity.persistNew(path.join(staged, 'host-private'), cipher)
  await rename(staged, profilePath(root, identity.userId))
  return identity.userId
}
