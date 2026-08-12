import { beforeAll, describe, expect, it } from 'vitest'
import type { DynamoDBRecord } from 'aws-lambda'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { getBoardEvents } from '../src/db/boards.js'
import { boardPk } from '../src/db/keys.js'
import { processRecord, handler } from '../src/handlers/stream-consumer.js'

// Consumer tested as a pure function with synthetic stream records — no AWS stream
// plumbing. Requires DynamoDB Local (`docker compose up -d`).

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const TENANT = 'dev-tenant'
const boardId = randomUUID()
const placementId = randomUUID()
const sk = `ITEM#0001#${placementId}`
const AT = 1_760_000_000_000 // fixed ms so records are deterministic

function makeRecord(opts: {
  seq: string
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE'
  before?: { x: number; y: number }
  after?: { x: number; y: number }
  bad?: boolean
}): DynamoDBRecord {
  const dynamodb: any = {
    SequenceNumber: opts.seq,
    ApproximateCreationDateTime: Math.floor(AT / 1000),
    StreamViewType: 'NEW_AND_OLD_IMAGES',
  }
  if (!opts.bad) dynamodb.Keys = marshall({ PK: boardPk(TENANT, boardId), SK: sk })
  if (opts.before) dynamodb.OldImage = marshall({ PK: boardPk(TENANT, boardId), SK: sk, productId: 'p', ...opts.before, w: 1, h: 1, z: 1, version: 0 })
  if (opts.after) dynamodb.NewImage = marshall({ PK: boardPk(TENANT, boardId), SK: sk, productId: 'p', ...opts.after, w: 1, h: 1, z: 1, version: 1 })
  return { eventID: opts.seq, eventName: opts.eventName, eventSource: 'aws:dynamodb', dynamodb } as DynamoDBRecord
}

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
  // Two real placements so the summary projection has something to count.
  for (let i = 0; i < 2; i++) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: boardPk(TENANT, boardId), SK: `ITEM#000${i}#${randomUUID()}`, productId: 'p', x: 0, y: 0, w: 1, h: 1, z: i, version: 0,
    }}))
  }
})

describe('stream consumer', () => {
  it('writes a change event with before/after for a MODIFY', async () => {
    await processRecord(makeRecord({ seq: 'SEQ-1', eventName: 'MODIFY', before: { x: 0, y: 0 }, after: { x: 5, y: 6 } }))
    const events = await getBoardEvents(TENANT, boardId)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('MODIFY')
    expect(events[0]!.placementId).toBe(placementId)
    expect(events[0]!.before).toEqual({ x: 0, y: 0 })
    expect(events[0]!.after).toEqual({ x: 5, y: 6 })
  })

  it('is idempotent under redelivery (same sequence number → no duplicate)', async () => {
    await processRecord(makeRecord({ seq: 'SEQ-1', eventName: 'MODIFY', before: { x: 0, y: 0 }, after: { x: 5, y: 6 } }))
    const events = await getBoardEvents(TENANT, boardId)
    expect(events).toHaveLength(1) // still one
  })

  it('maintains the #SUMMARY projection (placement count)', async () => {
    const summary = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: boardPk(TENANT, boardId), SK: '#SUMMARY' },
    }))).Item
    expect(summary?.placementCount).toBe(2)
    expect(summary?.lastModified).toBeTruthy()
  })

  it('reports only the failed record in a poison batch', async () => {
    const res = await handler({ Records: [
      makeRecord({ seq: 'SEQ-2', eventName: 'MODIFY', after: { x: 9, y: 9 } }),
      makeRecord({ seq: 'BAD-1', eventName: 'MODIFY', bad: true }), // no Keys -> throws
    ] } as any)
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'BAD-1' }])
    // the good record still landed
    const events = await getBoardEvents(TENANT, boardId)
    expect(events.some(e => e.eventId === 'SEQ-2')).toBe(true)
  })
})
