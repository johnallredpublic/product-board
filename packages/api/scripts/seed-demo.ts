// Seed a fully-populated, listable demo board for local development / the UI demo.
// Creates a board (via the real createBoard, so it appears in GET /api/boards) plus
// a handful of products and placements on it.
//
//   LOCAL=1 pnpm seed:demo

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { createBoard } from '../src/db/boards.js'

const board = await createBoard({ name: 'Demo Board', season: 'FA26' })

const names = ['Runner', 'Trainer', 'Hiker', 'Sandal', 'Boot', 'Loafer']
const pad = (z: number) => String(z).padStart(4, '0')

for (let i = 0; i < names.length; i++) {
  const productId = randomUUID()
  const placementId = randomUUID()
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: '#META',
    style: `S${i}`, name: names[i], colorway: 'Black', priceCents: 10000 + i * 1000, season: 'FA26', asset: null,
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `BOARD#${board.id}`, SK: `ITEM#${pad(i)}#${placementId}`,
    productId, x: 100 + i * 160, y: 120, w: 140, h: 170, z: i, version: 0,
  }}))
}

console.log(`seeded demo board: ${board.id} (${names.length} placements)`)
console.log(`open: http://localhost:4200/boards/${board.id}`)
