// Seed a fully-populated, listable demo board for local development / the UI demo.
// Creates a board (via the real createBoard, so it appears in GET /api/boards) plus
// a handful of products and placements on it.
//
//   LOCAL=1 pnpm seed:demo

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { createBoard } from '../src/db/boards.js'
import { boardPk, productPk } from '../src/db/keys.js'

// The dev auth fallback resolves an unauthenticated request to this tenant.
const TENANT = process.env.TENANT_ID ?? 'dev-tenant'
const board = await createBoard(TENANT, { name: 'Demo Board', season: 'FA26' })

const names = ['Runner', 'Trainer', 'Hiker', 'Sandal', 'Boot', 'Loafer']
const pad = (z: number) => String(z).padStart(4, '0')

for (let i = 0; i < names.length; i++) {
  const productId = randomUUID()
  const placementId = randomUUID()
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: productPk(productId), SK: '#META', tenantId: TENANT,
    style: `S${i}`, name: names[i], colorway: 'Black', priceCents: 10000 + i * 1000, season: 'FA26', asset: null,
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: boardPk(TENANT, board.id), SK: `ITEM#${pad(i)}#${placementId}`,
    productId, x: 100 + i * 160, y: 120, w: 140, h: 170, z: i, version: 0,
    // GSI1 (pattern 5) so a price edit notifies this board's members (ADR 0019/0020).
    GSI1PK: productPk(productId), GSI1SK: `BOARD#${board.id}`,
  }}))
}

console.log(`seeded demo board: ${board.id} (${names.length} placements)`)
console.log(`open: http://localhost:4200/boards/${board.id}`)
