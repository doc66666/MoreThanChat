import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createCentralServer, publicUserId } from '../src/server.mjs'
const fixtures = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.app.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})
const identity = () => {
  const keys = generateKeyPairSync('ed25519'),
    publicKey = keys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url')
  return { ...keys, publicKey, userId: publicUserId(publicKey) }
}
async function fixture(mode = 'public', whitelist = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mtc-relay-')),
    adminToken = 'test-admin-token-not-for-production',
    app = createCentralServer({ directory: dir, mode, adminToken, whitelist }),
    address = await app.listen(0)
  const f = { dir, app, url: 'http://127.0.0.1:' + address.port, adminToken }
  fixtures.push(f)
  return f
}
async function request(f, route, token, body) {
  const r = await fetch(f.url + '/v1/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: r.status, data: await r.json() }
}
async function login(f, id, name) {
  const challenge = await request(f, 'challenge', null, {
    publicKey: id.publicKey,
    displayName: name,
  })
  expect(challenge.status).toBe(200)
  const result = await request(f, 'session', null, {
    challengeId: challenge.data.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.data.challenge),
      id.privateKey,
    ).toString('base64url'),
  })
  expect(result.status).toBe(200)
  return { ...id, token: result.data.token }
}
async function befriend(f, a, b) {
  expect(
    (await request(f, 'friends/request', a.token, { userId: b.userId })).status,
  ).toBe(200)
  expect(
    (await request(f, 'friends/accept', b.token, { userId: a.userId })).status,
  ).toBe(200)
  for (const user of [a, b]) {
    const events = await request(f, 'events', user.token)
    await request(f, 'ack', user.token, {
      ids: events.data.events.map((e) => e.id),
    })
  }
}

