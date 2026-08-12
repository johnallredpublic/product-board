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

/** Body for adding a product to a board. The server assigns id, z-order, version. */
export const AddPlacement = z.object({
  productId: z.string().uuid(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive().optional(), // defaults applied server-side
  h: z.number().positive().optional(),
})
export type AddPlacement = z.infer<typeof AddPlacement>

/**
 * Body for editing a product — a partial patch (field-level merge, DESIGN.md §6.2):
 * only the fields present are changed. At least one must be supplied.
 */
export const UpdateProduct = z.object({
  name:       z.string().min(1).max(200).optional(),
  style:      z.string().min(1).max(64).optional(),
  colorway:   z.string().max(64).optional(),
  priceCents: z.number().int().nonnegative().optional(),
  season:     Product.shape.season.optional(),
}).refine(o => Object.values(o).some(v => v !== undefined), {
  message: 'at least one field is required',
})
export type UpdateProduct = z.infer<typeof UpdateProduct>

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

/** A product as it appears in catalog search results (no image needed to list). */
export const CatalogItem = z.object({
  id:         z.string().uuid(),
  style:      z.string(),
  name:       z.string(),
  colorway:   z.string(),
  priceCents: z.number().int().nonnegative(),
  season:     Product.shape.season,
})
export type CatalogItem = z.infer<typeof CatalogItem>

/** What the catalog search route returns. */
export const CatalogResults = z.object({
  items: z.array(CatalogItem),
  total: z.number().int().nonnegative(),
})
export type CatalogResults = z.infer<typeof CatalogResults>

const Point = z.object({ x: z.number(), y: z.number() })

/** A placement change derived from the DynamoDB stream (Phase 8). */
export const ChangeEvent = z.object({
  eventId:     z.string(),
  type:        z.enum(['INSERT', 'MODIFY', 'REMOVE']),
  placementId: z.string(),
  before:      Point.nullable(),
  after:       Point.nullable(),
  at:          z.string(),
})
export type ChangeEvent = z.infer<typeof ChangeEvent>

/** What the board-events route returns (newest first). */
export const BoardEvents = z.object({
  items: z.array(ChangeEvent),
})
export type BoardEvents = z.infer<typeof BoardEvents>

/**
 * A DOMAIN event (a statement about the business), distinct from the raw DynamoDB
 * change record. Published to EventBridge (Phase 9); consumers depend on this
 * shape, not the table's. The `version` literal makes it a versioned contract
 * (Phase 10): additive changes are safe, anything else needs a new version.
 */
export const PlacementMoved = z.object({
  version:      z.literal(1),
  tenantId:     z.string().optional(), // scopes the board/member keys the notifier builds
  boardId:      z.string(),
  placementId:  z.string(),
  from:         Point.nullable(),
  to:           Point.nullable(),
  at:           z.string(),
  eventId:      z.string(),
  actorUserId:  z.string().optional(), // who moved it, so we don't notify them of it
})
export type PlacementMoved = z.infer<typeof PlacementMoved>