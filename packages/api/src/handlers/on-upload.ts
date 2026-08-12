import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import sharp from 'sharp'
import type { AssetRef } from '@assortment/shared'
import type { S3Event } from 'aws-lambda'
import { ddb, TABLE } from '../db/table.js'
import { s3, BUCKET, assetUrl } from '../s3/client.js'

const SIZES = [128, 512] as const
const derivativeKey = (originalKey: string, size: number) =>
  originalKey.replace('/original', `/thumb-${size}.webp`)

/** Parse `products/<productId>/<assetId>/original` into its ids. */
function parseKey(key: string) {
  const parts = key.split('/')
  return { productId: parts[1] ?? '', assetId: parts[2] ?? '' }
}

/**
 * Core processor: fetch the original, generate 128/512 WebP derivatives, and flip
 * the asset record pending -> ready. Extracted from the Lambda handler so it can be
 * called directly in tests (Phase 14) with no AWS event plumbing.
 *
 * The two sizes exist for the canvas: 128px tiles at low zoom, 512px zoomed in
 * (Phase 6). A storage-layer decision made to serve a rendering-layer constraint.
 */
export async function processUpload(key: string): Promise<void> {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const buf = Buffer.from(await Body!.transformToByteArray())
  const meta = await sharp(buf).metadata()

  for (const size of SIZES) {
    const out = await sharp(buf)
      .resize(size, size, { fit: 'cover' })
      .webp({ quality: 82 })
      .toBuffer()
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: derivativeKey(key, size),
      Body: out,
      ContentType: 'image/webp',
      // immutable is safe: the key contains a UUID, so content at it never changes.
      CacheControl: 'public, max-age=31536000, immutable',
    }))
  }

  await markReady(key, { width: meta.width ?? 0, height: meta.height ?? 0 })
}

async function markReady(key: string, dims: { width: number; height: number }) {
  const { productId, assetId } = parseKey(key)
  const thumb128Key = derivativeKey(key, 128)
  const thumb512Key = derivativeKey(key, 512)

  // 1. Asset record: pending -> ready, with original dimensions + derivative keys.
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
    UpdateExpression:
      'SET #status = :ready, width = :w, height = :h, thumb128Key = :t1, thumb512Key = :t2',
    ExpressionAttributeNames: { '#status': 'status' }, // "status" is a DynamoDB reserved word
    ExpressionAttributeValues: {
      ':ready': 'ready', ':w': dims.width, ':h': dims.height,
      ':t1': thumb128Key, ':t2': thumb512Key,
    },
  }))

  // 2. Point the product at this asset so the board can render it (single AssetRef).
  const asset: AssetRef = {
    assetId,
    thumb128: assetUrl(thumb128Key),
    thumb512: assetUrl(thumb512Key),
    width: dims.width,
    height: dims.height,
  }
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `PROD#${productId}`, SK: '#META' },
    UpdateExpression: 'SET asset = :asset',
    ExpressionAttributeValues: { ':asset': asset },
  }))
}

/**
 * Lambda entry point. Wired to S3 ObjectCreated events in Phase 11 (CDK). Locally
 * there is no S3->Lambda trigger, so tests/dev call processUpload() directly.
 */
export async function handler(event: S3Event): Promise<void> {
  for (const rec of event.Records) {
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '))
    await processUpload(key)
  }
}
