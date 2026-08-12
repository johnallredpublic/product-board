import { beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { EventBridgeEvent } from 'aws-lambda'
import { ddb, TABLE } from '../src/db/table.js'
import { BUCKET } from '../src/s3/client.js'
import { handler } from '../src/handler.js'

// Drives the ACTUAL Lambda entry point (handler), not processUpload/recordUpload
// directly — so the EventBridge event shape + detail-type routing is covered (the
// exact wiring that a deploy uses). Requires `docker compose up -d`.

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

const ebEvent = (detailType: string, detail: unknown): EventBridgeEvent<string, any> =>
  ({ 'detail-type': detailType, source: 'test', detail } as any)

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
  const original = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 120, b: 200 } },
  }).png().toBuffer()
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: original, ContentType: 'image/png' }))
})

describe('media handler (EventBridge dispatch)', () => {
  it('AssetUploadRequested → records the pending asset', async () => {
    await handler(ebEvent('AssetUploadRequested', {
      version: 1, assetId, productId, key, contentType: 'image/png',
      requestedAt: new Date().toISOString(),
    }))

    const rec = (await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
    }))).Item
    expect(rec?.status).toBe('pending')
    expect(rec?.key).toBe(key)
  })

  it('Object Created → generates derivatives and marks the asset ready', async () => {
    // EventBridge S3 event: the key is on detail.object.key (already decoded).
    await handler(ebEvent('Object Created', { bucket: { name: BUCKET }, object: { key } }))

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
  })

  it('ignores an unrelated detail-type without throwing', async () => {
    await expect(handler(ebEvent('SomethingElse', { foo: 'bar' }))).resolves.toBeUndefined()
  })
})
