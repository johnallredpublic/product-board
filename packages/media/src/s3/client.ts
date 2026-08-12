import { S3Client } from '@aws-sdk/client-s3'

export const s3 = new S3Client(
  process.env.LOCAL
    ? {
        endpoint: 'http://localhost:9000',
        region: 'us-west-2',
        forcePathStyle: true,
        credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
      }
    : {},
)

export const BUCKET = process.env.BUCKET_NAME ?? 'assortment-assets'
