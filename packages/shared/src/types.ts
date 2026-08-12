import { z } from 'zod'

export const AssetRef = z.object({
  assetId: z.string().uuid(),
  thumb128: z.string().url(),
  thumb512: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type AssetRef = z.infer<typeof AssetRef>

export const Product = z.object({
  id:         z.string().uuid(),
  style:      z.string().min(1).max(64),
  name:       z.string().min(1).max(200),
  colorway:   z.string().max(64),
  priceCents: z.number().int().nonnegative(),
  season:     z.enum(['SP26', 'FA26', 'SP27']),
  asset:      AssetRef.nullable(),
})
export type Product = z.infer<typeof Product>

/** A product placed on a board. Coordinates are WORLD units. */
export const Placement = z.object({
  id:        z.string().uuid(),
  productId: z.string().uuid(),
  x:         z.number(),
  y:         z.number(),
  w:         z.number().positive(),
  h:         z.number().positive(),
  z:         z.number().int().nonnegative(),
  version:   z.number().int().nonnegative(),
})
export type Placement = z.infer<typeof Placement>

export const Board = z.object({
  id:        z.string().uuid(),
  name:      z.string().min(1).max(200),
  season:    Product.shape.season,
  createdAt: z.string().datetime(),
})
export type Board = z.infer<typeof Board>

/** What the board route loads in one request. */
export const BoardView = z.object({
  board:      Board,
  placements: z.array(Placement),
  products:   z.array(Product),
})
export type BoardView = z.infer<typeof BoardView>

export const MovePlacements = z.object({
  moves: z.array(z.object({
    id: z.string().uuid(),
    x: z.number(),
    y: z.number(),
    version: z.number().int().nonnegative(),
  })).min(1).max(200),
})

export const ApiError = z.object({
  error: z.object({
    code: z.enum(['not_found', 'conflict', 'validation_failed', 'unauthorized']),
    message: z.string(),
  }),
})

/** Body for requesting a presigned upload. The enum is the allow-list: an
 * unsupported type fails validation at the boundary (400) with no extra check. */
export const UploadRequest = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
})
export type UploadRequest = z.infer<typeof UploadRequest>

/** What the upload endpoint returns: an id to track, and a URL to PUT bytes to. */
export const UploadResponse = z.object({
  assetId: z.string().uuid(),
  uploadUrl: z.string().url(),
})
export type UploadResponse = z.infer<typeof UploadResponse>

/** Body for creating a board. */
export const CreateBoardRequest = z.object({
  name:   z.string().min(1).max(200),
  season: Product.shape.season,
})
export type CreateBoardRequest = z.infer<typeof CreateBoardRequest>

/** What the list-boards route returns. */
export const BoardList = z.object({
  boards: z.array(Board),
})
export type BoardList = z.infer<typeof BoardList>