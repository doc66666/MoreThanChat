import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { statementCache } from '../src/statement-cache.mjs'

const databases = []
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close() })
function fixture(capacity) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)')
  return { db, cache: statementCache(db, capacity) }
}

it('reuses compiled statements, rebinds parameters and never caches results', () => {
  const { db, cache } = fixture()
  const prepare = vi.spyOn(db, 'prepare')
  for (let i = 0; i < 500; i++) {
    cache.prepare('INSERT INTO items VALUES (?,?)').run(i, `${i} 😀`)
    expect(cache.prepare('SELECT value FROM items WHERE id=?').get(i).value).toBe(`${i} 😀`)
  }
  expect(prepare).toHaveBeenCalledTimes(2)
  const hostile = "'; DROP TABLE items; --"
  cache.prepare('INSERT INTO items VALUES (?,?)').run(501, hostile)
  expect(cache.prepare('SELECT value FROM items WHERE id=?').get(501).value).toBe(hostile)
  expect(cache.snapshot()).toMatchObject({ size: 2, prepared: 2, active: 0 })
})

it('leases overlapping iterators independently, including get of the same SQL', () => {
  const { cache } = fixture()
  const sql = 'SELECT ? AS n UNION ALL SELECT ? AS n'
  const first = cache.prepare(sql).iterate(1, 2)
  expect(first.next().value.n).toBe(1)
  const second = cache.prepare(sql).iterate(3, 4)
  expect(second.next().value.n).toBe(3)
  expect(cache.prepare(sql).get(5, 6).n).toBe(5)
  expect(() => cache.prepare(sql).get(Symbol('invalid binding'), 6)).toThrow()
  expect([...first].map(row => row.n)).toEqual([2])
  expect([...second].map(row => row.n)).toEqual([4])
  expect(cache.snapshot()).toMatchObject({ size: 1, prepared: 4, active: 0 })
})

it('does not carry a previous request parameter into an omitted binding', () => {
  const { cache } = fixture()
  const query = cache.prepare('SELECT ? AS uid, ? AS optional')
  expect(query.get('alice', 'private')).toEqual({ uid: 'alice', optional: 'private' })
  expect(query.get('bob')).toEqual({ uid: 'bob', optional: null })
})

it('returns a leased cursor on break, consumer exception and explicit return', () => {
  const { cache } = fixture()
  const sql = 'SELECT ? AS n UNION ALL SELECT 2 AS n'
  for (const row of cache.prepare(sql).iterate(1)) { expect(row.n).toBe(1); break }
  expect(() => { for (const _ of cache.prepare(sql).iterate(1)) throw new Error('consumer') }).toThrow('consumer')
  const iterator = cache.prepare(sql).iterate(1)
  iterator.next(); iterator.return()
  expect(cache.snapshot()).toMatchObject({ size: 1, prepared: 1, active: 0 })
  expect(cache.prepare(sql).all(3).map(row => row.n)).toEqual([3, 2])
})

it('bounds LRU entries and re-prepares an old wrapper without retaining evicted statements', () => {
  const { cache } = fixture(2)
  const old = cache.prepare('SELECT 1 AS n')
  old.get(); cache.prepare('SELECT 2 AS n').get(); cache.prepare('SELECT 3 AS n').get()
  expect(cache.snapshot()).toMatchObject({ size: 2, capacity: 2, prepared: 3 })
  expect(old.get().n).toBe(1)
  expect(cache.snapshot()).toMatchObject({ size: 2, prepared: 4, active: 0 })
})

it('does not evict an active reader when all slots are leased', () => {
  const { cache } = fixture(1)
  const reader = cache.prepare('SELECT 1 AS n UNION ALL SELECT 2 AS n').iterate()
  reader.next()
  expect(cache.prepare('SELECT 3 AS n').get().n).toBe(3)
  expect(cache.snapshot()).toMatchObject({ size: 1, active: 1 })
  expect([...reader].map(row => row.n)).toEqual([2])
  expect(cache.snapshot().active).toBe(0)
})

it('releases failed executions and sees transaction rollback and schema changes', () => {
  const { db, cache } = fixture()
  const insert = cache.prepare('INSERT INTO items VALUES (?,?)')
  insert.run(1, 'first')
  expect(() => insert.run(1, 'duplicate')).toThrow()
  db.exec('BEGIN')
  insert.run(2, 'rolled back'); db.exec('ROLLBACK')
  insert.run(2, 'retry')
  const query = cache.prepare('SELECT value FROM items ORDER BY id')
  expect(query.all().map(row => row.value)).toEqual(['first', 'retry'])
  db.exec('ALTER TABLE items RENAME TO old_items')
  expect(() => query.all()).toThrow()
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)')
  insert.run(3, 'new table')
  expect(query.all().map(row => row.value)).toEqual(['new table'])
  expect(cache.snapshot().active).toBe(0)
})

it('releases a failed iterator and accepts a new binding afterwards', () => {
  const { db, cache } = fixture()
  db.function('check_value', value => { if (value === 1) throw new Error('injected'); return value })
  const query = cache.prepare('SELECT check_value(?) AS n')
  expect(() => [...query.iterate(1)]).toThrow()
  expect([...query.iterate(2)][0].n).toBe(2)
  expect(cache.snapshot()).toMatchObject({ prepared: 2, active: 0 })
})

it('does not run a write twice when its result conversion fails', () => {
  const { db, cache } = fixture()
  db.exec('CREATE TABLE large_ids(id INTEGER PRIMARY KEY); INSERT INTO large_ids VALUES (9007199254740992)')
  const insert = cache.prepare('INSERT INTO large_ids DEFAULT VALUES RETURNING id')
  // The write can succeed before conversion of its RETURNING row fails.
  expect(() => insert.get()).toThrow()
  expect(db.prepare('SELECT COUNT(*) AS n FROM large_ids').get().n).toBe(2)
  expect(cache.snapshot()).toMatchObject({ size: 0, active: 0 })
})

it('validates prepare-time errors and closes with its database', () => {
  const { db, cache } = fixture()
  expect(() => statementCache(db, 0)).toThrow()
  expect(() => cache.prepare(null)).toThrow()
  expect(() => cache.prepare('SELECT FROM')).toThrow()
  const query = cache.prepare('SELECT 1')
  cache.close()
  expect(db.isOpen).toBe(false)
  expect(cache.snapshot().size).toBe(0)
  expect(() => query.get()).toThrow(/closed/)
  expect(() => cache.prepare('SELECT 1')).toThrow(/closed/)
})
