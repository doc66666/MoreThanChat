// Test-only preload used by verify-central-ops --memory-diagnostics.
// No HTTP/inspector port, no heap dumps, no production import or timer that
// forces GC. The private child IPC channel accepts only aggregate sampling.
if (typeof process.send !== 'function' || typeof globalThis.gc !== 'function') {
  throw new Error('Memory probe requires the verification harness and --expose-gc')
}
process.on('message', message => {
  if (message?.type !== 'sample-memory' || !Number.isSafeInteger(message.id)) return
  const before = process.memoryUsage()
  globalThis.gc()
  const after = process.memoryUsage()
  const resources = Object.create(null)
  for (const kind of process.getActiveResourcesInfo()) resources[kind] = (resources[kind] ?? 0) + 1
  process.send({ type: 'memory-sample', id: message.id, before, after, resources })
})
process.channel.unref()
