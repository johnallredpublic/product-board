import type { EventBridgeEvent } from 'aws-lambda'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { AssetProcessed, type AssetRef } from '@assortment/shared'
import { ddb, TABLE } from '../db/table.js'
import { assetUrl } from '../s3/client.js'
import { runWithCorrelation, newCorrelationId } from '../obs/correlation.js'

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

  const asset: AssetRef = {
    assetId: evt.assetId,
    thumb128: assetUrl(keyOf(128)),
    thumb512: assetUrl(keyOf(512)),
    width: evt.width,
    height: evt.height,
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `PROD#${evt.productId}`, SK: '#META' },
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
