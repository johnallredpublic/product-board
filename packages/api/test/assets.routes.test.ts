import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import type { AssetUploadRequested } from '@assortment/shared'
import { ddb, TABLE } from '../src/db/table.js'
import { BUCKET } from '../src/s3/client.js'
import { buildServer } from '../src/server.js'
import { createAssetUpload } from '../src/routes/assets.js'

// Integration test for the presigned-upload route against DynamoDB Local + MinIO.
// After the media split, the API no longer writes the asset record — it emits
// AssetUploadRequested (verified below) and hands back a presigned URL.

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const s3 = new S3Client({
  endpoint: 'http://localhost:9000', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
})

const productId = randomUUID()
let app: FastifyInstance

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
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: '#META', tenantId: 'dev-tenant',
    style: 'AB123', name: 'Runner', colorway: 'Black', priceCents: 12000, season: 'FA26', asset: null,
  }}))
  app = buildServer()
  await app.ready()
})

afterAll(async () => { await app?.close() })

describe('POST /api/products/:id/assets', () => {
  it('returns a presigned URL that accepts the upload', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/products/${productId}/assets`, payload: { contentType: 'image/png' },
    })
    expect(res.statusCode).toBe(200)
    const { assetId, uploadUrl } = res.json()
    expect(assetId).toBeTruthy()
    expect(uploadUrl).toContain('http://localhost:9000/')

    const put = await fetch(uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('fake-png-bytes'),
    })
    expect(put.status).toBe(200)

    const head = await s3.send(new HeadObjectCommand({
      Bucket: BUCKET, Key: `products/${productId}/${assetId}/original`,
    }))
    expect(head.$metadata.httpStatusCode).toBe(200)
  })

  it('rejects an unsupported content type with 400 validation_failed', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/products/${productId}/assets`, payload: { contentType: 'image/gif' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('emits AssetUploadRequested to media (and never writes the asset record itself)', async () => {
    const emitted: { type: string; detail: any }[] = []
    const { assetId } = await createAssetUpload(productId, 'image/png', async (type, detail) => {
      emitted.push({ type, detail })
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.type).toBe('AssetUploadRequested')
    const detail = emitted[0]!.detail as AssetUploadRequested
    expect(detail.version).toBe(1)
    expect(detail.assetId).toBe(assetId)
    expect(detail.productId).toBe(productId)
    expect(detail.key).toBe(`products/${productId}/${assetId}/original`)
  })
})
