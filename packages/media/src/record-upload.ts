import { PutCommand } from '@aws-sdk/lib-dynamodb'
import type { AssetUploadRequested } from '@assortment/shared'
import { ddb, TABLE } from './db/table.js'

/**
 * Media owns asset records. When the API emits AssetUploadRequested, media writes
 * the pending record — the API never writes asset records (one writer per datum,
 * ADR 0012). In AWS this is a consumer of the event; locally it's called directly.
 */
export async function recordUpload(evt: AssetUploadRequested): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `PROD#${evt.productId}`,
      SK: `ASSET#${evt.assetId}`,
      status: 'pending',
      key: evt.key,
      contentType: evt.contentType,
      createdAt: evt.requestedAt,
    },
    ConditionExpression: 'attribute_not_exists(SK)',
  }))
}
