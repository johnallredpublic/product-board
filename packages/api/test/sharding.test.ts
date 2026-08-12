import { beforeAll, describe, expect, it } from 'vitest'
import type { DynamoDBRecord } from 'aws-lambda'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { createBoard, getBoardView } from '../src/db/boards.js'
import { placementPk, shardPks } from '../src/db/sharding.js'
import { boardPk } from '../src/db/keys.js'
import { movePlacements } from '../src/routes/placements.js'
import { processRecord } from '../src/handlers/stream-consumer.js'

// Opt-in write-sharding for a hot board. Requires DynamoDB Local.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const TENANT = 'dev-tenant'
const SHARDS = 4
const N = 16
const pad = (z: number) => String(z).padStart(4, '0')

let boardId: string
const placementIds: string[] = []

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
  const board = await createBoard(TENANT, { name: 'Viral Board', season: 'FA26', shardCount: SHARDS })
  boardId = board.id

  // Seed placements into their shard partitions (as sharded writes would land).
  for (let i = 0; i < N; i++) {
    const id = randomUUID()
    placementIds.push(id)
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: placementPk(TENANT, boardId, id, SHARDS), SK: `ITEM#${pad(i)}#${id}`,
      productId: 'p', x: i, y: i, w: 1, h: 1, z: i, version: 0,
    }}))
  }
})

describe('write-sharding (hot board)', () => {
  it('actually spreads placements across multiple shard partitions', () => {
    const used = new Set(placementIds.map(id => placementPk(TENANT, boardId, id, SHARDS)))
    expect(used.size).toBeGreaterThan(1)
    expect([...used].every(pk => shardPks(TENANT, boardId, SHARDS).includes(pk))).toBe(true)
  })

  it('getBoardView scatter-gathers every placement across shards', async () => {
    const view = await getBoardView(boardId, TENANT)
    expect(view?.placements).toHaveLength(N)
  })

  it('routes a move to the placement’s shard', async () => {
    const id0 = placementIds[0]!
    await movePlacements(TENANT, boardId, [{ sk: `ITEM#0000#${id0}`, x: 99, y: 99, version: 0 }], 'u', SHARDS)
    const view = await getBoardView(boardId, TENANT)
    const moved = view!.placements.find(p => p.id === id0)
    expect(moved).toMatchObject({ x: 99, y: 99, version: 1 })
  })

  it('summary counts across shards (shard-aware projection)', async () => {
    const id0 = placementIds[0]!
    const rec = {
      eventName: 'MODIFY',
      dynamodb: {
        Keys: marshall({ PK: placementPk(TENANT, boardId, id0, SHARDS), SK: `ITEM#0000#${id0}` }),
        NewImage: marshall({ PK: placementPk(TENANT, boardId, id0, SHARDS), SK: `ITEM#0000#${id0}`, productId: 'p', x: 99, y: 99, z: 0, version: 1 }),
        SequenceNumber: 'S1', StreamViewType: 'NEW_AND_OLD_IMAGES',
      },
    } as unknown as DynamoDBRecord
    await processRecord(rec)

    const summary = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: boardPk(TENANT, boardId), SK: '#SUMMARY' },
    }))).Item
    expect(summary?.placementCount).toBe(N)
  })
})
