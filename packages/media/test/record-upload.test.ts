import { beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import type { AssetUploadRequested } from '@assortment/shared'
import { ddb, TABLE } from '../src/db/table.js'
import { recordUpload } from '../src/record-upload.js'

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const productId = randomUUID()
const assetId = randomUUID()

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

beforeAll(async () => { await ensureTable() })

describe('recordUpload', () => {
  it('writes the pending asset record media owns', async () => {
    const evt: AssetUploadRequested = {
      version: 1, assetId, productId,
      key: `products/${productId}/${assetId}/original`,
      contentType: 'image/png', requestedAt: new Date().toISOString(),
    }
    await recordUpload(evt)

    const rec = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
    }))).Item
    expect(rec?.status).toBe('pending')
    expect(rec?.key).toBe(evt.key)
    expect(rec?.contentType).toBe('image/png')
  })
})
