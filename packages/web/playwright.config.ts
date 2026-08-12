import { defineConfig } from '@playwright/test'

// E2E requires the API (:3000) and DynamoDB Local + MinIO running
// (docker compose up -d, then LOCAL=1 pnpm --filter @assortment/api dev).
// Uses the installed Google Chrome via `channel: 'chrome'` — no browser download.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4200',
    channel: 'chrome',
    headless: true,
  },
  webServer: {
    command: 'pnpm exec ng serve --port 4200',
    url: 'http://localhost:4200',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
