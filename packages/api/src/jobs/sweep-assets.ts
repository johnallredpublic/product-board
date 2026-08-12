import { ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { ddb, TABLE } from '../db/table.js'
import { s3, BUCKET } from '../s3/client.js'

const DAY_MS = 24 * 60 * 60 * 1000

export interface SweepResult {
  scanned: number
  deleted: number
  skippedWithObject: number
}

/**
 * Delete abandoned asset uploads: records stuck at status "pending" past the TTL
 * whose original object never arrived (the client got a presigned URL and never
 * PUT the bytes).
 *
 * DynamoDB and S3 share no transaction (ADR 0005), so they reconcile. There are
 * two distinct "pending" failure modes and this job only owns the first:
 *   • pending, NO object  -> abandoned upload. This job deletes it.
 *   • pending, WITH object -> derivative generation failed. That belongs to the
 *     DLQ/alarm path (Phase 4 Step 3), so we HeadObject first and leave it.
 *
 * A Scan is acceptable here because this is an infrequent batch job; in prod it
 * runs nightly on an EventBridge schedule (Phase 11). Run locally with
 * `pnpm sweep:assets`. `now`/`olderThanMs` are injectable for testing.
 */
export async function sweepPendingAssets(
  opts: { olderThanMs?: number; now?: number } = {},
): Promise<SweepResult> {
  const olderThanMs = opts.olderThanMs ?? DAY_MS
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - olderThanMs).toISOString() // ISO sorts chronologically

  const result: SweepResult = { scanned: 0, deleted: 0, skippedWithObject: 0 }
  let ExclusiveStartKey: Record<string, any> | undefined

  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(SK, :asset) AND #status = :pending AND createdAt < :cutoff',
      ExpressionAttributeNames: { '#status': 'status' }, // reserved word
      ExpressionAttributeValues: { ':asset': 'ASSET#', ':pending': 'pending', ':cutoff': cutoff },
      ExclusiveStartKey,
    }))

    for (const item of page.Items ?? []) {
      result.scanned++
      if (await objectExists(String(item.key))) {
        result.skippedWithObject++ // stuck in processing, not abandoned — leave it
        continue
      }
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: item.PK, SK: item.SK } }))
      result.deleted++
    }

    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)

  return result
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch (e: any) {
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return false
    throw e
  }
}
