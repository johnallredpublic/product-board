import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // table.ts reads process.env.LOCAL at import time to pick the DynamoDB Local
    // endpoint — set it here so it's present before any module loads.
    env: { LOCAL: '1', POWERTOOLS_LOG_LEVEL: 'SILENT' },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
