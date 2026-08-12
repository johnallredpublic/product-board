import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { LOCAL: '1' }, // point db/s3 clients at DynamoDB Local + MinIO
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
