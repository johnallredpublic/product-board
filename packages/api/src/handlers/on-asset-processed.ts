import type { EventBridgeEvent } from 'aws-lambda'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { AssetProcessed } from '@assortment/shared'
import { ddb, TABLE } from '../db/table.js'
import { productPk } from '../db/keys.js'
import { runWithCorrelation, newCorrelationId } from '../obs/correlation.js'

/** How a processed asset is STORED on the product: derivative KEYS, not URLs. The
 * bucket is private, so URLs are presigned per-request at read time (s3/signAssetGet
 * + products/signAsset), never baked into the record. */
export interface StoredAsset {
  assetId: string
  key128: string
  key512: string
  width: number
  height: number
}

/**
 * Consumer of media's AssetProcessed event. The API owns product records, so THIS
 * is where the product's asset reference gets set (media never writes products).
 * One writer per piece of data — the rule that keeps the boundary real (ADR 0012).
 *
 * In AWS this is an EventBridge → Lambda target (Phase 11); locally it's called
 * directly. Tolerant reader: it uses only the fields it needs.
 */
export async function applyAssetProcessed(evt: AssetProcessed): Promise<void> {
  const keyOf = (size: number) => evt.derivatives.find(d => d.size === size)?.key ?? ''

  const asset: StoredAsset = {
    assetId: evt.assetId,
    key128: keyOf(128),
    key512: keyOf(512),
    width: evt.width,
    height: evt.height,
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: productPk(evt.productId), SK: '#META' },
    UpdateExpression: 'SET asset = :a',
    ExpressionAttributeValues: { ':a': asset },
  }))
}

/**
 * Lambda entry: EventBridge (source assortment.media, detailType AssetProcessed)
 * -> apply to the product. Binds the correlation id carried in the event detail.
 */
export async function handler(event: EventBridgeEvent<'AssetProcessed', unknown>): Promise<void> {
  const detail = event.detail as Record<string, unknown>
  const correlationId = (detail?.correlationId as string) ?? newCorrelationId()
  await runWithCorrelation(correlationId, () => applyAssetProcessed(AssetProcessed.parse(detail)))
}
