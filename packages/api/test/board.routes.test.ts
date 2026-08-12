import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { buildServer } from '../src/server.js'

// Integration test: drives the real Fastify app in-process (app.inject) against
// DynamoDB Local. Never mock the database — mocked tests pass while your key
// conditions are wrong (guide, Phase 14). Requires `docker compose up -d`.

const raw = new DynamoDBClient({
  endpoint: 'http://localhost:8000',
  region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})

// Fresh ids per run so repeated runs don't collide in the shared table.
const boardId = randomUUID()
const productId = randomUUID()
const placementId = randomUUID()
const SK = `ITEM#0001#${placementId}`

let app: FastifyInstance

async function ensureTable() {
  try {
    await raw.send(new ListTablesCommand({}))
  } catch {
    throw new Error(
      'DynamoDB Local is not reachable at http://localhost:8000 — run `docker compose up -d` from the repo root.',
    )
  }
  try {
    await raw.send(new DescribeTableCommand({ TableName: TABLE }))
  } catch {
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [{
        IndexName: 'GSI1',
        KeySchema: [
          { AttributeName: 'GSI1PK', KeyType: 'HASH' },
          { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }],
    }))
  }
}

beforeAll(async () => {
  await ensureTable()

  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `BOARD#${boardId}`, SK: '#META',
    name: 'FA26 Line Review', season: 'FA26', createdAt: new Date().toISOString(),
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: '#META',
    style: 'AB123', name: 'Runner', colorway: 'Black', priceCents: 12000, season: 'FA26', asset: null,
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `BOARD#${boardId}`, SK, productId,
    x: 0, y: 0, w: 100, h: 120, z: 1, version: 0,
  }}))

  app = buildServer()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('GET /api/boards/:id', () => {
  it('returns the board with its placements and hydrated products', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/boards/${boardId}` })
    expect(res.statusCode).toBe(200)

    const view = res.json()
    expect(view.board.id).toBe(boardId)
    expect(view.placements).toHaveLength(1)
    expect(view.products).toHaveLength(1)
    // placement id round-trips out of the ITEM#<zzzz>#<id> sort key
    expect(view.placements[0].id).toBe(placementId)
    expect(view.products[0].id).toBe(productId)
  })

  it('returns 404 for a board that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/boards/${randomUUID()}` })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('PATCH /api/boards/:id/placements', () => {
  // NOTE: these run in file order (Vitest is sequential within a file). The fresh
  // move bumps version 0 -> 1, which the stale-move test then relies on.

  it('applies a fresh move and bumps the version (optimistic lock)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/boards/${boardId}/placements`,
      payload: { moves: [{ id: placementId, x: 5, y: 6, version: 0 }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)

    const view = (await app.inject({ method: 'GET', url: `/api/boards/${boardId}` })).json()
    const moved = view.placements[0]
    expect(moved.x).toBe(5)
    expect(moved.y).toBe(6)
    expect(moved.version).toBe(1)
  })

  it('rejects a stale move with 409 conflict', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/boards/${boardId}/placements`,
      payload: { moves: [{ id: placementId, x: 9, y: 9, version: 0 }] }, // version is now 1
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('conflict')

    // the rejected write must not have applied
    const view = (await app.inject({ method: 'GET', url: `/api/boards/${boardId}` })).json()
    expect(view.placements[0].x).toBe(5)
    expect(view.placements[0].version).toBe(1)
  })

  it('returns 404 when a move references an unknown placement id', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/boards/${boardId}/placements`,
      payload: { moves: [{ id: randomUUID(), x: 1, y: 1, version: 0 }] },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('rejects a malformed body with 400 validation_failed', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/boards/${boardId}/placements`,
      payload: { moves: [] }, // MovePlacements requires min(1)
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })
})
