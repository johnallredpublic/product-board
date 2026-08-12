import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Seed a fully-populated board using the api package's own seed script (reuses
// existing tooling, no aws-sdk dependency in web), and hand its id to the test.
// Playwright runs with cwd = packages/web.
export default function globalSetup() {
  const out = execSync('pnpm --filter @assortment/api seed:demo', {
    cwd: resolve(process.cwd(), '../..'), // repo root
    encoding: 'utf8',
  })
  const match = out.match(/seeded demo board: ([0-9a-f-]+)/)
  if (!match) throw new Error(`seed:demo did not report a board id:\n${out}`)
  writeFileSync(join(process.cwd(), 'e2e', 'board.json'), JSON.stringify({ boardId: match[1] }))
}
