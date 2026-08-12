// Phase 3 checkpoint: seed a board with N placements and time GET /api/boards/:id.
// The guide's target is "well under 200ms locally".
//
//   LOCAL=1 pnpm bench          # 200 placements (default)
//   LOCAL=1 N=500 pnpm bench    # override the count
//
// Requires DynamoDB Local running and the table created (pnpm db:create).
// Uses distinct products 1:1 with placements, so N>100 also exercises the
// BatchGet 100-key chunking in getBoardView.

import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { buildServer } from '../src/server.js'

const N = Number(process.env.N ?? 200)
const bid = randomUUID()
const pad = (z: number) => String(z).padStart(4, '0')

const items: Record<string, any>[] = [
  { PK: `BOARD#${bid}`, SK: '#META', name: 'Bench Board', season: 'FA26', createdAt: new Date().toISOString() },
]
for (let i = 0; i < N; i++) {
  const pid = randomUUID()
  const plid = randomUUID()
  items.push({
    PK: `PROD#${pid}`, SK: '#META', style: `S${i}`, name: `Product ${i}`,
    colorway: 'Black', priceCents: 1000 + i, season: 'FA26', asset: null,
  })
  items.push({
    PK: `BOARD#${bid}`, SK: `ITEM#${pad(i)}#${plid}`, productId: pid,
    x: i * 10, y: i * 5, w: 100, h: 120, z: i, version: 0,
  })
}

// BatchWrite caps at 25 items/request and can return UnprocessedItems — retry them.
async function seed(all: Record<string, any>[]) {
  for (let i = 0; i < all.length; i += 25) {
    let req: Record<string, { PutRequest: { Item: Record<string, any> } }[]> = {
      [TABLE]: all.slice(i, i + 25).map(Item => ({ PutRequest: { Item } })),
    }
    for (let attempt = 0; attempt < 5 && Object.keys(req).length; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: req }))
      req = (res.UnprocessedItems && Object.keys(res.UnprocessedItems).length)
        ? (res.UnprocessedItems as typeof req)
        : {}
    }
    if (Object.keys(req).length) throw new Error('BatchWrite left unprocessed items after 5 attempts')
  }
}

await seed(items)
console.log(`seeded board ${bid}: 1 board, ${N} products, ${N} placements`)

const app = buildServer()
async function time() {
  const t0 = performance.now()
  const res = await app.inject({ method: 'GET', url: `/api/boards/${bid}` })
  const ms = performance.now() - t0
  if (res.statusCode !== 200) throw new Error(`unexpected status ${res.statusCode}`)
  const v = res.json()
  return { ms, placements: v.placements.length, products: v.products.length }
}

const warm = await time() // warm-up: JIT, first connection, schema compile
const runs = 10
const samples: number[] = []
for (let i = 0; i < runs; i++) samples.push((await time()).ms)
samples.sort((a, b) => a - b)
const min = samples[0]!
const median = samples[Math.floor(runs / 2)]!
const max = samples[runs - 1]!

console.log(`\nGET /api/boards/:id — ${warm.placements} placements, ${warm.products} products hydrated`)
console.log(`  warm-up : ${warm.ms.toFixed(1)} ms`)
console.log(`  ${runs} runs -> min ${min.toFixed(1)} | median ${median.toFixed(1)} | max ${max.toFixed(1)} ms`)

const pass = median < 200
console.log(pass ? '\n✅ median under the 200ms budget' : '\n❌ median exceeds the 200ms budget')
process.exit(pass ? 0 : 1)
