import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { boardPk } from '../src/db/keys.js'
import { buildServer } from '../src/server.js'

// Add / remove placements and edit products, end-to-end through the Fastify app
// against DynamoDB Local. Requires `docker compose up -d`.

const raw = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})

const boardId = randomUUID()
const productId = randomUUID()
const otherProductId = randomUUID() // belongs to another tenant

let app: FastifyInstance

async function ensureTable() {
  try { await raw.send(new ListTablesCommand({})) } catch {
    throw new Error('DynamoDB Local not reachable at :8000 — run `docker compose up -d`.')
  }
  try { await raw.send(new DescribeTableCommand({ TableName: TABLE })) } catch {
    await raw.send(new CreateTableCommand({
      TableName: TABLE, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' }, { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [{
        IndexName: 'GSI1',
        KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }],
        Projection: { ProjectionType: 'ALL' },
      }],
    }))
  }
}

beforeAll(async () => {
  await ensureTable()
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: boardPk('dev-tenant', boardId), SK: '#META', tenantId: 'dev-tenant',
    name: 'CRUD Board', season: 'FA26', createdAt: new Date().toISOString(),
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: '#META', tenantId: 'dev-tenant',
    style: 'AB123', name: 'Runner', colorway: 'Black', priceCents: 12000, season: 'FA26', asset: null,
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${otherProductId}`, SK: '#META', tenantId: 'other-tenant',
    style: 'ZZ999', name: 'Secret', colorway: 'Red', priceCents: 9999, season: 'FA26', asset: null,
  }}))
  app = buildServer()
  await app.ready()
})

afterAll(async () => { await app?.close() })

describe('POST /api/boards/:id/placements (add)', () => {
  let createdId: string

  it('adds a product to the board and hydrates it in the view', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/boards/${boardId}/placements`,
      payload: { productId, x: 40, y: 50 },
    })
    expect(res.statusCode).toBe(201)
    const placement = res.json()
    expect(placement.productId).toBe(productId)
    expect(placement.version).toBe(0)
    expect(placement.x).toBe(40)
    createdId = placement.id

    const view = (await app.inject({ method: 'GET', url: `/api/boards/${boardId}` })).json()
    expect(view.placements.map((p: any) => p.id)).toContain(createdId)
    expect(view.products.map((p: any) => p.id)).toContain(productId)
  })

  it('assigns increasing z-order to stacked placements', async () => {
    const a = (await app.inject({ method: 'POST', url: `/api/boards/${boardId}/placements`, payload: { productId, x: 0, y: 0 } })).json()
    const b = (await app.inject({ method: 'POST', url: `/api/boards/${boardId}/placements`, payload: { productId, x: 0, y: 0 } })).json()
    expect(b.z).toBeGreaterThan(a.z)
  })

  it('refuses another tenant\'s product with 404 (BOLA)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/boards/${boardId}/placements`,
      payload: { productId: otherProductId, x: 0, y: 0 },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('refuses adding to another tenant\'s board with 404', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/boards/${boardId}/placements`,
      headers: { 'x-tenant-id': 'someone-else' },
      payload: { productId, x: 0, y: 0 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a malformed body with 400', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/boards/${boardId}/placements`,
      payload: { productId, x: 0 }, // missing y
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })
})

describe('DELETE /api/boards/:id/placements/:pid (remove)', () => {
  it('removes an existing placement', async () => {
    const added = (await app.inject({
      method: 'POST', url: `/api/boards/${boardId}/placements`, payload: { productId, x: 1, y: 1 },
    })).json()

    const del = await app.inject({ method: 'DELETE', url: `/api/boards/${boardId}/placements/${added.id}` })
    expect(del.statusCode).toBe(200)
    expect(del.json().ok).toBe(true)

    const view = (await app.inject({ method: 'GET', url: `/api/boards/${boardId}` })).json()
    expect(view.placements.map((p: any) => p.id)).not.toContain(added.id)
  })

  it('returns 404 for an unknown placement', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/boards/${boardId}/placements/${randomUUID()}` })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /api/products/:id (field-level merge)', () => {
  it('merges only the supplied fields, leaving the rest', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/products/${productId}`, payload: { priceCents: 15000 },
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json()
    expect(updated.priceCents).toBe(15000)
    expect(updated.name).toBe('Runner')       // untouched
    expect(updated.colorway).toBe('Black')     // untouched
  })

  it('updates multiple fields at once', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/products/${productId}`, payload: { name: 'Trail Runner', colorway: 'Grey' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Trail Runner')
    expect(res.json().colorway).toBe('Grey')
    expect(res.json().priceCents).toBe(15000)  // from the previous test, still there
  })

  it('refuses another tenant\'s product with 404', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/products/${productId}`,
      headers: { 'x-tenant-id': 'someone-else' }, payload: { priceCents: 1 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects an empty patch with 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/products/${productId}`, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })
})
