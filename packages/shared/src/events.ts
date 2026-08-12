import { z } from 'zod'

// Inter-service contract (ADR 0013). Every event is versioned: additive changes
// are safe; anything else requires a new version alongside the old during a
// migration window. Consumers are TOLERANT READERS — read what they need, ignore
// the rest — so a producer adding a field never breaks a consumer.

/** Emitted by api → consumed by media. */
export const AssetUploadRequested = z.object({
  version:     z.literal(1),
  assetId:     z.string().uuid(),
  productId:   z.string().uuid(),
  key:         z.string(),
  contentType: z.string(),
  requestedAt: z.string().datetime(),
})
export type AssetUploadRequested = z.infer<typeof AssetUploadRequested>

/** Emitted by media → consumed by api. */
export const AssetProcessed = z.object({
  version:   z.literal(1),
  assetId:   z.string().uuid(),
  productId: z.string().uuid(),
  derivatives: z.array(z.object({
    size:        z.number().int(),
    key:         z.string(),
    contentType: z.string(),
  })),
  width:  z.number().int().positive(),
  height: z.number().int().positive(),
})
export type AssetProcessed = z.infer<typeof AssetProcessed>

/** Emitted by media → consumed by api. */
export const AssetFailed = z.object({
  version:   z.literal(1),
  assetId:   z.string().uuid(),
  productId: z.string().uuid(),
  reason:    z.string(),
})
export type AssetFailed = z.infer<typeof AssetFailed>
