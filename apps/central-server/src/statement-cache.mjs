// A database-scoped facade, not a patch to DatabaseSync or its prototype.
// SQL text is application-owned; parameters are always bound by node:sqlite.
// Iterators lease statements until exhausted/returned, so a nested use of the
// same SQL never resets another reader's cursor. No query results are cached.
export function statementCache(database, capacity = 128) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid statement capacity')
  const entries = new Map()
  let prepared = 0, hits = 0, active = 0, closed = false
  const entryFor = sql => {
    if (closed) throw new Error('Statement cache is closed')
    let entry = entries.get(sql)
    if (entry && !entry.busy) {
      hits++
      entries.delete(sql); entries.set(sql, entry)
      return entry
    }
    const statement = database.prepare(sql)
    prepared++
    // Never evict or replace an active cursor. Temporary overlapping readers
    // are uncached and become collectible when their own lease ends.
    if (entry?.busy) return { statement, busy: false }
    if (entries.size === capacity) {
      const idle = [...entries].find(([, value]) => !value.busy)
      if (idle) entries.delete(idle[0])
    }
    entry = { statement, busy: false }
    if (entries.size < capacity) entries.set(sql, entry)
    return entry
  }
  const lease = sql => {
    const entry = entryFor(sql)
    entry.busy = true; active++
    return {
      statement: entry.statement,
      discard() { if (entries.get(sql) === entry) entries.delete(sql) },
      release() { entry.busy = false; active-- },
    }
  }
  const execute = (sql, method, args) => {
    const { statement, discard, release } = lease(sql)
    try { return statement[method](...args) }
    // A failed sqlite3_step can leave an error for the next reset. Drop that
    // statement, preserving the original error; never retry a write implicitly.
    catch (error) { discard(); throw error }
    finally { release() }
  }
  return {
    prepare(sql) {
      if (typeof sql !== 'string') throw new TypeError('SQL must be a string')
      // Keep prepare-time SQL validation, but do not acquire a cursor yet.
      if (!entries.has(sql)) entryFor(sql)
      if (closed) throw new Error('Statement cache is closed')
      return {
        get: (...args) => execute(sql, 'get', args),
        all: (...args) => execute(sql, 'all', args),
        run: (...args) => execute(sql, 'run', args),
        *iterate(...args) {
          const { statement, discard, release } = lease(sql)
          try { yield* statement.iterate(...args) }
          catch (error) { discard(); throw error }
          finally { release() }
        },
      }
    },
    exec(sql) { return database.exec(sql) },
    close() {
      try { database.close() } finally { closed = true; entries.clear() }
    },
    snapshot() { return { size: entries.size, capacity, prepared, hits, active } },
  }
}
