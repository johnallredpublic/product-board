import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { boardId } = JSON.parse(
  readFileSync(join(process.cwd(), 'e2e', 'board.json'), 'utf8'),
)

// The a11y list mirrors each tile as a focusable item labelled "<name> at <x>, <y>"
// and moves it with arrow keys — the same debounced persist path as a canvas drag,
// but deterministic (no pixel math). We nudge, let the save flush, reload, and
// confirm the new position survived.
const xOf = (text: string | null) => {
  const m = (text ?? '').match(/at\s+(-?\d+),/)
  if (!m) throw new Error(`could not parse x from "${text}"`)
  return Number(m[1])
}

test('a placement move persists across a reload', async ({ page }) => {
  await page.goto(`/boards/${boardId}`)

  const firstItem = page.locator('[role="listitem"]').first()
  await firstItem.waitFor() // board data loaded
  const before = xOf(await firstItem.textContent())

  // Five ArrowRight nudges = +50 world units (10 each), coalesced by the debounce.
  await firstItem.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')

  // Wait past the 400ms persist debounce + the network write.
  await page.waitForTimeout(1200)
  await page.reload()

  const reloaded = page.locator('[role="listitem"]').first()
  await reloaded.waitFor()
  await expect
    .poll(async () => xOf(await reloaded.textContent()))
    .toBe(before + 50)
})
