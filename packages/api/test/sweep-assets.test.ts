import { beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand,
} from '@aws-sdk/client-s3'
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { BUCKET } from '../src/s3/client.js'
import { sweepPendingAssets } from '../src/jobs/sweep-assets.js'

// Integration test for the abandoned-upload sweep against DynamoDB Local + MinIO.
// Requires `docker compose up -d`.

const DAY_MS = 24 * 60 * 60 * 1000

const dynamo = new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})
const s3 = new S3Client({
  endpoint: 'http://localhost:9000', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
})

const productId = randomUUID()
const key = (assetId: string) => `products/${productId}/${assetId}/original`
const getAsset = async (assetId: string) => (await ddb.send(new GetCommand({
  TableName: TABLE, Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
}))).Item

// Four scenarios:
const abandoned = randomUUID() // pending, old, no object   -> DELETE
const recent = randomUUID()    // pending, new, no object   -> keep (not stale)
const stuck = randomUUID()     // pending, old, WITH object -> keep (DLQ's problem)
const ready = randomUUID()     // ready, old                -> keep (not pending)

async function ensureInfra() {
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
  try { await s3.send(new HeadBucketCommand({ Bucket: BUCKET })) }
  catch {
    try { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })) }
    catch (e: any) {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(e?.name ?? '')) {
        throw new Error('MinIO not reachable at :9000 — run `docker compose up -d`')
      }
    }
  }
}

beforeAll(async () => {
  await ensureInfra()

  const old = new Date(Date.now() - 2 * DAY_MS).toISOString()
  const nowIso = new Date().toISOString()
  const pending = (assetId: string, createdAt: string) => ({
    PK: `PROD#${productId}`, SK: `ASSET#${assetId}`,
    status: 'pending', key: key(assetId), contentType: 'image/png', createdAt,
  })

  await ddb.send(new PutCommand({ TableName: TABLE, Item: pending(abandoned, old) }))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: pending(recent, nowIso) }))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: pending(stuck, old) }))
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${productId}`, SK: `ASSET#${ready}`, status: 'ready', key: key(ready), createdAt: old,
  }}))

  // Only the "stuck" one has an object present.
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key(stuck), Body: Buffer.from('bytes') }))
})

describe('sweepPendingAssets', () => {
  it('deletes only abandoned pending records (old + no object)', async () => {
    const result = await sweepPendingAssets({ olderThanMs: DAY_MS })

    // at least our abandoned + stuck were seen; other tests' data may add to counts
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(result.skippedWithObject).toBeGreaterThanOrEqual(1)

    expect(await getAsset(abandoned)).toBeUndefined() // deleted
    expect(await getAsset(recent)).toBeDefined()      // too new
    expect(await getAsset(stuck)).toBeDefined()        // has an object -> left alone
    expect(await getAsset(ready)).toBeDefined()        // not pending
  })
})
