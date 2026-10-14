import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createCentralServer, publicUserId } from '../src/server.mjs'
import { createMessageReference, MAX_GROUP_MEMBERS, parseDirectory, parseMessageReceipt } from '@more-than-chat/central-protocol'
import { groupGameArtifact } from '../../../scripts/fixtures/group-game.mjs'
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
async function login(f, id, name,features=['message-actions-v1','group-program-v1'],deviceId) {
  const challenge = await request(f, 'challenge', null, {
    publicKey: id.publicKey,
    displayName: name,
    features,
    ...(deviceId?{deviceId,deviceName:'Test PC'}:{}),
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
  it('delivers 256-member group messages with full receipt counts and preserves old-client pending delivery', async () => {
    const f = await fixture()
    const features = ['message-actions-v1', 'group-program-v1', 'large-groups-v1']
    const a = await login(f, identity(), 'Owner', features)
    const b = await login(f, identity(), 'Reader', features)
    const old = await login(f, b, 'Old client')
    const members = [b.userId]
    f.app.db.exec('BEGIN IMMEDIATE')
    try {
      for (let n = 0; n < MAX_GROUP_MEMBERS - 1; n++) {
        const id = 'usr_' + n.toString(16).padStart(64, '0')
        f.app.db.prepare('INSERT INTO users VALUES (?,?,?)').run(id, 'fixture-public-key', `Member ${n}`)
        members.push(id)
      }
      for (const id of members) f.app.db.prepare('INSERT INTO friends VALUES (?,?,?,?)').run(...[a.userId, id].sort(), 'accepted', a.userId)
      f.app.db.exec('COMMIT')
    } catch (error) { f.app.db.exec('ROLLBACK'); throw error }
    const tooMany = await request(f, 'groups', a.token, { name: 'Too large', memberIds: members })
    expect(tooMany.status).toBe(400)
    const group = await request(f, 'groups', a.token, { name: 'Expanded', memberIds: members.slice(0, MAX_GROUP_MEMBERS - 1) })
    expect(group.status).toBe(200)
    const groupId = group.data.groupId
    expect(f.app.db.prepare('SELECT COUNT(*) AS count FROM members WHERE group_id=?').get(groupId).count).toBe(MAX_GROUP_MEMBERS)
    expect((await request(f, 'groups/invite', a.token, { groupId, userId: members.at(-1) })).status).toBe(403)
    const sent = await request(f, 'messages', a.token, { clientMessageId: randomUUID(), targetKind: 'group', targetId: groupId, text: 'expanded group message' })
    expect(sent.status).toBe(200)
    expect(f.app.db.prepare('SELECT COUNT(*) AS count FROM queue WHERE id=?').get(sent.data.messageId).count).toBe(MAX_GROUP_MEMBERS - 1)
    const blocked = await request(f, 'events', old.token)
    expect(blocked.status).toBe(409)
    expect(JSON.stringify(blocked.data)).toContain('手动升级')
    expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=? AND recipient=?').get(sent.data.messageId, b.userId)).toBeDefined()
    const events = await request(f, 'events', b.token)
    expect(parseDirectory(events.data.directory).groups.find(group => group.id === groupId).members).toHaveLength(MAX_GROUP_MEMBERS)
    expect(events.data.events.some(event => event.id === sent.data.messageId)).toBe(true)
    await request(f, 'ack', b.token, { ids: [sent.data.messageId] })
    expect(f.app.db.prepare('SELECT COUNT(*) AS count FROM queue WHERE id=?').get(sent.data.messageId).count).toBe(MAX_GROUP_MEMBERS - 2)
    const ownerEvents = await request(f, 'events', a.token)
    const receipt = ownerEvents.data.events.find(event => event.receipt?.messageId === sent.data.messageId)?.receipt
    expect(parseMessageReceipt(receipt)).toMatchObject({ recipientCount: MAX_GROUP_MEMBERS - 1, deliveredCount: 1, readCount: 0 })
  })
  it('distributes complete authored artifacts only after approval and enforces identity, versions, atomic state and reconnect',async()=>{
    const f=await fixture(),a=await login(f,identity(),'Admin'),b=await login(f,identity(),'Author'),cKey=identity(),c=await login(f,cKey,'Player'),outsider=await login(f,identity(),'Outsider')
    await befriend(f,a,b);await befriend(f,a,c)
    const group=(await request(f,'groups',a.token,{name:'Authored game',memberIds:[b.userId,c.userId]})).data.groupId
    const pack={id:'gplugin_'+randomUUID(),version:1,displayName:'Authored',kind:'declarative',slot:'chat.details',artifact:structuredClone(groupGameArtifact)}
    const submitted=await request(f,'plugins/submit',b.token,{groupId:group,pack});expect(submitted.status).toBe(200)
    const digest=submitted.data.digest,base={groupId:group,pluginId:pack.id,channel:'state',digest}
    const send=(u,action,revision,input={})=>request(f,'plugins/event',u.token,{...base,expectedRevision:revision,payload:{action,input},trace:{actorId:'spoof',digest:'spoof',stateRevision:999}})
    expect((await send(b,'join',0)).status).toBe(403)
    expect((await request(f,'directory',c.token)).data.plugins).toEqual([])
    const review={groupId:group,pluginId:pack.id,version:1,digest,approve:true}
    expect((await request(f,'plugins/review',b.token,review)).status).toBe(403)
    expect((await request(f,'plugins/review',a.token,{...review,digest:'bad'})).status).toBe(409)
    expect((await request(f,'plugins/review',a.token,review)).status).toBe(200)
    const received=(await request(f,'directory',c.token)).data.plugins[0];expect(received.pack.artifact).toEqual(pack.artifact)
    const legacy=await login(f,cKey,'Legacy',['message-actions-v1'])
    expect((await request(f,'directory',legacy.token)).data.plugins).toEqual([])
    expect((await send(outsider,'join',0)).status).toBe(403)
    expect((await send(b,'join',0)).status).toBe(200)
    expect((await send(c,'join',1)).status).toBe(200)
    const traced = (await request(f,'events',b.token)).data.events.find(e=>e.kind==='plugin')
    expect(traced.trace).toMatchObject({actorId:b.userId,packVersion:1,digest,stateRevision:1})
    expect(traced.trace.acceptedAt).toBeGreaterThan(0)
    // The owner is merely a spectator; an event cannot spoof the authenticated actor.
    expect((await send(a,'move',2,{cell:0,actor:b.userId})).status).toBe(400)
    expect((await send(c,'move',2,{cell:0})).status).toBe(400)
    const concurrent=await Promise.all([send(b,'move',2,{cell:0}),send(b,'move',2,{cell:1})])
    expect(concurrent.map(x=>x.status).sort()).toEqual([200,409])
    const current=(await request(f,'directory',b.token)).data.plugins[0]
    expect(current.revision).toBe(3);expect(current.state.board.filter(Boolean)).toHaveLength(1)
    expect((await send(c,'move',3,{cell:current.state.board.indexOf('X')})).status).toBe(400)
    // A new authenticated session restores authoritative state and the full package.
    const reconnected=await login(f,cKey,'Player reconnected')
    expect((await request(f,'directory',reconnected.token)).data.plugins[0]).toEqual(current)
    const next={...pack,version:2,artifact:structuredClone(pack.artifact)};next.artifact.manifest.version='0.2.0'
    expect((await request(f,'plugins/submit',a.token,{groupId:group,pack:next})).status).toBe(403)
    const update=await request(f,'plugins/submit',b.token,{groupId:group,pack:next});expect(update.status).toBe(200)
    expect((await request(f,'plugins/review',a.token,{...review,version:2,digest:update.data.digest})).status).toBe(200)
    expect((await send(b,'move',3,{cell:5})).status).toBe(409)
    const updated=(await request(f,'directory',reconnected.token)).data.plugins[0]
    expect(updated.pack.version).toBe(2);expect(updated.state).toEqual(pack.artifact.program.initial)
    expect((await request(f,'plugins/event',b.token,{...base,digest:update.data.digest,channel:'bypass',payload:{}})).status).toBe(409)
    const broken={...next,id:'gplugin_'+randomUUID(),version:1,artifact:structuredClone(next.artifact)}
    broken.artifact.program.actions.join.guard={op:'exec',args:[]}
    expect((await request(f,'plugins/submit',b.token,{groupId:group,pack:broken})).status).toBe(400)
    const rejected=await request(f,'plugins/submit',b.token,{groupId:group,pack:{...next,version:3}})
    expect((await request(f,'plugins/review',a.token,{...review,version:3,digest:rejected.data.digest,approve:false})).status).toBe(200)
    expect((await request(f,'directory',reconnected.token)).data.plugins[0].pack.version).toBe(2)
    expect((await request(f,'plugins/event',b.token,{...base,digest:update.data.digest,expectedRevision:3,payload:{action:'join',input:{}}})).status).toBe(200)
    await f.app.close()
    f.app=createCentralServer({directory:f.dir,mode:'public',adminToken:f.adminToken})
    f.url='http://127.0.0.1:'+(await f.app.listen(0)).port
    const restored=await login(f,cKey,'Restored')
    const persisted=(await request(f,'directory',restored.token)).data.plugins[0]
    expect(persisted.pack).toEqual(next);expect(persisted.state.players).toEqual([b.userId]);expect(persisted.revision).toBe(4)
  })
  it('synchronizes historical reads after receipt expiry without retaining or re-sending bodies',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),bKey=identity()
    const b1=await login(f,bKey,'B',['message-actions-v1','device-delivery-v1'],randomUUID())
    const b2=await login(f,bKey,'B',['message-actions-v1','device-delivery-v1'],randomUUID())
    await befriend(f,a,b1)
    const sent=await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b1.userId,text:'historical read'})
    const id=sent.data.messageId
    await request(f,'ack',b1.token,{ids:[id]});await request(f,'ack',b2.token,{ids:[id]})
    f.app.db.prepare('DELETE FROM receipts WHERE message_id=?').run(id)
    f.app.db.prepare('DELETE FROM message_delivery WHERE message_id=?').run(id)
    await request(f,'read',b1.token,{ids:[id]})
    const read=(await request(f,'events',b2.token)).data.events.find(e=>e.read?.messageId===id)
    expect(read).toBeTruthy()
    await request(f,'ack',b2.token,{ids:[read.id]})
    await request(f,'read',b1.token,{ids:[id]})
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.read.messageId')=?").get(id).n).toBe(0)
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=?').get(id).n).toBe(0)
  })
  it('adopts legacy pending messages once and refuses ACKs from unassigned or outdated devices',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),original=identity(),b=await login(f,original,'B')
    await befriend(f,a,b)
    const sent=await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'legacy pending before upgrade'})
    const id=sent.data.messageId,d1=randomUUID(),d2=randomUUID()
    const b1=await login(f,original,'B',['message-actions-v1','device-delivery-v1'],d1)
    const b2=await login(f,original,'B',['message-actions-v1','device-delivery-v1'],d2)
    expect(f.app.db.prepare('SELECT device_id FROM queue_devices WHERE event_id=?').all(id).map(r=>r.device_id)).toEqual([d1])
    expect((await request(f,'ack',b.token,{ids:[id]})).status).toBe(409)
    await request(f,'ack',b2.token,{ids:[id]})
    expect(f.app.db.prepare('SELECT delivered_at FROM message_delivery WHERE message_id=?').get(id).delivered_at).toBeNull()
    expect((await request(f,'events',b1.token)).data.events.some(e=>e.id===id)).toBe(true)
    await request(f,'ack',b1.token,{ids:[id]})
    expect(f.app.db.prepare('SELECT COUNT(*) AS n FROM queue WHERE id=?').get(id).n).toBe(0)
    const challenge=await request(f,'challenge',null,{publicKey:original.publicKey,displayName:'B',features:['device-delivery-v1'],deviceId:d2,deviceName:'Second PC'})
    expect(JSON.parse(challenge.data.challenge).deviceId).toBe(d2)
    const forged={...JSON.parse(challenge.data.challenge),deviceId:d1}
    expect((await request(f,'session',null,{challengeId:challenge.data.challengeId,signature:sign(null,Buffer.from(JSON.stringify(forged)),original.privateKey).toString('base64url')})).status).toBe(401)
  })
  it('retains withdrawal notices for temporarily banned original recipients until access is restored',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B')
    await befriend(f,a,b)
    const sent=await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'body-before-ban'})
    await request(f,'ack',b.token,{ids:[sent.data.messageId]})
    await request(f,'admin/access',f.adminToken,{userId:b.userId,allowed:false})
    await request(f,'messages/retract',a.token,{messageId:sent.data.messageId})
    expect(f.app.db.prepare("SELECT 1 FROM queue WHERE recipient=? AND json_extract(payload,'$.retraction.messageId')=?").get(b.userId,sent.data.messageId)).toBeDefined()
    await request(f,'admin/access',f.adminToken,{userId:b.userId,allowed:true})
    const restored=await login(f,b,'B'),events=await request(f,'events',restored.token)
    expect(events.data.events.some(e=>e.retraction?.messageId===sent.data.messageId)).toBe(true)
  })
  it('does not let a legacy client consume or acknowledge an unapplied withdrawal',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B',[])
    await befriend(f,a,b)
    const sent=await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'legacy-visible-body'})
    await request(f,'ack',b.token,{ids:[sent.data.messageId]})
    await request(f,'messages/retract',a.token,{messageId:sent.data.messageId})
    const row=f.app.db.prepare("SELECT id FROM queue WHERE recipient=? AND json_extract(payload,'$.retraction.messageId')=?").get(b.userId,sent.data.messageId)
    await request(f,'ack',b.token,{ids:[row.id]})
    expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=? AND recipient=?').get(row.id,b.userId)).toBeDefined()
    // An ordinary event ensures legacy long-poll returns promptly, but not the withdrawal.
    await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'new-normal-body'})
    expect((await request(f,'events',b.token)).data.events.some(e=>e.retraction)).toBe(false)
    const upgraded=await login(f,b,'B')
    const events=await request(f,'events',upgraded.token)
    expect(events.data.events.some(e=>e.id===row.id&&e.retraction.messageId===sent.data.messageId)).toBe(true)
    await request(f,'ack',upgraded.token,{ids:[row.id]})
    expect(f.app.db.prepare('SELECT 1 FROM queue WHERE id=? AND recipient=?').get(row.id,b.userId)).toBeUndefined()
  })
  it('verifies reply and forward origins after delivered bodies have been purged',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B'),c=await login(f,identity(),'C')
    await befriend(f,a,b);await befriend(f,b,c);await befriend(f,a,c)
    const original={clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'verified-private-origin-8721'}
    const sent=await request(f,'messages',a.token,original),id=sent.data.messageId
    expect(sent.data.receipt.actionsSupported).toBe(true)
    await request(f,'ack',b.token,{ids:[id]})
    expect(JSON.stringify(f.app.db.prepare('SELECT * FROM queue').all())).not.toContain(original.text)
    expect(JSON.stringify(f.app.db.prepare('SELECT * FROM message_routes').all())).not.toContain(original.text)
    const reference=createMessageReference({id,senderId:a.userId,senderName:'A',text:original.text})
    const reply={clientMessageId:randomUUID(),targetKind:'direct',targetId:a.userId,text:'reply-body',quote:reference}
    const replied=await request(f,'messages',b.token,reply)
    expect(replied.status).toBe(200)
    expect((await request(f,'messages',b.token,{...reply,clientMessageId:randomUUID(),quote:{...reference,text:'forged'}})).status).toBe(403)
    expect((await request(f,'messages',c.token,{...reply,clientMessageId:randomUUID()})).status).toBe(403)
    const forwarded={clientMessageId:randomUUID(),targetKind:'direct',targetId:c.userId,text:original.text,forwarded:reference}
    const forwardedResult=await request(f,'messages',b.token,forwarded)
    expect(forwardedResult.status).toBe(200)
    expect((await request(f,'messages',b.token,{...forwarded,clientMessageId:randomUUID(),text:'not-the-original'})).status).toBe(403)
    const retracted=await request(f,'messages/retract',a.token,{messageId:id})
    expect(retracted.status).toBe(200)
    const quotedQueue=f.app.db.prepare('SELECT payload FROM queue WHERE id=?').get(replied.data.messageId)
    expect(JSON.parse(quotedQueue.payload).message.quote).toMatchObject({text:'引用的消息已撤回',retracted:true})
    expect(JSON.parse(f.app.db.prepare('SELECT payload FROM queue WHERE id=?').get(forwardedResult.data.messageId).payload).message.text).toBe(original.text)
    // A request already accepted before withdrawal remains idempotent even if its source changed.
    expect((await request(f,'messages',b.token,reply)).data.messageId).toBe(replied.data.messageId)
    expect((await request(f,'messages',a.token,original)).data.messageId).toBe(id)
    expect((await request(f,'messages',b.token,{...reply,clientMessageId:randomUUID()})).status).toBe(409)
    expect((await request(f,'messages',b.token,{...forwarded,clientMessageId:randomUUID()})).status).toBe(409)
  })
  it('withdraws a partly delivered group durably without sending the original body to offline members',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B'),c=await login(f,identity(),'C')
    await befriend(f,a,b);await befriend(f,a,c)
    const group=(await request(f,'groups',a.token,{name:'Recall group',memberIds:[b.userId,c.userId]})).data.groupId
    const sent=await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'group',targetId:group,text:'must-not-arrive-after-withdrawal'})
    await request(f,'ack',b.token,{ids:[sent.data.messageId]})
    expect((await request(f,'messages/retract',b.token,{messageId:sent.data.messageId})).status).toBe(403)
    await request(f,'groups/transfer',a.token,{groupId:group,userId:b.userId});await request(f,'groups/leave',a.token,{groupId:group})
    const result=await request(f,'messages/retract',a.token,{messageId:sent.data.messageId})
    expect(result.status).toBe(200)
    expect((await request(f,'messages/retract',a.token,{messageId:sent.data.messageId})).data.retraction).toEqual(result.data.retraction)
    expect(JSON.stringify(f.app.db.prepare('SELECT * FROM queue').all())).not.toContain('must-not-arrive-after-withdrawal')
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE json_extract(payload,'$.retraction.messageId')=?").get(sent.data.messageId).n).toBe(3)
    const serverId=f.app.serverId
    await f.app.close();f.app=createCentralServer({directory:f.dir,mode:'public',adminToken:f.adminToken});f.url='http://127.0.0.1:'+(await f.app.listen(0)).port
    expect(f.app.serverId).toBe(serverId)
    const restored=await login(f,c,'C'),events=await request(f,'events',restored.token)
    expect(events.data.events.some(e=>e.retraction?.messageId===sent.data.messageId)).toBe(true)
    expect(events.data.events.some(e=>e.kind==='message'&&e.message.id===sent.data.messageId)).toBe(false)
    await request(f,'ack',restored.token,{ids:events.data.events.map(e=>e.id)})
    expect(f.app.db.prepare("SELECT 1 FROM queue WHERE recipient=? AND json_extract(payload,'$.retraction.messageId')=?").get(c.userId,sent.data.messageId)).toBeUndefined()
  })
  it('enforces the server-side two-minute window and keeps failed withdrawals unchanged',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B')
    await befriend(f,a,b)
    const sent=await request(f,'messages',a.token,{clientMessageId:randomUUID(),targetKind:'direct',targetId:b.userId,text:'expired-but-still-deliverable'})
    f.app.db.prepare('UPDATE message_routes SET created_at=? WHERE message_id=?').run(Date.now()-120001,sent.data.messageId)
    expect((await request(f,'messages/retract',a.token,{messageId:sent.data.messageId})).status).toBe(409)
    expect(JSON.stringify(f.app.db.prepare('SELECT payload FROM queue WHERE id=?').get(sent.data.messageId))).toContain('expired-but-still-deliverable')
  })
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
  it('restarts a partially delivered group without replaying acknowledged bodies or dropping offline recipients',async()=>{
    const f=await fixture(),a=await login(f,identity(),'A'),b=await login(f,identity(),'B'),c=await login(f,identity(),'C')
    await befriend(f,a,b);await befriend(f,a,c)
    const group=(await request(f,'groups',a.token,{name:'Durable group',memberIds:[b.userId,c.userId]})).data.groupId
    for(const user of [a,b,c]){const events=await request(f,'events',user.token);await request(f,'ack',user.token,{ids:events.data.events.map(e=>e.id)})}
    const body={clientMessageId:randomUUID(),targetKind:'group',targetId:group,text:'partial-group-private-body'}
    const sent=await request(f,'messages',a.token,body),id=sent.data.messageId,serverId=f.app.serverId
    expect(sent.data.receipt).toMatchObject({recipientCount:2,deliveredCount:0,readCount:0})
    await request(f,'ack',b.token,{ids:[id]})
    // B's durable ACK removes only B's body; C has not fetched or ACKed it.
    expect(f.app.db.prepare('SELECT recipient FROM queue WHERE id=?').all(id)).toEqual([{recipient:c.userId}])
    await f.app.close()
    f.app=createCentralServer({directory:f.dir,mode:'public',adminToken:f.adminToken})
    f.url='http://127.0.0.1:'+(await f.app.listen(0)).port
    expect(f.app.serverId).toBe(serverId)
    const restoredA=await login(f,a,'A'),restoredB=await login(f,b,'B'),restoredC=await login(f,c,'C')
    const duplicate=await request(f,'messages',restoredA.token,body)
    expect(duplicate.data.messageId).toBe(id)
    expect(f.app.db.prepare('SELECT recipient FROM queue WHERE id=?').all(id)).toEqual([{recipient:c.userId}])
    const events=await request(f,'events',restoredC.token)
    expect(events.data.events.filter(e=>e.message?.id===id)).toHaveLength(1)
    expect(events.data.events.find(e=>e.message?.id===id).message.text).toBe(body.text)
    await request(f,'read',restoredB.token,{ids:[id]})
    await request(f,'ack',restoredC.token,{ids:[id]})
    expect(f.app.db.prepare('SELECT recipient FROM queue WHERE id=?').all(id)).toEqual([])
    const receipt=(await request(f,'directory',restoredA.token)).data.receipts.find(r=>r.messageId===id)
    expect(receipt).toMatchObject({recipientCount:2,deliveredCount:2,readCount:1})
    expect(JSON.stringify(f.app.db.prepare('SELECT * FROM queue').all())+JSON.stringify(f.app.db.prepare('SELECT * FROM receipts').all())+JSON.stringify(f.app.db.prepare('SELECT * FROM message_delivery').all())).not.toContain(body.text)
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
