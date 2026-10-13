// Bodies stay in queue once per user; only small delivery obligations are per device.
export function deviceDelivery(db, fail) {
  db.exec(`CREATE TABLE IF NOT EXISTS devices(user_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS device_reads(message_id TEXT NOT NULL,user_id TEXT NOT NULL,read_at INTEGER NOT NULL,PRIMARY KEY(message_id,user_id));
    CREATE TABLE IF NOT EXISTS queue_devices(event_id TEXT NOT NULL,user_id TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(event_id,user_id,device_id));
    CREATE INDEX IF NOT EXISTS queue_device_lookup ON queue_devices(user_id,device_id,event_id);
    CREATE TRIGGER IF NOT EXISTS queue_devices_cleanup AFTER DELETE ON queue BEGIN DELETE FROM queue_devices WHERE event_id=OLD.id AND user_id=OLD.recipient; END;`)
  // Migrate once. Re-running this on every restart would resurrect already ACKed obligations.
  if (!db.prepare("SELECT 1 FROM meta WHERE key='device-delivery-v1'").get()) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec("INSERT OR IGNORE INTO queue_devices SELECT id,recipient,'legacy' FROM queue")
      db.exec("INSERT INTO meta VALUES ('device-delivery-v1','1')")
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const devices = uid => db.prepare('SELECT id FROM devices WHERE user_id=? AND revoked=0').all(uid).map(row => row.id)
  const check = (uid, id) => {
    if (id === 'legacy') {
      if (devices(uid).length) fail(409, '此身份已启用多设备，请升级客户端后连接')
    } else if (!db.prepare('SELECT 1 FROM devices WHERE user_id=? AND id=? AND revoked=0').get(uid,id)) fail(403, '此设备已移除，请在其他设备检查身份设置')
  }
  const register = (uid, id, name) => {
    if (id === 'legacy') { check(uid,id); return }
    if (!/^[a-f0-9-]{36}$/.test(id) || typeof name !== 'string' || !name.trim() || name.length > 80) fail(400,'无效设备信息')
    const existing = db.prepare('SELECT revoked FROM devices WHERE user_id=? AND id=?').get(uid,id)
    if (existing?.revoked) fail(403,'此设备已移除')
    if (!existing && devices(uid).length >= 8) fail(409,'每个身份在本服最多登记 8 台设备，请先移除不再使用的设备')
    const now = Date.now()
    db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,0) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen').run(uid,id,name.trim(),now,now)
    // The first upgraded device adopts undelivered legacy events. New devices do not inherit history.
    db.prepare("UPDATE queue_devices SET device_id=? WHERE user_id=? AND device_id='legacy'").run(id,uid)
  }
  const assign = (eventId, uid, exclude) => {
    const registered = devices(uid)
    const targets = (registered.length ? registered : ['legacy']).filter(id => id !== exclude)
    for (const id of targets) db.prepare('INSERT OR IGNORE INTO queue_devices VALUES (?,?,?)').run(eventId,uid,id)
    if (!targets.length) db.prepare('DELETE FROM queue WHERE id=? AND recipient=?').run(eventId,uid)
  }
  const acknowledge = (id, uid, device, actions) => {
    const exists = db.prepare("SELECT 1 FROM queue_devices d JOIN queue q ON q.id=d.event_id AND q.recipient=d.user_id WHERE d.event_id=? AND d.user_id=? AND d.device_id=? AND (? OR json_extract(q.payload,'$.retraction') IS NULL)").get(id,uid,device,actions?1:0)
    if (!exists) return false
    db.prepare('DELETE FROM queue_devices WHERE event_id=? AND user_id=? AND device_id=?').run(id,uid,device)
    db.prepare('DELETE FROM queue WHERE id=? AND recipient=? AND NOT EXISTS(SELECT 1 FROM queue_devices WHERE event_id=? AND user_id=?)').run(id,uid,id,uid)
    return true
  }
  const list = (uid, current) => db.prepare('SELECT id,name,created_at,last_seen FROM devices WHERE user_id=? AND revoked=0 ORDER BY created_at,id').all(uid).map(row => ({id:row.id,name:row.name,createdAt:row.created_at,lastSeen:row.last_seen,current:row.id===current}))
  const remove = (uid, id, current) => {
    if (id === current) fail(409,'不能移除当前设备')
    if (typeof id !== 'string' || !db.prepare('SELECT 1 FROM devices WHERE user_id=? AND id=? AND revoked=0').get(uid,id)) fail(404,'设备不存在')
    db.prepare('UPDATE devices SET revoked=1 WHERE user_id=? AND id=?').run(uid,id)
    db.prepare('DELETE FROM queue_devices WHERE user_id=? AND device_id=?').run(uid,id)
    db.prepare('DELETE FROM queue WHERE recipient=? AND NOT EXISTS(SELECT 1 FROM queue_devices WHERE event_id=queue.id AND user_id=queue.recipient)').run(uid)
  }
  return { check, register, assign, acknowledge, list, remove,
    markRead(messageId,uid,readAt) {
      if(!db.prepare('SELECT 1 FROM route_recipients WHERE message_id=? AND recipient=?').get(messageId,uid)&&!db.prepare('SELECT 1 FROM message_delivery WHERE message_id=? AND recipient=?').get(messageId,uid))return false
      return Boolean(db.prepare('INSERT OR IGNORE INTO device_reads VALUES (?,?,?)').run(messageId,uid,readAt).changes)
    },
    touch(uid,id) { db.prepare('UPDATE devices SET last_seen=? WHERE user_id=? AND id=?').run(Date.now(),uid,id) },
    pending(uid,id,actions) { return db.prepare("SELECT q.payload FROM queue q JOIN queue_devices d ON d.event_id=q.id AND d.user_id=q.recipient WHERE q.recipient=? AND d.device_id=? AND (? OR json_extract(q.payload,'$.retraction') IS NULL) ORDER BY q.created_at,q.rowid LIMIT 20").iterate(uid,id,actions?1:0) },
  }
}
