import type { EventBridgeEvent } from 'aws-lambda'
import { AssetUploadRequested } from '@assortment/shared'
import { processUpload } from './process.js'
import { recordUpload } from './record-upload.js'

/**
 * The media Lambda's single entry point. Both of its triggers arrive as EventBridge
 * events (the assets bucket has EventBridge notifications enabled to avoid a
 * bucket→function stack cycle — ADR 0012 / media-stack), so this dispatches on
 * `detail-type` rather than assuming an S3-notification `Records` shape:
 *
 *   AssetUploadRequested (from the API) → record the pending asset (record-upload)
 *   Object Created       (from S3)      → generate derivatives (process)
 *
 * EventBridge S3 events carry the object key already decoded on `detail.object.key`
 * (unlike raw S3 notifications, which URL-encode it under `Records[].s3.object.key`).
 */
export async function handler(event: EventBridgeEvent<string, any>): Promise<void> {
  switch (event['detail-type']) {
    case 'AssetUploadRequested':
      await recordUpload(AssetUploadRequested.parse(event.detail))
      return
    case 'Object Created': {
      const key = String(event.detail?.object?.key ?? '')
      if (key) await processUpload(key)
      return
    }
    default:
      // Tolerant reader: ignore anything else this function isn't subscribed for.
      return
  }
}
