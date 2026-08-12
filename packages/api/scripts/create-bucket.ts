// Creates the assets bucket on MinIO for local development.
//
//   pnpm s3:create        create if absent (idempotent)
//
// Prod bucket creation lives in infra/ (CDK, Phase 15); this is the local mirror.
// Override with BUCKET_NAME / S3_ENDPOINT if needed.

import {
  S3Client, CreateBucketCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3'

const BUCKET = process.env.BUCKET_NAME ?? 'assortment-assets'
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-west-2',
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
})

try {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
  console.log(`bucket "${BUCKET}" already exists — nothing to do`)
} catch {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
    console.log(`created bucket "${BUCKET}"`)
  } catch (e: any) {
    if (/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(e?.name ?? '')) {
      console.log(`bucket "${BUCKET}" already exists — nothing to do`)
    } else {
      throw e
    }
  }
}
