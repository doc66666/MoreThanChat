import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Relay tests deliberately wait up to 6–7 seconds for reconnects; Vitest's
    // 5-second default can abort them before their own bounded assertion deadline.
    testTimeout: 15000,
    // Keep SQLite/encryption integration fixtures from saturating hosted Windows I/O.
    maxWorkers: process.env.CI === 'true' ? 2 : undefined,
  },
})
