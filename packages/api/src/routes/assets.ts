import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import type { UploadResponse } from '@assortment/shared'
import { ddb, TABLE } from '../db/table.js'
import { s3, BUCKET } from '../s3/client.js'

// ─── Presigned upload ────────────────────────────────────────────────────────
// The bytes travel browser -> S3 directly; our compute is never in the data path,
// so a 40MB image doesn't consume Lambda duration or hit the 6MB payload limit.
// This is THE AWS upload pattern.
//
// Ordering matters: we record the asset intent in DynamoDB (status "pending")
// BEFORE handing out the URL. That gives us a record to reconcile against if the
// client never uploads (a sweep deletes stale "pending" rows) — see Phase 4 Step 3.
// The two systems (DynamoDB + S3) share no transaction, so the "pending -> ready"
// lifecycle plus reconciliation is how they stay consistent.

const URL_TTL_SECONDS = 300

export async function createAssetUpload(
  productId: string,
  contentType: string,
): Promise<UploadResponse> {
  const assetId = randomUUID()
  // UUID in the key means content at a key never changes -> derivatives can be
  // cached immutably later (Phase 4 Step 2).
  const key = `products/${productId}/${assetId}/original`

  // Record intent BEFORE the upload. attribute_not_exists guards a rare id clash.
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `PROD#${productId}`,
      SK: `ASSET#${assetId}`,
      status: 'pending',
      key,
      contentType,
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: 'attribute_not_exists(SK)',
  }))

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: URL_TTL_SECONDS },
  )

  return { assetId, uploadUrl }
}
