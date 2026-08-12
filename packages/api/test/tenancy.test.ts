import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { TABLE } from '../src/db/table.js'
import { boardPk, boardShardPk, boardEventsPk, parseBoardPk } from '../src/db/keys.js'
import { buildServer } from '../src/server.js'

// Tenant-in-partition-key isolation (ADR 0020). Two tenants drive the real API; a
// board created by one must be entirely invisible to the other — not by an ownership
// `if`, but because the tenant is baked into the key it's stored under.

const raw = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})

let app: FastifyInstance
const asTenant = (t: string) => ({ 'x-tenant-id': t, 'x-user-id': `${t}-user` })

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
  app = buildServer()
  await app.ready()
})
afterAll(async () => { await app?.close() })

describe('key builder (parseBoardPk round-trips)', () => {
  it('recovers tenant + board from board / shard / events PKs', () => {
    expect(parseBoardPk(boardPk('acme', 'b1'))).toEqual({ tenantId: 'acme', boardId: 'b1' })
    expect(parseBoardPk(boardShardPk('acme', 'b1', 3))).toEqual({ tenantId: 'acme', boardId: 'b1' })
    expect(parseBoardPk(boardEventsPk('acme', 'b1'))).toEqual({ tenantId: 'acme', boardId: 'b1' })
  })

  it('returns null for a non-board PK (e.g. a product)', () => {
    expect(parseBoardPk('PROD#123')).toBeNull()
  })
})

describe('cross-tenant isolation via the API', () => {
  it('a board created by tenant A is invisible to tenant B', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/boards', headers: asTenant('tenant-a'),
      payload: { name: 'A private board', season: 'FA26' },
    })
    expect(created.statusCode).toBe(201)
    const boardId = created.json().id

    // Tenant A sees it.
    expect((await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: asTenant('tenant-a') })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/boards', headers: asTenant('tenant-a') })).json().boards.map((b: any) => b.id)).toContain(boardId)

    // Tenant B cannot read it (404) and cannot see it in their list.
    expect((await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: asTenant('tenant-b') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/boards', headers: asTenant('tenant-b') })).json().boards.map((b: any) => b.id)).not.toContain(boardId)
  })

  it('the board is physically stored under a tenant-scoped partition key', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/boards', headers: asTenant('tenant-a'),
      payload: { name: 'Keyed board', season: 'FA26' },
    })
    const boardId = created.json().id
    // The row exists at TENANT#tenant-a#BOARD#<id>, and NOT at a bare BOARD#<id>.
    const scoped = await raw.send(new (await import('@aws-sdk/client-dynamodb')).GetItemCommand({
      TableName: TABLE, Key: { PK: { S: boardPk('tenant-a', boardId) }, SK: { S: '#META' } },
    }))
    const bare = await raw.send(new (await import('@aws-sdk/client-dynamodb')).GetItemCommand({
      TableName: TABLE, Key: { PK: { S: `BOARD#${boardId}` }, SK: { S: '#META' } },
    }))
    expect(scoped.Item).toBeTruthy()
    expect(bare.Item).toBeFalsy()
  })
})
