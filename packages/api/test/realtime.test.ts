import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { boardPk } from '../src/db/keys.js'
import { buildServer } from '../src/server.js'

// Real-time broadcast over a listening server (not app.inject — WebSocket needs a
// real upgrade). Uses Node 22's global WebSocket client. Requires DynamoDB Local.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const boardId = randomUUID()
const placementId = randomUUID()
const SK = `ITEM#0001#${placementId}`
let app: FastifyInstance
let port: number

async function ensureTable() {
  try { await dynamo.send(new ListTablesCommand({})) }
  catch { throw new Error('DynamoDB Local not reachable at :8000 — run `docker compose up -d`') }
  try { await dynamo.send(new DescribeTableCommand({ TableName: TABLE })) }
  catch {
    await dynamo.send(new CreateTableCommand({
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
    name: 'RT Board', season: 'FA26', createdAt: new Date().toISOString(),
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: boardPk('dev-tenant', boardId), SK, productId: 'p', x: 0, y: 0, w: 100, h: 120, z: 1, version: 0,
  }}))
  app = buildServer()
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as AddressInfo).port
})

afterAll(async () => { await app?.close() })

describe('real-time collaboration', () => {
  it('broadcasts a move to a subscribed client', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`)
    const delta = new Promise<any>((resolve, reject) => {
      ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)))
      ws.addEventListener('error', () => reject(new Error('ws error')))
      setTimeout(() => reject(new Error('timeout waiting for delta')), 8000)
    })

    await new Promise<void>((r) => ws.addEventListener('open', () => r()))
    ws.send(JSON.stringify({ type: 'subscribe', boardId }))
    await new Promise((r) => setTimeout(r, 250)) // let subscribe register

    const res = await fetch(`http://127.0.0.1:${port}/api/boards/${boardId}/placements`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moves: [{ id: placementId, x: 42, y: 24, version: 0 }] }),
    })
    expect(res.status).toBe(200)

    const msg = await delta
    expect(msg.type).toBe('placements.moved')
    expect(msg.boardId).toBe(boardId)
    expect(msg.moves[0]).toMatchObject({ id: placementId, x: 42, y: 24, version: 1 })
    ws.close()
  })
})
