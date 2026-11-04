import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSeedState } from '@more-than-chat/chat-core'
import { parseDirectory, parseUserProfileInput } from '@more-than-chat/central-protocol'
import { ChatStore } from '../src/main/chat-store'
import { ClientIdentity } from '../src/main/identity-store'
import { AttachmentStore } from '../src/main/attachments'
import { CentralClient } from '../src/main/central-client'
import { createCentralServer } from '../../central-server/src/server.mjs'

const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() }
async function until(check: () => boolean) { const end = Date.now() + 6000; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)) } throw new Error('Profile synchronization timeout') }

describe('user profile synchronization', () => {
  it('validates profile fields without allowing callers to change another identity', () => {
    const profile = { displayName: ' 林予 ', bio: ' 喜欢做小工具。 ', avatarColor: 0 }
    expect(parseUserProfileInput(profile)).toEqual({ displayName: '林予', bio: '喜欢做小工具。', avatarColor: 0 })
    for (const invalid of [{ ...profile, userId: 'other' }, { ...profile, displayName: ' ' }, { ...profile, bio: 'a'.repeat(161) }, { ...profile, avatarColor: 5 }, { ...profile, avatarColor: 1.5 }, { ...profile, displayName: 'bad\nname' }]) expect(() => parseUserProfileInput(invalid)).toThrow()
    expect(parseUserProfileInput({ ...profile, bio: '', avatarColor: null }).bio).toBe('')
  })

  it('syncs friends and group members, persists restarts, preserves remote edits on login and isolates servers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mtc-profile-')), stores: ChatStore[] = [], clients: CentralClient[] = []
    const config = { directory: path.join(root, 'relay'), mode: 'public', adminToken: 'qa-profile-admin-not-for-production' }
    let relay = createCentralServer(config)
    const other = createCentralServer({ ...config, directory: path.join(root, 'other') })
    let url = 'http://127.0.0.1:' + (await relay.listen(0)).port
    const otherUrl = 'http://127.0.0.1:' + (await other.listen(0)).port
    async function client(name: string, identity?: ClientIdentity) {
      const dir = path.join(root, name), store = await ChatStore.open(dir); stores.push(store); store.save(createSeedState())
      const result = new CentralClient(identity ?? await ClientIdentity.load(dir, cipher), store, new AttachmentStore(path.join(dir, 'files')), dir)
      clients.push(result); return result
    }
    try {
      const a = await client('a'), b = await client('b'), c = await client('c'), second = await client('a-second', a.identity)
      await a.connect(url, '作者'); await b.connect(url, '好友'); await c.connect(url, '同群成员')
      for (const peer of [b, c]) { await a.action('friends/request', { userId: peer.identity.userId }); await peer.action('friends/accept', { userId: a.identity.userId }) }
      await a.action('groups', { name: '共同空间', memberIds: [b.identity.userId, c.identity.userId] })
      const serverId = a.serverId!
      await a.updateProfile(serverId, { displayName: '林予', bio: '一起把想法做成小工具。', avatarColor: 3 })
      await until(() => b.snapshot().directory?.friends.find(m => m.id === a.identity.userId)?.bio === '一起把想法做成小工具。')
      expect(b.store.load()!.conversations.find(item => item.targetId === a.identity.userId)).toMatchObject({ title: '林予', avatarColor: 3 })
      await c.updateProfile(serverId, { displayName: '阿澄', bio: '群里的新朋友', avatarColor: 1 })
      await until(() => b.snapshot().directory?.groups[0]?.members.find(m => m.id === c.identity.userId)?.bio === '群里的新朋友')
      expect(b.snapshot().directory?.friends.some(m => m.id === c.identity.userId)).toBe(false)
      await expect(a.action('profile/update', { displayName: '伪造', bio: '', avatarColor: 0, userId: b.identity.userId })).rejects.toThrow()
      expect(a.snapshot().directory?.self.displayName).toBe('林予')
      await second.connect(url, '过时的昵称', false)
      expect(second.snapshot().directory?.self).toMatchObject({ displayName: '林予', bio: '一起把想法做成小工具。', avatarColor: 3 })
      await second.updateProfile(serverId, { displayName: '林予的新昵称', bio: '', avatarColor: null })
      await until(() => a.snapshot().displayName === '林予的新昵称')
      expect(parseDirectory(a.snapshot().directory).self).toMatchObject({ bio: '', avatarColor: null })
      await a.connect(otherUrl, '私服昵称')
      expect(a.snapshot().directory?.self).toMatchObject({ displayName: '私服昵称', bio: '', avatarColor: null })
      await expect(a.updateProfile(serverId, { displayName: '不能串服', bio: '', avatarColor: 4 })).rejects.toThrow('服务器连接已改变')
      expect(a.snapshot().directory?.self.displayName).toBe('私服昵称')
      for (const item of clients) await item.disconnect(false)
      await relay.close(); relay = createCentralServer(config); url = 'http://127.0.0.1:' + (await relay.listen(0)).port
      // The same loopback host with a new ephemeral port needs an explicit binding in this fixture.
      a.store.rememberServerOrigin(serverId, url)
      await a.connect(url, '过时的本地名字', false)
      expect(a.snapshot().directory?.self).toMatchObject({ displayName: '林予的新昵称', bio: '', avatarColor: null })
      expect(a.snapshot().directory?.friends.find(m => m.id === c.identity.userId)).toMatchObject({ displayName: '阿澄', bio: '群里的新朋友', avatarColor: 1 })
      await a.disconnect()
      await expect(a.updateProfile(serverId, { displayName: '离线', bio: '', avatarColor: 0 })).rejects.toThrow()
    } finally {
      await Promise.all(clients.map(item => item.disconnect(false)))
      await relay.close(); await other.close(); stores.forEach(store => store.close()); await rm(root, { recursive: true, force: true })
    }
  }, 25000)
})
