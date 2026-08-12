import { beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { reconcileBoardSummaries } from '../src/jobs/reconcile.js'

// Reconciliation against DynamoDB Local. Requires `docker compose up -d`.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})

// Three boards: drifted summary, missing summary, correct summary.
const drifted = randomUUID()
const missing = randomUUID()
const correct = randomUUID()

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

async function seedBoard(boardId: string, placements: number, summaryCount: number | null) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `BOARD#${boardId}`, SK: '#META', name: 'B', season: 'FA26', createdAt: new Date().toISOString(),
  }}))
  for (let i = 0; i < placements; i++) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `BOARD#${boardId}`, SK: `ITEM#000${i}#${randomUUID()}`, productId: 'p', x: 0, y: 0, w: 1, h: 1, z: i, version: 0,
    }}))
  }
  if (summaryCount !== null) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `BOARD#${boardId}`, SK: '#SUMMARY', placementCount: summaryCount, lastModified: new Date().toISOString(),
    }}))
  }
}

const summaryCount = async (boardId: string) => (await ddb.send(new GetCommand({
  TableName: TABLE, Key: { PK: `BOARD#${boardId}`, SK: '#SUMMARY' },
}))).Item?.placementCount

beforeAll(async () => {
  await ensureTable()
  await seedBoard(drifted, 3, 99) // summary wrong
  await seedBoard(missing, 1, null) // no summary at all
  await seedBoard(correct, 2, 2) // summary right
})

describe('reconcileBoardSummaries', () => {
  it('repairs drifted and missing summaries, leaves correct ones alone', async () => {
    const discrepancies = await reconcileBoardSummaries()
    const byId = new Map(discrepancies.map(d => [d.boardId, d]))

    // drifted: reported 99 -> 3, and repaired on disk
    expect(byId.get(drifted)).toEqual({ boardId: drifted, expected: 3, found: 99 })
    expect(await summaryCount(drifted)).toBe(3)

    // missing: reported null -> 1, and created on disk
    expect(byId.get(missing)).toEqual({ boardId: missing, expected: 1, found: null })
    expect(await summaryCount(missing)).toBe(1)

    // correct: no discrepancy, untouched
    expect(byId.has(correct)).toBe(false)
    expect(await summaryCount(correct)).toBe(2)
  })
})
