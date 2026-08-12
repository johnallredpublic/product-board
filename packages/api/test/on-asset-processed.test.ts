import { beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { AssetRef, type AssetProcessed } from '@assortment/shared'
import { ddb, TABLE } from '../src/db/table.js'
import { applyAssetProcessed } from '../src/handlers/on-asset-processed.js'

// The API's side of the media boundary: applying media's AssetProcessed event to
// the product record (which the API owns). Requires DynamoDB Local.

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

beforeAll(async () => {
  await ensureTable()
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: '#META',
    style: 'AB123', name: 'Runner', colorway: 'Black', priceCents: 12000, season: 'FA26', asset: null,
  }}))
})

describe('applyAssetProcessed', () => {
  it('sets a valid AssetRef on the product from the event', async () => {
    const evt: AssetProcessed = {
      version: 1, assetId, productId, width: 300, height: 200,
      derivatives: [
        { size: 128, key: `products/${productId}/${assetId}/thumb-128.webp`, contentType: 'image/webp' },
        { size: 512, key: `products/${productId}/${assetId}/thumb-512.webp`, contentType: 'image/webp' },
      ],
    }
    await applyAssetProcessed(evt)

    const product = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: '#META' },
    }))).Item

    expect(AssetRef.safeParse(product?.asset).success).toBe(true)
    expect(product?.asset.assetId).toBe(assetId)
    expect(product?.asset.width).toBe(300)
    expect(product?.asset.thumb128).toContain('thumb-128.webp')
  })
})
