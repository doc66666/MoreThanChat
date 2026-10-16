import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    // These are end-to-end HTTP/SQLite fixtures, not single handler unit tests.
    // A queue case authenticates four devices and performs dozens of durable
    // writes. Hosted Windows runs can exceed Vitest's 5 s default while every
    // assertion succeeds. Keep all assertions and an explicit bounded deadline.
    testTimeout: 15000,
    hookTimeout: 15000,
    maxWorkers: process.env.CI === 'true' ? 2 : undefined,
  },
})
