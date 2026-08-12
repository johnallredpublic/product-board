// src/s3/client.ts
//
// S3 access. Locally this points at MinIO (S3-compatible), so the same SDK code
// runs offline and in AWS. `forcePathStyle` is required for MinIO, which serves
// buckets as path segments (host/bucket/key) rather than virtual-hosted subdomains.

import { S3Client } from '@aws-sdk/client-s3'

export const s3 = new S3Client(
  process.env.LOCAL
    ? {
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
      }
    : {},
)

export const BUCKET = process.env.BUCKET_NAME ?? 'assortment-assets'

// Public base for derivative URLs stored on the product's AssetRef. Locally this is
// the path-style MinIO object URL; in production it's the CloudFront domain, set via
// ASSET_BASE_URL (Phase 11/15). Derivatives are immutable (UUID in the key).
export const ASSET_BASE_URL =
  process.env.ASSET_BASE_URL ??
  (process.env.LOCAL ? `http://localhost:9000/${BUCKET}` : '')

export const assetUrl = (key: string) => `${ASSET_BASE_URL}/${key}`
