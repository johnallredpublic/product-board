import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { buildServer } from '../src/server.js'

// Integration test for create + list boards against DynamoDB Local.
// Requires `docker compose up -d`.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
let app: FastifyInstance

async function ensureTable() {
  try { await dynamo.send(new ListTablesCommand({})) }
  catch { throw new Error('DynamoDB Local not reachable at :8000 — run `docker compose up -d`') }
  try { await dynamo.send(new DescribeTableCommand({ TableName: 'assortment' })) }
  catch {
    await dynamo.send(new CreateTableCommand({
      TableName: 'assortment', BillingMode: 'PAY_PER_REQUEST',
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

describe('boards create + list', () => {
  it('creates a board and returns it, then lists it', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/boards', payload: { name: 'FA26 Line Review', season: 'FA26' },
    })
    expect(created.statusCode).toBe(201)
    const board = created.json()
    expect(board.id).toBeTruthy()
    expect(board.name).toBe('FA26 Line Review')
    expect(board.season).toBe('FA26')

    const listed = await app.inject({ method: 'GET', url: '/api/boards' })
    expect(listed.statusCode).toBe(200)
    const ids = listed.json().boards.map((b: any) => b.id)
    expect(ids).toContain(board.id)
  })

  it('rejects an invalid create body with 400 validation_failed', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/boards', payload: { name: '', season: 'FA26' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })
})
