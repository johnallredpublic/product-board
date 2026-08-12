import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'
import type { UploadResponse, AssetUploadRequested } from '@assortment/shared'
import { s3, BUCKET } from '../s3/client.js'
import { publishDomainEvent } from '../events/bus.js'

// ─── Presigned upload ────────────────────────────────────────────────────────
// Bytes go browser -> S3 directly; our compute is never in the data path. The API
// does NOT write the asset record — media owns those (ADR 0012). Instead it emits
// AssetUploadRequested; media records the pending asset and, once S3 has the bytes,
// generates derivatives and emits AssetProcessed back.

const URL_TTL_SECONDS = 300

export type Publish = (detailType: string, detail: Record<string, unknown>) => Promise<void>

export async function createAssetUpload(
  productId: string,
  contentType: string,
  publish: Publish = publishDomainEvent,
): Promise<UploadResponse> {
  const assetId = randomUUID()
  const key = `products/${productId}/${assetId}/original`

  // Announce intent to media BEFORE the client can upload (so the pending record
  // exists to reconcile against). `publish` is injected for testing.
  const event: AssetUploadRequested = {
    version: 1, assetId, productId, key, contentType,
    requestedAt: new Date().toISOString(),
  }
  await publish('AssetUploadRequested', event)

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: URL_TTL_SECONDS },
  )

  return { assetId, uploadUrl }
}
