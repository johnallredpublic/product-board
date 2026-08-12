import { beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { recordBoardMember, listBoardMembers } from '../src/db/members.js'
import { boardMemberSubscribers } from '../src/handlers/notify-consumer.js'

// Board membership + subscriber resolution against DynamoDB Local.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const TENANT = 'dev-tenant'
const boardId = randomUUID()
const alice = randomUUID()
const bob = randomUUID()
const carol = randomUUID()

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
  await recordBoardMember(TENANT, boardId, alice)
  await recordBoardMember(TENANT, boardId, bob)
  await recordBoardMember(TENANT, boardId, carol)
  await recordBoardMember(TENANT, boardId, alice) // idempotent re-visit
})

describe('board members', () => {
  it('records and lists members (idempotent)', async () => {
    const members = await listBoardMembers(TENANT, boardId)
    expect(members.sort()).toEqual([alice, bob, carol].sort())
  })

  it('subscribers are the members minus the actor', async () => {
    const subs = await boardMemberSubscribers({ tenantId: TENANT, boardId, actorUserId: alice })
    expect(subs.map(s => s.userId).sort()).toEqual([bob, carol].sort())
  })

  it('with no actor, everyone is a subscriber', async () => {
    const subs = await boardMemberSubscribers({ tenantId: TENANT, boardId })
    expect(subs).toHaveLength(3)
  })
})