describe('central relay contracts', () => {
  it('reports durable delivery and explicit reading without retaining message contents or trusting unrelated users',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B'),c=await login(f,identity(),'C')
    await befriend(f,a,b)
    const sent=await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'receipt-private-body'})
    expect(sent.data.receipt).toMatchObject({recipientCount:1,deliveredCount:0,readCount:0})
    await request(f,'read',c.token,{ids:[sent.data.messageId]})
    await request(f,'ack',a.token,{ids:[sent.data.messageId]})
    expect((await request(f,'directory',a.token)).data.receipts[0].deliveredCount).toBe(0)
    await request(f,'ack',b.token,{ids:[sent.data.messageId]})
    expect((await request(f,'directory',a.token)).data.receipts[0]).toMatchObject({deliveredCount:1,readCount:0})
    await request(f,'read',b.token,{ids:[sent.data.messageId]})
    await request(f,'read',b.token,{ids:[sent.data.messageId]})
    expect((await request(f,'directory',a.token)).data.receipts[0]).toMatchObject({deliveredCount:1,readCount:1})
    expect(JSON.stringify(f.app.db.prepare('SELECT * FROM queue').all())+JSON.stringify(f.app.db.prepare('SELECT * FROM receipts').all())+JSON.stringify(f.app.db.prepare('SELECT * FROM message_delivery').all())).not.toContain('receipt-private-body')
    expect((await request(f,'directory',c.token)).data.receipts).toEqual([])
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.receipt.messageId')=?").get(sent.data.messageId).n).toBe(1)
  })
  it('retains idempotency metadata while a seven-day-old message is still undelivered',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B')
    await befriend(f,a,b)
    const body={clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'long-offline'}
    const sent=await request(f,'messages',a.token,body)
    f.app.db.prepare('UPDATE receipts SET created_at=?').run(Date.now()-10*24*60*60*1000)
    await request(f,'ack',a.token,{ids:[]})
    expect((await request(f,'messages',a.token,body)).data.messageId).toBe(sent.data.messageId)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=?').get(sent.data.messageId).n).toBe(1)
  })
  it('enforces friendship and group administration, while preserving already accepted offline messages',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B'),c=await login(f,identity(),'C')
    await request(f,'friends/request',a.token,{userId:b.userId})
    expect((await request(f,'friends/cancel',b.token,{userId:a.userId})).status).toBe(403)
    expect((await request(f,'friends/reject',b.token,{userId:a.userId})).status).toBe(200)
    await befriend(f,a,b)
    await befriend(f,a,c)
    const group=(await request(f,'groups',a.token,{name:'Original',memberIds:[b.userId]})).data.groupId
    expect((await request(f,'groups/rename',b.token,{groupId:group,name:'Unauthorized'})).status).toBe(403)
    expect((await request(f,'groups/rename',a.token,{groupId:group,name:'Renamed'})).status).toBe(200)
    await request(f,'groups/invite',a.token,{groupId:group,userId:c.userId})
    expect((await request(f,'groups/leave',a.token,{groupId:group})).status).toBe(409)
    await request(f,'groups/transfer',a.token,{groupId:group,userId:b.userId})
    expect((await request(f,'groups/kick',a.token,{groupId:group,userId:c.userId})).status).toBe(403)
    await request(f,'groups/kick',b.token,{groupId:group,userId:c.userId})
    expect((await request(f,'messages',c.token,{clientMessageId:randomUUID(),targetKind:'group',targetId:group,text:'no-access'})).status).toBe(403)
    const pending=(await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'group',targetId:group,text:'accepted-before-dissolve'})).data.messageId
    await request(f,'groups/dissolve',b.token,{groupId:group})
    expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=? AND recipient=?').get(pending,b.userId)).toBeDefined()
    expect((await request(f,'directory',b.token)).data.groups).toEqual([])
    await request(f,'friends/remove',a.token,{userId:b.userId})
    expect((await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'no-longer-friends'})).status).toBe(403)
  })
  it('persists undelivered messages across server restarts and retains a stable server id', async () => {
    const f = await fixture(),
      a = await login(f, identity(), 'A'),
      b = await login(f, identity(), 'B')
    await befriend(f, a, b)
    await request(f, 'messages', a.token, {
      clientMessageId: randomUUID(),
      targetKind: 'direct',
      targetId: b.userId,
      text: 'survive-restart',
    })
    const id = f.app.serverId
    await f.app.close()
    f.app = createCentralServer({
      directory: f.dir,
      mode: 'public',
      adminToken: f.adminToken,
    })
    const address = await f.app.listen(0)
    f.url = 'http://127.0.0.1:' + address.port
    expect(f.app.serverId).toBe(id)
    const restored = await login(f, b, 'B'),
      events = await request(f, 'events', restored.token)
    expect(
      events.data.events.some((e) => e.message?.text === 'survive-restart'),
    ).toBe(true)
    await request(f, 'ack', restored.token, {
      ids: events.data.events.map((e) => e.id),
    })
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.kind')='message'").get().n).toBe(0)
  })
  it('applies public blacklists and keeps each group recipient pending independently', async () => {
    const f = await fixture(),
      a = await login(f, identity(), 'A'),
      b = await login(f, identity(), 'B'),
      c = await login(f, identity(), 'C')
    await befriend(f, a, b)
    await befriend(f, a, c)
    const group = (
      await request(f, 'groups', a.token, {
        name: 'Group',
        memberIds: [b.userId, c.userId],
      })
    ).data.groupId
    for (const client of [a, b, c]) {
      const events = await request(f, 'events', client.token)
      await request(f, 'ack', client.token, {
        ids: events.data.events.map((e) => e.id),
      })
    }
    const result = await request(f, 'messages', a.token, {
      clientMessageId: randomUUID(),
      targetKind: 'group',
      targetId: group,
      text: 'group body',
    })
    await request(f, 'ack', b.token, { ids: [result.data.messageId] })
    expect(
      f.app.db
        .prepare('SELECT recipient FROM queue WHERE id=?')
        .all(result.data.messageId),
    ).toEqual([{ recipient: c.userId }])
    await request(f, 'ack', c.token, { ids: [result.data.messageId] })
    await request(f, 'admin/access', f.adminToken, {
      userId: c.userId,
      allowed: false,
    })
    expect(
      (
        await request(f, 'challenge', null, {
          publicKey: c.publicKey,
          displayName: 'C',
        })
      ).status,
    ).toBe(403)
  })
  it('requires a signed identity and enforces a private whitelist before login', async () => {
    const a = identity(),
      f = await fixture('private')
    expect(
      (
        await request(f, 'challenge', null, {
          publicKey: a.publicKey,
          displayName: 'A',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request(f, 'admin/access', 'wrong', {
          userId: a.userId,
          allowed: true,
        })
      ).status,
    ).toBe(403)
    await request(f, 'admin/access', f.adminToken, {
      userId: a.userId,
      allowed: true,
    })
    const challenge = await request(f, 'challenge', null, {
        publicKey: a.publicKey,
        displayName: 'A',
      }),
      attacker = identity()
    expect(
      (
        await request(f, 'session', null, {
          challengeId: challenge.data.challengeId,
          signature: sign(
            null,
            Buffer.from(challenge.data.challenge),
            attacker.privateKey,
          ).toString('base64url'),
        })
      ).status,
    ).toBe(401)
    const user = await login(f, a, 'A')
    await request(f, 'admin/access', f.adminToken, {
      userId: a.userId,
      allowed: false,
    })
    expect((await request(f, 'directory', user.token)).status).toBe(401)
  })
  it('retains offline payloads until the recipient ACK, deduplicates sends and deletes delivered bodies', async () => {
    const f = await fixture(),
      a = await login(f, identity(), 'A'),
      b = await login(f, identity(), 'B')
    await befriend(f, a, b)
    const body = {
      clientMessageId: randomUUID(),
      targetKind: 'direct',
      targetId: b.userId,
      text: 'private-offline-body',
    }
    const sent = await request(f, 'messages', a.token, body)
    expect(sent.status).toBe(200)
    expect((await request(f, 'messages', a.token, body)).data.messageId).toBe(
      sent.data.messageId,
    )
    expect(
      (await request(f, 'messages', a.token, { ...body, text: 'changed' }))
        .status,
    ).toBe(409)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n).toBe(1)
    const delivered = await request(f, 'events', b.token)
    expect(delivered.data.events[0].message.text).toBe(body.text)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n).toBe(1)
    await request(f, 'ack', a.token, { ids: [sent.data.messageId] })
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n).toBe(1)
    await request(f, 'ack', b.token, { ids: [sent.data.messageId] })
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.kind')='message'").get().n).toBe(0)
    expect(
      JSON.stringify(f.app.db.prepare('SELECT * FROM receipts').all()),
    ).not.toContain(body.text)
    expect((await request(f, 'messages', a.token, body)).data.messageId).toBe(
      sent.data.messageId,
    )
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.kind')='message'").get().n).toBe(0)
  })
  it('isolates servers and refuses unknown users or unapproved plugin traffic', async () => {
    const f = await fixture(),
      other = await fixture(),
      a = await login(f, identity(), 'A'),
      b = await login(other, identity(), 'B')
    expect(
      (await request(f, 'friends/request', a.token, { userId: b.userId }))
        .status,
    ).toBe(404)
    expect(
      (
        await request(f, 'plugins/event', a.token, {
          groupId: 'grp_' + randomUUID(),
          pluginId: 'gplugin_' + randomUUID(),
          channel: 'game',
          payload: {},
        })
      ).status,
    ).toBe(403)
  })
  it('approves immutable group packages and serializes concurrent chain state', async () => {
    const f = await fixture(),
      a = await login(f, identity(), 'A'),
      b = await login(f, identity(), 'B'),
      outsider = await login(f, identity(), 'C')
    await befriend(f, a, b)
    const group = (
      await request(f, 'groups', a.token, {
        name: 'Group',
        memberIds: [b.userId],
      })
    ).data.groupId
    const pack = {
      id: 'gplugin_' + randomUUID(),
      version: 1,
      displayName: 'Chain',
      kind: 'chain',
      slot: 'chat.details',
    }
    const submission = await request(f, 'plugins/submit', b.token, {
      groupId: group,
      pack,
    })
    expect(submission.status).toBe(200)
    const review = {
      groupId: group,
      pluginId: pack.id,
      version: 1,
      digest: submission.data.digest,
      approve: true,
    }
    expect((await request(f, 'plugins/review', b.token, review)).status).toBe(
      403,
    )
    expect(
      (
        await request(f, 'plugins/review', a.token, {
          ...review,
          digest: 'bad',
        })
      ).status,
    ).toBe(409)
    expect((await request(f, 'plugins/review', a.token, review)).status).toBe(
      200,
    )
    expect(
      (await request(f, 'plugins/submit', a.token, { groupId: group, pack }))
        .status,
    ).toBe(409)
    const event = {
      groupId: group,
      pluginId: pack.id,
      channel: 'state',
      payload: { text: 'A joined' },
      expectedRevision: 0,
    }
    expect(
      (await request(f, 'plugins/event', outsider.token, event)).status,
    ).toBe(403)
    expect((await request(f, 'plugins/event', a.token, event)).status).toBe(200)
    expect((await request(f, 'plugins/event', b.token, event)).status).toBe(409)
    expect(
      (
        await request(f, 'plugins/event', b.token, {
          ...event,
          expectedRevision: 1,
          payload: { text: 'B joined' },
        })
      ).status,
    ).toBe(200)
    const directory = (await request(f, 'directory', a.token)).data
    expect(directory.plugins[0].state.entries).toHaveLength(2)
    expect(directory.plugins[0].revision).toBe(2)
    expect(
      (
        await request(f, 'plugins/submit', a.token, {
          groupId: group,
          pack: { ...pack, id: 'gplugin_' + randomUUID(), code: 'execute()' },
        })
      ).status,
    ).toBe(400)
  })
  it('checks game turn ownership and only advances legal moves', async () => {
    const f = await fixture(),
      a = await login(f, identity(), 'A'),
      b = await login(f, identity(), 'B')
    await befriend(f, a, b)
    const group = (
        await request(f, 'groups', a.token, {
          name: 'Game',
          memberIds: [b.userId],
        })
      ).data.groupId,
      pack = {
        id: 'gplugin_' + randomUUID(),
        version: 1,
        displayName: 'Game',
        kind: 'tic-tac-toe',
        slot: 'chat.details',
      }
    const { data } = await request(f, 'plugins/submit', a.token, {
      groupId: group,
      pack,
    })
    await request(f, 'plugins/review', a.token, {
      groupId: group,
      pluginId: pack.id,
      version: 1,
      digest: data.digest,
      approve: true,
    })
    const event = {
      groupId: group,
      pluginId: pack.id,
      channel: 'state',
      payload: { cell: 0 },
      expectedRevision: 0,
    }
    expect((await request(f, 'plugins/event', b.token, event)).status).toBe(409)
    expect((await request(f, 'plugins/event', a.token, event)).status).toBe(200)
    expect(
      (
        await request(f, 'plugins/event', b.token, {
          ...event,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await request(f, 'plugins/event', b.token, {
          ...event,
          expectedRevision: 1,
          payload: { cell: 1 },
        })
      ).status,
    ).toBe(200)
  })
})
