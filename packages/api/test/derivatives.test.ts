import { beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3'
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { AssetRef } from '@assortment/shared'
import { ddb, TABLE } from '../src/db/table.js'
import { BUCKET } from '../src/s3/client.js'
import { processUpload } from '../src/handlers/on-upload.js'

// Integration test for the derivative pipeline (Phase 4 Step 2) against DynamoDB
// Local + MinIO. Requires `docker compose up -d`.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const s3 = new S3Client({
  endpoint: 'http://localhost:9000', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
})

const productId = randomUUID()
const assetId = randomUUID()
const key = `products/${productId}/${assetId}/original`

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

async function ensureBucket() {
  try { await s3.send(new HeadBucketCommand({ Bucket: BUCKET })); return }
  catch { /* create below */ }
  try { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })) }
  catch (e: any) {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(e?.name ?? '')) {
      throw new Error('MinIO not reachable at :9000 — run `docker compose up -d`')
    }
  }
}

beforeAll(async () => {
  await ensureTable()
  await ensureBucket()

  // Seed the product and the pending asset record (as Step 1's upload route would).
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: '#META',
    style: 'AB123', name: 'Runner', colorway: 'Black', priceCents: 12000, season: 'FA26', asset: null,
  }}))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: `ASSET#${assetId}`,
    status: 'pending', key, contentType: 'image/png', createdAt: new Date().toISOString(),
  }}))

  // Upload a real 300x200 original so sharp has something to process.
  const original = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 120, b: 200 } },
  }).png().toBuffer()
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: original, ContentType: 'image/png' }))
})

describe('processUpload (derivative pipeline)', () => {
  it('generates 128 + 512 WebP derivatives, marks the asset ready, and points the product at it', async () => {
    await processUpload(key)

    // Both derivatives exist with the webp content type.
    for (const size of [128, 512]) {
      const head = await s3.send(new HeadObjectCommand({
        Bucket: BUCKET, Key: `products/${productId}/${assetId}/thumb-${size}.webp`,
      }))
      expect(head.$metadata.httpStatusCode).toBe(200)
      expect(head.ContentType).toBe('image/webp')
      expect(head.CacheControl).toContain('immutable')
    }

    // Asset record flipped pending -> ready with the ORIGINAL dimensions.
    const rec = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
    }))).Item
    expect(rec?.status).toBe('ready')
    expect(rec?.width).toBe(300)
    expect(rec?.height).toBe(200)

    // Product now carries a valid AssetRef the board can render.
    const product = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: '#META' },
    }))).Item
    const parsed = AssetRef.safeParse(product?.asset)
    expect(parsed.success).toBe(true)
    expect(product?.asset.assetId).toBe(assetId)
    expect(product?.asset.width).toBe(300)
    expect(product?.asset.height).toBe(200)
    expect(product?.asset.thumb128).toContain(`thumb-128.webp`)
  })

  it('is a no-op-safe reprocess (idempotent): rerunning yields the same ready state', async () => {
    await processUpload(key) // redelivery / manual re-run
    const rec = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
    }))).Item
    expect(rec?.status).toBe('ready')
    expect(rec?.width).toBe(300)
  })
})
