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
import { AssetProcessed } from '@assortment/shared'
import { ddb, TABLE } from '../src/db/table.js'
import { BUCKET } from '../src/s3/client.js'
import { processUpload } from '../src/process.js'

// Media's derivative pipeline against DynamoDB Local + MinIO. `publish` is injected
// so we assert the emitted event without a live bus. Requires `docker compose up -d`.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const s3 = new S3Client({
  endpoint: 'http://localhost:9000', region: 'us-west-2', forcePathStyle: true,
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
  // Product owned by the API; media must NOT touch it.
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: '#META',
    style: 'AB123', name: 'Runner', colorway: 'Black', priceCents: 12000, season: 'FA26', asset: null,
  }}))
  // Pending asset record (as recordUpload would have written).
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: `ASSET#${assetId}`, status: 'pending', key, contentType: 'image/png', createdAt: new Date().toISOString(),
  }}))
  const original = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 120, b: 200 } },
  }).png().toBuffer()
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: original, ContentType: 'image/png' }))
})

describe('processUpload', () => {
  it('generates derivatives, marks the asset ready, emits AssetProcessed, and leaves the product untouched', async () => {
    const emitted: { type: string; detail: any }[] = []
    await processUpload(key, async (type, detail) => { emitted.push({ type, detail }) })

    for (const size of [128, 512]) {
      const head = await s3.send(new HeadObjectCommand({
        Bucket: BUCKET, Key: `products/${productId}/${assetId}/thumb-${size}.webp`,
      }))
      expect(head.$metadata.httpStatusCode).toBe(200)
    }

    const rec = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
    }))).Item
    expect(rec?.status).toBe('ready')
    expect(rec?.width).toBe(300)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.type).toBe('AssetProcessed')
    expect(AssetProcessed.safeParse(emitted[0]!.detail).success).toBe(true)

    // Boundary: media does NOT write the product record.
    const product = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: '#META' },
    }))).Item
    expect(product?.asset).toBeNull()
  })

  it('emits AssetFailed and rethrows when the original is missing', async () => {
    const missingKey = `products/${productId}/${randomUUID()}/original`
    const emitted: { type: string }[] = []
    await expect(processUpload(missingKey, async (type) => { emitted.push({ type }) })).rejects.toThrow()
    expect(emitted.some(e => e.type === 'AssetFailed')).toBe(true)
  })
})
