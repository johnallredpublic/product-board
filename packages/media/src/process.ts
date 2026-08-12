import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import sharp from 'sharp'
import type { AssetProcessed } from '@assortment/shared'
import { ddb, TABLE } from './db/table.js'
import { s3, BUCKET } from './s3/client.js'
import { publishDomainEvent } from './events/bus.js'

const SIZES = [128, 512] as const
const derivativeKey = (originalKey: string, size: number) =>
  originalKey.replace('/original', `/thumb-${size}.webp`)

/** Parse `products/<productId>/<assetId>/original` into its ids. */
function parseKey(key: string) {
  const parts = key.split('/')
  return { productId: parts[1] ?? '', assetId: parts[2] ?? '' }
}

export type Publish = (detailType: string, detail: Record<string, unknown>) => Promise<void>

/**
 * Generate 128/512 WebP derivatives, flip the (media-owned) asset record to ready,
 * and emit AssetProcessed. On failure, emit AssetFailed and rethrow (so the queue
 * retries / DLQs). Media does NOT touch the product record — that's the API's job
 * via the AssetProcessed consumer (one writer per datum, ADR 0012).
 *
 * `publish` is injected so the pipeline is testable without a live bus.
 */
export async function processUpload(key: string, publish: Publish = publishDomainEvent): Promise<void> {
  const { productId, assetId } = parseKey(key)
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const buf = Buffer.from(await Body!.transformToByteArray())
    const meta = await sharp(buf).metadata()

    const derivatives: { size: number; key: string; contentType: string }[] = []
    for (const size of SIZES) {
      const out = await sharp(buf).resize(size, size, { fit: 'cover' }).webp({ quality: 82 }).toBuffer()
      const dk = derivativeKey(key, size)
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: dk, Body: out, ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }))
      derivatives.push({ size, key: dk, contentType: 'image/webp' })
    }

    const width = meta.width ?? 0
    const height = meta.height ?? 0
    await markReady(productId, assetId, key, width, height)

    const event: AssetProcessed = { version: 1, assetId, productId, derivatives, width, height }
    await publish('AssetProcessed', event)
  } catch (e: any) {
    await publish('AssetFailed', { version: 1, assetId, productId, reason: String(e?.message ?? e) })
    throw e
  }
}

async function markReady(productId: string, assetId: string, key: string, width: number, height: number) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `PROD#${productId}`, SK: `ASSET#${assetId}` },
    UpdateExpression: 'SET #status = :ready, width = :w, height = :h, thumb128Key = :t1, thumb512Key = :t2',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':ready': 'ready', ':w': width, ':h': height,
      ':t1': derivativeKey(key, 128), ':t2': derivativeKey(key, 512),
    },
  }))
}

// The Lambda entry point lives in handler.ts, which dispatches the S3 ObjectCreated
// event (delivered via EventBridge) to processUpload().
