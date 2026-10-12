import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseGroupPluginPack,
  validUid,
  validateWireAttachment,
} from '@more-than-chat/central-protocol'

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const fail = (status, message) => {
  throw new ApiError(status, message)
}
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fail(400, '无效请求')
const text = (value, max = 200) =>
  typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : fail(400, '无效文本')
export function publicUserId(publicKey) {
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  })
  if (key.asymmetricKeyType !== 'ed25519') fail(400, '身份必须使用 Ed25519')
  return (
    'usr_' +
    createHash('sha256')
      .update(key.export({ format: 'der', type: 'spki' }))
      .digest('hex')
  )
}

export function createCentralServer({
  directory,
  mode = 'private',
  adminToken,
  name = 'MoreThanChat 中心服务器',
  whitelist = [],
  blacklist = [],
}) {
  if (
    !['public', 'private'].includes(mode) ||
    !adminToken ||
    adminToken.length < 24
  )
    throw new Error('Set mode and an admin token of at least 24 characters')
  mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(path.join(directory, 'relay.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,public_key TEXT NOT NULL,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access(id TEXT PRIMARY KEY,allowed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS friends(a TEXT NOT NULL,b TEXT NOT NULL,status TEXT NOT NULL,requester TEXT NOT NULL,PRIMARY KEY(a,b));
    CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(group_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(group_id,user_id));
    CREATE TABLE IF NOT EXISTS group_requests(group_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(group_id,user_id));
    CREATE TABLE IF NOT EXISTS queue(id TEXT NOT NULL,recipient TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,recipient));
    CREATE TABLE IF NOT EXISTS receipts(sender TEXT NOT NULL,client_id TEXT NOT NULL,fingerprint TEXT NOT NULL,message_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(sender,client_id));
    CREATE TABLE IF NOT EXISTS message_delivery(message_id TEXT NOT NULL,recipient TEXT NOT NULL,delivered_at INTEGER,read_at INTEGER,PRIMARY KEY(message_id,recipient));
    CREATE TABLE IF NOT EXISTS plugins(group_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,pack TEXT NOT NULL,digest TEXT NOT NULL,submitter TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(group_id,id,version));`)
  const oldMode = db
    .prepare("SELECT value FROM meta WHERE key='mode'")
    .get()?.value
  if (oldMode && oldMode !== mode) {
    db.close()
    throw new Error('Server mode is immutable for an existing directory')
  }
  db.prepare("INSERT OR IGNORE INTO meta VALUES ('mode',?)").run(mode)
  db.prepare("INSERT OR IGNORE INTO meta VALUES ('revision','0')").run()
  db.exec(`CREATE INDEX IF NOT EXISTS queue_recipient_time ON queue(recipient,created_at);
    CREATE INDEX IF NOT EXISTS queue_receipt ON queue(recipient,json_extract(payload,'$.receipt.messageId')) WHERE json_extract(payload,'$.kind')='directory';
    CREATE UNIQUE INDEX IF NOT EXISTS receipt_message_id ON receipts(message_id);
    CREATE INDEX IF NOT EXISTS receipt_sender_time ON receipts(sender,created_at);`)
  db.exec(`INSERT OR IGNORE INTO message_delivery(message_id,recipient) SELECT id,recipient FROM queue WHERE json_extract(payload,'$.kind')='message';`)
  db.prepare("INSERT OR IGNORE INTO meta VALUES ('id',?)").run(
    'srv_' + randomUUID(),
  )
  const serverId = db
    .prepare("SELECT value FROM meta WHERE key='id'")
    .get().value
  for (const uid of mode === 'private' ? whitelist : blacklist) {
    if (!validUid(uid))
      throw new Error('Access list contains an invalid global user id')
    db.prepare('INSERT OR REPLACE INTO access VALUES (?,?)').run(
      uid,
      mode === 'private' ? 1 : 0,
    )
  }
  const sessions = new Map(),
    challenges = new Map(),
    waiting = new Map(),
    activity = new Map()
  let closed = false
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run()
      db.exec('COMMIT')
      return result
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  const allowed = (uid) =>
    mode === 'private'
      ? db.prepare('SELECT allowed FROM access WHERE id=?').get(uid)
          ?.allowed === 1
      : db.prepare('SELECT allowed FROM access WHERE id=?').get(uid)
          ?.allowed !== 0
  const member = (uid, groupId) => {
    if (
      !db
        .prepare('SELECT 1 FROM members WHERE group_id=? AND user_id=?')
        .get(groupId, uid)
    )
      fail(403, '你不是这个群的成员')
  }
  const owner = (uid, groupId) => {
    member(uid, groupId)
    if (
      db.prepare('SELECT owner FROM groups WHERE id=?').get(groupId)?.owner !==
      uid
    )
      fail(403, '只有群管理员可以审批')
  }
  const user = (uid) => {
    const row = db.prepare('SELECT id,name FROM users WHERE id=?').get(uid)
    return row
      ? {
          id: row.id,
          displayName: row.name,
          online: Date.now() - (activity.get(uid) ?? 0) < 35000,
        }
      : null
  }
  const pair = (a, b) => [a, b].sort()
  const isFriend = (a, b) =>
    db
      .prepare("SELECT 1 FROM friends WHERE a=? AND b=? AND status='accepted'")
      .get(...pair(a, b))
  const ensureGroupCapacity = (uid) => {
    if (
      Number(
        db.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id=?').get(uid)
          .n,
      ) >= 40
    )
      fail(409, '开发版每个用户最多加入 40 个群')
  }
  const wake = (uid) => {
    for (const callback of waiting.get(uid) ?? []) callback()
  }
  const enqueue = (recipients, event) => {
    const payload = JSON.stringify(event)
    if (
      Number(
        db
          .prepare(
            'SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM queue',
          )
          .get().bytes,
      ) +
        Buffer.byteLength(payload) * recipients.length >
      512 * 1024 * 1024
    )
      fail(507, '服务器暂存空间已满')
    for (const uid of new Set(recipients)) {
      if (!allowed(uid)) continue
      db.prepare('INSERT OR IGNORE INTO queue VALUES (?,?,?,?)').run(
        event.id,
        uid,
        payload,
        Date.now(),
      )
    }
  }
  const notify = (recipients) => {
    transaction(() =>
      enqueue(recipients, { id: randomUUID(), kind: 'directory' }),
    )
    for (const uid of recipients) wake(uid)
  }
  const groupUsers = (groupId) => {
    const ids = db
        .prepare('SELECT user_id FROM members WHERE group_id=?')
        .all(groupId)
        .map((row) => row.user_id),
      ownerId = db
        .prepare('SELECT owner FROM groups WHERE id=?')
        .get(groupId)?.owner
    return ownerId && ids.includes(ownerId)
      ? [ownerId, ...ids.filter((id) => id !== ownerId)]
      : ids
  }
  const pluginRows = (groupId) =>
    db
      .prepare('SELECT * FROM plugins WHERE group_id=? ORDER BY version')
      .all(groupId)
      .map((row) => ({
        groupId: row.group_id,
        pack: JSON.parse(row.pack),
        digest: row.digest,
        submittedBy: row.submitter,
        status: row.status,
        revision: row.revision,
        state: JSON.parse(row.state),
      }))
  const receiptFor = (messageId) => {
    const row = db.prepare('SELECT * FROM receipts WHERE message_id=?').get(messageId)
    if (!row) return null
    const counts = db.prepare('SELECT COUNT(*) AS total,COUNT(delivered_at) AS delivered,COUNT(read_at) AS read FROM message_delivery WHERE message_id=?').get(messageId)
    return { messageId,clientMessageId:row.client_id,acceptedAt:row.created_at,recipientCount:counts.total,deliveredCount:counts.delivered,readCount:counts.read }
  }
  const queueReceipt = (messageId) => {
    const sender = db.prepare('SELECT sender FROM receipts WHERE message_id=?').get(messageId)?.sender
    if (!sender) return null
    const receipt = receiptFor(messageId)
    db.prepare("DELETE FROM queue WHERE recipient=? AND json_extract(payload,'$.kind')='directory' AND json_extract(payload,'$.receipt.messageId')=?").run(sender,messageId)
    enqueue([sender],{id:randomUUID(),kind:'directory',receipt})
    return sender
  }
  const directoryFor = (uid) => {
    const friends = db
      .prepare(
        "SELECT a,b FROM friends WHERE (a=? OR b=?) AND status='accepted'",
      )
      .all(uid, uid)
      .map((row) => user(row.a === uid ? row.b : row.a))
      .filter(Boolean)
    const requests = db
      .prepare(
        "SELECT requester FROM friends WHERE (a=? OR b=?) AND status='pending' AND requester!=?",
      )
      .all(uid, uid, uid)
      .map((row) => user(row.requester))
      .filter(Boolean)
    const outgoingRequests=db.prepare("SELECT a,b FROM friends WHERE status='pending' AND requester=?").all(uid).map(row=>user(row.a===uid?row.b:row.a)).filter(Boolean)
    const groups = db
      .prepare(
        'SELECT g.* FROM groups g JOIN members m ON m.group_id=g.id WHERE m.user_id=?',
      )
      .all(uid)
      .map((row) => ({
        id: row.id,
        name: row.name,
        ownerId: row.owner,
        members: groupUsers(row.id).map(user).filter(Boolean),
      }))
    const groupRequests = db
      .prepare(
        'SELECT r.group_id,r.user_id,g.name FROM group_requests r JOIN groups g ON r.group_id=g.id WHERE g.owner=?',
      )
      .all(uid)
      .map((row) => ({
        groupId: row.group_id,
        groupName: row.name,
        user: user(row.user_id),
      }))
      .filter((row) => row.user)
    return {
      revision: Number(db.prepare("SELECT value FROM meta WHERE key='revision'").get().value),
      receipts: db.prepare('SELECT message_id FROM receipts WHERE sender=? ORDER BY created_at DESC LIMIT 200').all(uid).map(row=>receiptFor(row.message_id)),
      self: user(uid),
      friends,
      requests,
      outgoingRequests,
      groups,
      groupRequests,
      plugins: groups.flatMap((group) =>
        pluginRows(group.id).filter(
          (plugin) =>
            plugin.status === 'approved' ||
            plugin.submittedBy === uid ||
            group.ownerId === uid,
        ),
      ),
    }
  }
  const auth = (request) => {
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const entry = sessions.get(token)
    if (!entry || entry.expires < Date.now())
      fail(401, '会话已失效，请重新认证')
    if (!allowed(entry.uid)) fail(403, '此身份不在服务器的访问名单中')
    entry.expires = Date.now() + 30 * 60 * 1000
    activity.set(entry.uid, Date.now())
    return entry.uid
  }
  const json = (response, status, body) => {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(body))
  }
  const body = async (request) => {
    let length = 0
    const chunks = []
    for await (const chunk of request) {
      length += chunk.length
      if (length > 8 * 1024 * 1024) fail(413, '请求太大')
      chunks.push(chunk)
    }
    try {
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (e) {
      if (e instanceof ApiError) throw e
      fail(400, '无效 JSON')
    }
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'),
        route = url.pathname
      if (request.method === 'GET' && route === '/v1/ping')
        return json(response, 200, { protocolVersion: 1, serverId, name, mode, features: ['message-receipts-v1'] })
      if (route === '/v1/admin/access' && request.method === 'POST') {
        const received = Buffer.from(
            (request.headers.authorization ?? '').replace(/^Bearer /, ''),
          ),
          expected = Buffer.from(adminToken)
        if (
          received.length !== expected.length ||
          !timingSafeEqual(received, expected)
        )
          fail(403, '管理员认证失败')
        const data = await body(request)
        if (!validUid(data.userId) || typeof data.allowed !== 'boolean')
          fail(400, '无效名单记录')
        db.prepare('INSERT OR REPLACE INTO access VALUES (?,?)').run(
          data.userId,
          data.allowed ? 1 : 0,
        )
        if (!data.allowed) {
          for (const [token, session] of sessions)
            if (session.uid === data.userId) sessions.delete(token)
          wake(data.userId)
        }
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/challenge' && request.method === 'POST') {
        const data = await body(request),
          publicKey = text(data.publicKey, 200),
          uid = publicUserId(publicKey)
        if (!allowed(uid))
          fail(
            403,
            mode === 'private'
              ? '私服需要管理员先将你的全局 ID 加入白名单'
              : '此全局 ID 已被服务器禁止',
          )
        for (const [id, c] of challenges)
          if (c.expires < Date.now()) challenges.delete(id)
        if (challenges.size > 1000) fail(429, '认证请求过多')
        const challengeId = randomUUID(),
          challenge = JSON.stringify({
            protocolVersion: 1,
            serverId,
            userId: uid,
            nonce: randomBytes(32).toString('base64url'),
          })
        challenges.set(challengeId, {
          challenge,
          publicKey,
          uid,
          name: text(data.displayName, 80),
          expires: Date.now() + 60000,
        })
        return json(response, 200, { challengeId, challenge, userId: uid })
      }
      if (route === '/v1/session' && request.method === 'POST') {
        const data = await body(request),
          challenge = challenges.get(data.challengeId)
        challenges.delete(data.challengeId)
        if (
          !challenge ||
          challenge.expires < Date.now() ||
          !allowed(challenge.uid) ||
          !verify(
            null,
            Buffer.from(challenge.challenge),
            createPublicKey({
              key: Buffer.from(challenge.publicKey, 'base64url'),
              format: 'der',
              type: 'spki',
            }),
            Buffer.from(text(data.signature, 200), 'base64url'),
          )
        )
          fail(401, '身份签名验证失败')
        transaction(()=>db.prepare(
          'INSERT INTO users VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
        ).run(challenge.uid, challenge.publicKey, challenge.name))
        for (const [token, entry] of sessions)
          if (entry.expires < Date.now()) sessions.delete(token)
        if (sessions.size > 4096) fail(429, '服务器在线会话已满')
        const token = randomBytes(32).toString('base64url')
        sessions.set(token, {
          uid: challenge.uid,
          expires: Date.now() + 30 * 60 * 1000,
        })
        activity.set(challenge.uid, Date.now())
        return json(response, 200, {
          token,
          serverId,
          mode,
          directory: directoryFor(challenge.uid),
        })
      }
      const uid = auth(request)
      if (route === '/v1/logout' && request.method === 'POST') {
        sessions.delete(
          (request.headers.authorization ?? '').replace(/^Bearer /, ''),
        )
        activity.delete(uid)
        wake(uid)
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/directory' && request.method === 'GET')
        return json(response, 200, directoryFor(uid))
      if (route === '/v1/users' && request.method === 'GET') {
        const found = user(url.searchParams.get('id'))
        if (!found || !allowed(found.id)) fail(404, '此用户不在当前服务器')
        return json(response, 200, found)
      }
      if (route === '/v1/friends/request' && request.method === 'POST') {
        const data = await body(request)
        if (
          !validUid(data.userId) ||
          data.userId === uid ||
          !user(data.userId) ||
          !allowed(data.userId)
        )
          fail(404, '此用户不在当前服务器')
        const existing = db
          .prepare('SELECT status FROM friends WHERE a=? AND b=?')
          .get(...pair(uid, data.userId))
        if (!existing) {
          for (const id of [uid, data.userId])
            if (
              Number(
                db
                  .prepare('SELECT COUNT(*) AS n FROM friends WHERE a=? OR b=?')
                  .get(id, id).n,
              ) >= 500
            )
              fail(409, '好友或申请数量已达到开发版限制')
          db.prepare("INSERT INTO friends VALUES (?,?,'pending',?)").run(
            ...pair(uid, data.userId),
            uid,
          )
        }
        notify([uid, data.userId])
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/friends/accept' && request.method === 'POST') {
        const data = await body(request),
          row = db
            .prepare('SELECT * FROM friends WHERE a=? AND b=?')
            .get(...pair(uid, text(data.userId)))
        if (!row || row.requester === uid || row.status !== 'pending')
          fail(404, '没有待接受的好友申请')
        db.prepare(
          "UPDATE friends SET status='accepted' WHERE a=? AND b=?",
        ).run(...pair(uid, data.userId))
        notify([uid, data.userId])
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/groups' && request.method === 'POST') {
        const data = await body(request)
        if (
          !Array.isArray(data.memberIds) ||
          data.memberIds.length < 1 ||
          data.memberIds.length > 19 ||
          data.memberIds.some(
            (id) => !validUid(id) || !isFriend(uid, id) || !allowed(id),
          )
        )
          fail(400, '群成员必须是当前服务器的好友，群最多 20 人')
        const groupId = 'grp_' + randomUUID(),
          recipients = [...new Set([uid, ...data.memberIds])]
        for (const id of recipients) ensureGroupCapacity(id)
        transaction(() => {
          db.prepare('INSERT INTO groups VALUES (?,?,?)').run(
            groupId,
            text(data.name, 80),
            uid,
          )
          for (const id of recipients)
            db.prepare('INSERT INTO members VALUES (?,?)').run(groupId, id)
        })
        notify(recipients)
        return json(response, 200, { groupId })
      }
      if (['/v1/friends/reject','/v1/friends/cancel','/v1/friends/remove'].includes(route) && request.method==='POST') {
        const data=await body(request),peer=text(data.userId),row=db.prepare('SELECT * FROM friends WHERE a=? AND b=?').get(...pair(uid,peer))
        if(!validUid(peer)||!row)fail(404,'没有此好友或申请')
        if(route.endsWith('/remove')?row.status!=='accepted':row.status!=='pending'||(route.endsWith('/cancel')?row.requester!==uid:row.requester===uid))fail(403,'不能处理这条申请')
        transaction(()=>db.prepare('DELETE FROM friends WHERE a=? AND b=?').run(...pair(uid,peer)))
        notify([uid,peer])
        return json(response,200,{ok:true})
      }
      if (['/v1/groups/rename','/v1/groups/kick','/v1/groups/transfer','/v1/groups/leave','/v1/groups/dissolve','/v1/groups/reject'].includes(route) && request.method==='POST') {
        const data=await body(request),groupId=text(data.groupId),group=db.prepare('SELECT * FROM groups WHERE id=?').get(groupId)
        if(!group)fail(404,'群已不存在')
        member(uid,groupId)
        const recipients=groupUsers(groupId)
        if(route.endsWith('/leave')) {
          if(group.owner===uid)fail(409,'请先转让群管理员，或解散群聊')
          transaction(()=>db.prepare('DELETE FROM members WHERE group_id=? AND user_id=?').run(groupId,uid))
        } else {
          owner(uid,groupId)
          if(route.endsWith('/rename'))transaction(()=>db.prepare('UPDATE groups SET name=? WHERE id=?').run(text(data.name,80),groupId))
          else if(route.endsWith('/dissolve'))transaction(()=>{
            for(const table of ['plugins','group_requests','members'])db.prepare('DELETE FROM '+table+' WHERE group_id=?').run(groupId)
            db.prepare('DELETE FROM groups WHERE id=?').run(groupId)
          })
          else {
            if(!validUid(data.userId)||data.userId===uid)fail(400,'请选择其他成员')
            if(route.endsWith('/reject')) {
              if(!db.prepare('SELECT 1 FROM group_requests WHERE group_id=? AND user_id=?').get(groupId,data.userId))fail(404,'没有待处理申请')
              transaction(()=>db.prepare('DELETE FROM group_requests WHERE group_id=? AND user_id=?').run(groupId,data.userId))
            } else {
              member(data.userId,groupId)
              if(route.endsWith('/transfer')) { if(!allowed(data.userId))fail(403,'该成员已被服务器禁止');transaction(()=>db.prepare('UPDATE groups SET owner=? WHERE id=?').run(data.userId,groupId)) }
              else transaction(()=>db.prepare('DELETE FROM members WHERE group_id=? AND user_id=?').run(groupId,data.userId))
            }
          }
        }
        notify(recipients)
        return json(response,200,{ok:true})
      }
      if (route === '/v1/groups/join' && request.method === 'POST') {
        const data = await body(request),
          group = db
            .prepare('SELECT * FROM groups WHERE id=?')
            .get(text(data.groupId))
        if (!group) fail(404, '该群不在此服务器')
        if (groupUsers(group.id).includes(uid)) fail(409, '你已在群内')
        if (
          Number(
            db
              .prepare(
                'SELECT COUNT(*) AS n FROM group_requests r JOIN groups g ON g.id=r.group_id WHERE g.owner=?',
              )
              .get(group.owner).n,
          ) >= 200
        )
          fail(409, '群管理员的待处理申请已满')
        db.prepare('INSERT OR IGNORE INTO group_requests VALUES (?,?)').run(
          group.id,
          uid,
        )
        notify([group.owner])
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/groups/accept' && request.method === 'POST') {
        const data = await body(request)
        owner(uid, text(data.groupId))
        ensureGroupCapacity(data.userId)
        if (
          !validUid(data.userId) ||
          !db
            .prepare(
              'SELECT 1 FROM group_requests WHERE group_id=? AND user_id=?',
            )
            .get(data.groupId, data.userId) ||
          !allowed(data.userId) ||
          groupUsers(data.groupId).length >= 20
        )
          fail(403, '无效入群申请')
        transaction(() => {
          db.prepare('INSERT OR IGNORE INTO members VALUES (?,?)').run(
            data.groupId,
            data.userId,
          )
          db.prepare(
            'DELETE FROM group_requests WHERE group_id=? AND user_id=?',
          ).run(data.groupId, data.userId)
        })
        notify(groupUsers(data.groupId))
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/groups/invite' && request.method === 'POST') {
        const data = await body(request)
        owner(uid, text(data.groupId))
        ensureGroupCapacity(data.userId)
        if (
          !validUid(data.userId) ||
          !isFriend(uid, data.userId) ||
          !allowed(data.userId) ||
          groupUsers(data.groupId).length >= 20
        )
          fail(403, '无法邀请该用户')
        db.prepare('INSERT OR IGNORE INTO members VALUES (?,?)').run(
          data.groupId,
          data.userId,
        )
        notify(groupUsers(data.groupId))
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/messages' && request.method === 'POST') {
        const data = await body(request),
          clientId = text(data.clientMessageId, 80),
          targetId = text(data.targetId),
          kind = data.targetKind
        let recipients, conversationId
        if (kind === 'direct') {
          if (
            !validUid(targetId) ||
            !isFriend(uid, targetId) ||
            !allowed(targetId)
          )
            fail(403, '只能给本服好友发送')
          recipients = [targetId]
          conversationId =
            'dm_' +
            createHash('sha256')
              .update(pair(uid, targetId).join(':'))
              .digest('hex')
        } else if (kind === 'group') {
          member(uid, targetId)
          recipients = groupUsers(targetId).filter((id) => id !== uid && allowed(id))
          conversationId = targetId
        } else fail(400, '无效会话')
        if (
          typeof data.text !== 'string' ||
          data.text.length > 100000 ||
          (!data.text.trim() && !data.attachment)
        )
          fail(400, '消息不能为空')
        if (data.attachment) {
          validateWireAttachment(data.attachment)
          const bytes = Buffer.from(data.attachment.data, 'base64')
          if (
            bytes.length !== data.attachment.size ||
            createHash('sha256').update(bytes).digest('hex') !==
              data.attachment.id
          )
            fail(400, '附件校验失败')
        }
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              targetId,
              kind,
              data.text,
              data.attachment ?? null,
            ]),
          )
          .digest('hex')
        const old = db
          .prepare('SELECT * FROM receipts WHERE sender=? AND client_id=?')
          .get(uid, clientId)
        if (old) {
          if (old.fingerprint !== fingerprint)
            fail(409, '同一消息 ID 不可替换内容')
          return json(response, 200, {
            messageId: old.message_id,
            conversationId,
            acceptedAt: old.created_at,
            receipt: receiptFor(old.message_id),
          })
        }
        const now = Date.now(),
          messageId = randomUUID(),
          message = {
            id: messageId,
            clientMessageId: clientId,
            conversationId,
            targetKind: kind,
            targetId,
            senderId: uid,
            senderName: user(uid).displayName,
            text: data.text,
            createdAt: now,
            targetName: kind==='group'?db.prepare('SELECT name FROM groups WHERE id=?').get(targetId).name:user(targetId).displayName,
            ...(data.attachment ? { attachment: data.attachment } : {}),
          }
        transaction(() => {
          enqueue(recipients, { id: messageId, kind: 'message', message })
          db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)').run(
            uid,
            clientId,
            fingerprint,
            messageId,
            now,
          )
          for (const recipient of recipients) db.prepare('INSERT INTO message_delivery(message_id,recipient) VALUES (?,?)').run(messageId,recipient)
        })
        for (const recipient of recipients) wake(recipient)
        return json(response, 200, {
          messageId,
          conversationId,
          acceptedAt: now,
          receipt: receiptFor(messageId),
        })
      }
      if (route === '/v1/plugins/submit' && request.method === 'POST') {
        const data = await body(request)
        member(uid, text(data.groupId))
        const pack = parseGroupPluginPack(data.pack)
        if (
          Number(
            db
              .prepare('SELECT COUNT(*) AS n FROM plugins WHERE group_id=?')
              .get(data.groupId).n,
          ) >= 50
        )
          fail(409, '开发版每群最多保留 50 个插件版本')
        const previous =
          db
            .prepare(
              'SELECT MAX(version) AS version FROM plugins WHERE group_id=? AND id=?',
            )
            .get(data.groupId, pack.id).version ?? 0
        if (pack.version !== previous + 1) fail(409, '插件必须追加下一个版本')
        const serialized = JSON.stringify(pack),
          digest = createHash('sha256').update(serialized).digest('hex')
        db.prepare(
          "INSERT INTO plugins VALUES (?,?,?,?,?,?,'pending',0,'{}')",
        ).run(data.groupId, pack.id, pack.version, serialized, digest, uid)
        notify(groupUsers(data.groupId))
        return json(response, 200, { digest })
      }
      if (route === '/v1/plugins/review' && request.method === 'POST') {
        const data = await body(request)
        owner(uid, text(data.groupId))
        const row = db
          .prepare(
            "SELECT * FROM plugins WHERE group_id=? AND id=? AND version=? AND status='pending'",
          )
          .get(data.groupId, text(data.pluginId), data.version)
        if (
          !row ||
          typeof data.approve !== 'boolean' ||
          row.digest !== data.digest
        )
          fail(409, '待审批版本已改变')
        const pack = JSON.parse(row.pack),
          members = groupUsers(data.groupId)
        const previous = db
          .prepare(
            "SELECT state,revision FROM plugins WHERE group_id=? AND id=? AND status='approved' ORDER BY version DESC LIMIT 1",
          )
          .get(data.groupId, pack.id)
        const previousPack = db
          .prepare(
            "SELECT pack FROM plugins WHERE group_id=? AND id=? AND status='approved' ORDER BY version DESC LIMIT 1",
          )
          .get(data.groupId, pack.id)
        if (previousPack && JSON.parse(previousPack.pack).kind !== pack.kind)
          fail(409, '更新不能改变同步状态类型，请使用新插件 ID')
        const state = previous
          ? JSON.parse(previous.state)
          : pack.kind === 'chain'
            ? { entries: [] }
            : pack.kind === 'tic-tac-toe'
              ? {
                  board: Array(9).fill(null),
                  players: members.slice(0, 2),
                  turn: 0,
                  winner: null,
                }
              : {}
        transaction(() => {
          if (data.approve)
            db.prepare(
              "UPDATE plugins SET status='superseded',state='{}' WHERE group_id=? AND id=? AND status='approved'",
            ).run(data.groupId, pack.id)
          db.prepare(
            'UPDATE plugins SET status=?,state=?,revision=? WHERE group_id=? AND id=? AND version=?',
          ).run(
            data.approve ? 'approved' : 'rejected',
            JSON.stringify(state),
            previous?.revision ?? 0,
            data.groupId,
            pack.id,
            pack.version,
          )
        })
        notify(members)
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/plugins/event' && request.method === 'POST') {
        const data = await body(request)
        member(uid, text(data.groupId))
        const row = db
          .prepare(
            "SELECT * FROM plugins WHERE group_id=? AND id=? AND status='approved' ORDER BY version DESC LIMIT 1",
          )
          .get(data.groupId, text(data.pluginId))
        if (!row) fail(403, '插件尚未获得本群审批')
        const channel = text(data.channel, 80)
        if (JSON.stringify(data.payload ?? null).length > 32000)
          fail(413, '插件事件过大')
        const pack = JSON.parse(row.pack),
          state = JSON.parse(row.state)
        if (channel === 'state') {
          if (data.expectedRevision !== row.revision)
            fail(409, '状态已被其他成员更新，请重试')
          const payload = object(data.payload)
          if (pack.kind === 'chain') {
            const entries = Array.isArray(state.entries) ? state.entries : []
            if (entries.some((entry) => entry.userId === uid))
              fail(409, '你已参与接龙')
            if (entries.length >= 20) fail(409, '接龙已满')
            state.entries = [
              ...entries,
              {
                userId: uid,
                name: user(uid).displayName,
                text: text(payload.text, 120),
              },
            ]
          } else if (pack.kind === 'tic-tac-toe') {
            if (
              state.winner !== null ||
              state.players[state.turn] !== uid ||
              !Number.isInteger(payload.cell) ||
              payload.cell < 0 ||
              payload.cell > 8 ||
              state.board[payload.cell] !== null
            )
              fail(409, '当前不能在此位置落子')
            const mark = state.turn === 0 ? 'X' : 'O'
            state.board[payload.cell] = mark
            for (const [a, b, c] of [
              [0, 1, 2],
              [3, 4, 5],
              [6, 7, 8],
              [0, 3, 6],
              [1, 4, 7],
              [2, 5, 8],
              [0, 4, 8],
              [2, 4, 6],
            ])
              if (
                state.board[a] &&
                state.board[a] === state.board[b] &&
                state.board[b] === state.board[c]
              )
                state.winner = uid
            if (state.winner === null && state.board.every(Boolean))
              state.winner = 'draw'
            state.turn = 1 - state.turn
          } else fail(400, '该插件只接受通道事件')
        }
        const recipients = groupUsers(data.groupId)
        transaction(() => {
          if (channel === 'state')
            db.prepare(
              'UPDATE plugins SET state=?,revision=revision+1 WHERE group_id=? AND id=? AND version=?',
            ).run(JSON.stringify(state), data.groupId, pack.id, pack.version)
          enqueue(recipients, {
            id: randomUUID(),
            kind: 'plugin',
            groupId: data.groupId,
            pluginId: pack.id,
            channel,
            payload: data.payload ?? null,
          })
        })
        for (const recipient of recipients) wake(recipient)
        return json(response, 200, { ok: true })
      }
      if (route === '/v1/events' && request.method === 'GET') {
        const pending = () => {
          const result = []
          let bytes = 0
          for (const row of db
            .prepare(
              'SELECT payload FROM queue WHERE recipient=? ORDER BY created_at,rowid LIMIT 20',
            )
            .iterate(uid)) {
            const payloadBytes = Buffer.byteLength(row.payload)
            if (result.length && bytes + payloadBytes > 12 * 1024 * 1024) break
            bytes += payloadBytes
            result.push(JSON.parse(row.payload))
          }
          return result
        }
        let events = pending()
        if (!events.length)
          await new Promise((resolve) => {
            const finish = () => {
              clearTimeout(timer)
              waiting.get(uid)?.delete(finish)
              if (!waiting.get(uid)?.size) waiting.delete(uid)
              response.off('close', finish)
              resolve()
            }
            const timer = setTimeout(finish, 25000)
            const listeners = waiting.get(uid) ?? new Set()
            listeners.add(finish)
            waiting.set(uid, listeners)
            response.once('close', finish)
          })
        if (closed) return json(response, 503, { error: '服务器关闭' })
        auth(request)
        if (!allowed(uid)) fail(403, '身份已被服务器禁止')
        events = pending()
        return json(response, 200, { events, directory: directoryFor(uid) })
      }
      if (route === '/v1/read' && request.method === 'POST') {
        const data = await body(request)
        if (!Array.isArray(data.ids) || data.ids.length>100 || data.ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))) fail(400,'无效已读确认')
        const senders = new Set()
        transaction(()=>{
          for (const id of new Set(data.ids)) {
            const changed = db.prepare('UPDATE message_delivery SET delivered_at=COALESCE(delivered_at,?),read_at=? WHERE message_id=? AND recipient=? AND read_at IS NULL').run(Date.now(),Date.now(),id,uid)
            db.prepare('DELETE FROM queue WHERE id=? AND recipient=? AND EXISTS(SELECT 1 FROM message_delivery WHERE message_id=? AND recipient=? AND read_at IS NOT NULL)').run(id,uid,id,uid)
            if (changed.changes) { const sender=queueReceipt(id); if(sender)senders.add(sender) }
          }
        })
        for(const sender of senders)wake(sender)
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        return json(response,200,{ok:true})
      }
      if (route === '/v1/ack' && request.method === 'POST') {
        const data = await body(request)
        if (
          !Array.isArray(data.ids) ||
          data.ids.length > 100 ||
          data.ids.some((id) => typeof id !== 'string' || id.length > 80)
        )
          fail(400, '无效确认')
        const senders = new Set()
        transaction(() => {
          const delivered = []
          for (const id of data.ids) {
            const changed = db.prepare('UPDATE message_delivery SET delivered_at=? WHERE message_id=? AND recipient=? AND delivered_at IS NULL').run(Date.now(),id,uid)
            if (changed.changes) delivered.push(id)
            db.prepare('DELETE FROM queue WHERE id=? AND recipient=?').run(
              id,
              uid,
            )
          }
          for(const id of delivered){const sender=queueReceipt(id);if(sender)senders.add(sender)}
          const cutoff=Date.now()-7*24*60*60*1000
          db.prepare("DELETE FROM receipts WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM message_delivery d WHERE d.message_id=receipts.message_id AND (d.delivered_at IS NULL OR d.delivered_at>=? OR d.read_at>=?)) AND message_id NOT IN(SELECT json_extract(payload,'$.receipt.messageId') FROM queue WHERE json_extract(payload,'$.kind')='directory' AND json_extract(payload,'$.receipt.messageId') IS NOT NULL)").run(cutoff,cutoff,cutoff)
          db.prepare('DELETE FROM message_delivery WHERE message_id NOT IN(SELECT message_id FROM receipts)').run()
        })
        for(const sender of senders)wake(sender)
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        return json(response, 200, { ok: true })
      }
      fail(404, '接口不存在')
    } catch (error) {
      json(response, error instanceof ApiError ? error.status : 400, {
        error: error instanceof ApiError ? error.message : '请求无效或操作失败',
      })
    }
  })
  server.requestTimeout = 35000
  server.headersTimeout = 10000
  return {
    server,
    serverId,
    db,
    async listen(port = 8787, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      return server.address()
    },
    async close() {
      closed = true
      for (const callbacks of waiting.values())
        for (const callback of callbacks) callback()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      db.close()
    },
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const token = process.env.MTC_SERVER_ADMIN_TOKEN
  if (!token)
    throw new Error(
      'MTC_SERVER_ADMIN_TOKEN is required (24+ characters); never put it in client settings',
    )
  const app = createCentralServer({
    directory: process.env.MTC_SERVER_DATA_DIR ?? path.resolve('.data/central'),
    mode: process.env.MTC_SERVER_MODE ?? 'private',
    adminToken: token,
    whitelist: (process.env.MTC_SERVER_WHITELIST ?? '')
      .split(',')
      .filter(Boolean),
    blacklist: (process.env.MTC_SERVER_BLACKLIST ?? '')
      .split(',')
      .filter(Boolean),
  })
  const address = await app.listen(
    Number(process.env.MTC_SERVER_PORT ?? 8787),
    process.env.MTC_SERVER_HOST ?? '127.0.0.1',
  )
  console.log(
    JSON.stringify({
      serverId: app.serverId,
      address,
      mode: process.env.MTC_SERVER_MODE ?? 'private',
    }),
  )
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      void app.close().then(() => process.exit(0))
    })
}
