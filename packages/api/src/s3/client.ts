// src/s3/client.ts
//
// S3 access. Locally this points at MinIO (S3-compatible), so the same SDK code
// runs offline and in AWS. `forcePathStyle` is required for MinIO, which serves
// buckets as path segments (host/bucket/key) rather than virtual-hosted subdomains.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

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

// The assets bucket is private (BlockPublicAccess.BLOCK_ALL), so derivatives are
// delivered via short-lived PRESIGNED GET URLs rather than a public base URL — this
// is the private-tenant delivery §6.5 calls for. URLs are batch-signed at board load
// (getBoardView) and expire; a reload re-signs. Signing is a local HMAC (no network),
// so signing every product on a board load is cheap. In front of S3, CloudFront with
// origin shield collapses origin fetches (see infra/core-stack).
export const ASSET_URL_TTL_SECONDS = Number(process.env.ASSET_URL_TTL_SECONDS ?? 3600)

export const signAssetGet = (key: string): Promise<string> =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: ASSET_URL_TTL_SECONDS })
