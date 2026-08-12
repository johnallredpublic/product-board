import { QueryCommand, BatchGetCommand, TransactWriteCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import type { AddPlacement, Board, ChangeEvent } from '@assortment/shared'
import type { Placement } from '@assortment/shared'
import { ddb, TABLE } from './table.js'
import { shardCountOf, queryPlacementItems, placementPk } from './sharding.js'
import { boardPk, boardEventsPk, workspacePk, productPk, parseBoardPk } from './keys.js'
import { signedProduct } from './products.js'

/** A raw DynamoDB item: generic keys (PK/SK/GSI…) plus domain attributes. */
type Item = Record<string, any>

// The workspace IS the tenant: boards are listed under WS#<tenantId> and every
// board's #META is stamped with its tenantId. Access is scoped by the tenant from
// the caller's token (see auth.ts / ADR 0015), never by a request parameter.

/**
 * Create a board for a tenant. Writes the board's #META (stamped with tenantId) AND
 * the tenant's listing pointer atomically, so they can never disagree.
 */
export async function createBoard(
  tenantId: string,
  input: { name: string; season: Board['season']; shardCount?: number },
): Promise<Board> {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  const summary = { name: input.name, season: input.season, createdAt }
  // shardCount is an ops/scale decision (not a client field); only stamp it when >1.
  const meta = input.shardCount && input.shardCount > 1
    ? { PK: boardPk(tenantId, id), SK: '#META', tenantId, shardCount: input.shardCount, ...summary }
    : { PK: boardPk(tenantId, id), SK: '#META', tenantId, ...summary }

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE,
          Item: meta,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: { PK: workspacePk(tenantId), SK: `BOARD#${id}`, ...summary },
        },
      },
    ],
  }))

  return { id, ...summary }
}

/** List a tenant's boards (access pattern 2): one Query over the tenant's pointers. */
export async function listBoards(tenantId: string): Promise<Board[]> {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :b)',
    ExpressionAttributeValues: { ':pk': workspacePk(tenantId), ':b': 'BOARD#' },
  }))
  return Items.map(i => ({
    id: String(i.SK).replace('BOARD#', ''),
    name: i.name,
    season: i.season,
    createdAt: i.createdAt,
  }))
}

/** Load a board's #META (for tenant ownership checks). Null if it doesn't exist. */
export async function getBoardMeta(tenantId: string, boardId: string): Promise<Item | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: boardPk(tenantId, boardId), SK: '#META' },
  }))
  return Item ?? null
}

/** Recent change events for a board, newest first (access pattern 7, Phase 8). */
export async function getBoardEvents(tenantId: string, boardId: string, limit = 50): Promise<ChangeEvent[]> {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': boardEventsPk(tenantId, boardId) },
    ScanIndexForward: false,
    Limit: limit,
  }))
  return Items.map(i => ({
    eventId: String(i.eventId),
    type: i.type,
    placementId: String(i.placementId),
    before: i.before ?? null,
    after: i.after ?? null,
    at: String(i.at),
  }))
}

export async function getBoardView(boardId: string, tenantId: string) {
  // One query gets metadata AND placements: #META sorts before ITEM#. The tenant is
  // baked into the partition key, so this query can only ever see this tenant's board.
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': boardPk(tenantId, boardId) },
  }))

  const board = Items.find(i => i.SK === '#META')
  // BOLA guard: a board belonging to another tenant reads as "not found". (With the
  // tenant in the PK this is now belt-and-suspenders, but kept as defense in depth.)
  if (!board || board.tenantId !== tenantId) return null

  // Unsharded boards keep placements in this same partition (one query). A sharded
  // (hot) board scatter-gathers them across its shard partitions.
  const shardCount = shardCountOf(board)
  const placements = shardCount <= 1
    ? Items.filter(i => String(i.SK).startsWith('ITEM#'))
    : await queryPlacementItems(tenantId, boardId, shardCount)

  // Hydrate products. BatchGet caps at 100 keys per request. Each product's asset is
  // presigned into short-lived GET URLs here (batch-signed at board load, §6.5).
  const ids = [...new Set(placements.map(p => String(p.productId)))]
  const productItems = await batchGetProducts(ids)
  const products = await Promise.all(productItems.map(signedProduct))

  return { board: toBoard(board), placements: placements.map(toPlacement), products }
}

async function batchGetProducts(ids: string[]): Promise<Item[]> {
  const out: Item[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TABLE]: { Keys: chunk.map(id => ({ PK: productPk(id), SK: '#META' })) },
      },
    }))
    out.push(...(res.Responses?.[TABLE] ?? []))
    // NOTE: production code must retry res.UnprocessedKeys
  }
  return out
}

/**
 * Map each placement id -> its full sort key for a board. The SK embeds z-order
 * (ITEM#<zzzz>#<id>, ADR 0004) so it can't be derived from the id alone; the move
 * route uses this to translate the contract's `id` into the key DynamoDB needs.
 */
export async function placementSkMap(tenantId: string, boardId: string, shardCount = 1): Promise<Map<string, string>> {
  const items = await queryPlacementItems(tenantId, boardId, shardCount) // one query when unsharded
  const map = new Map<string, string>()
  for (const i of items) {
    const sk = String(i.SK)
    const id = sk.split('#')[2] ?? ''
    if (id) map.set(id, sk)
  }
  return map
}

// z-order sort key: ITEM#<zzzz>#<uuid>, zero-padded so string sort == draw order.
const zKey = (z: number, id: string) => `ITEM#${String(z).padStart(4, '0')}#${id}`

/**
 * Add a product to a board. The server assigns the id, the next z-order (top of the
 * stack), and version 0. Stamps GSI1 (PROD#<pid> / BOARD#<id>) so access pattern 5 —
 * "boards containing a product" — resolves without a scan (used by notify, §6.4).
 * Routes to the placement's shard for a hot board (BOARD#<id> when unsharded).
 */
export async function addPlacement(
  tenantId: string,
  boardId: string,
  input: AddPlacement,
  shardCount = 1,
): Promise<Placement> {
  const id = randomUUID()
  // Next z = one above the current top. Scatter-gather is one query when unsharded.
  const items = await queryPlacementItems(tenantId, boardId, shardCount)
  const z = items.reduce((max, i) => Math.max(max, Number(i.z ?? -1)), -1) + 1
  const w = input.w ?? 140
  const h = input.h ?? 170

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: placementPk(tenantId, boardId, id, shardCount),
      SK: zKey(z, id),
      productId: input.productId,
      x: input.x, y: input.y, w, h, z, version: 0,
      // GSI1SK keeps the bare board id so boardsContainingProduct can recover it.
      GSI1PK: productPk(input.productId), GSI1SK: `BOARD#${boardId}`,
    },
    ConditionExpression: 'attribute_not_exists(SK)',
  }))

  return { id, productId: input.productId, x: input.x, y: input.y, w, h, z, version: 0 }
}

/**
 * Remove a placement from a board. Resolves the id → full SK (the SK embeds z-order,
 * so it can't be derived from the id — same tension as the move route). Returns false
 * if no such placement exists, which the route turns into a 404.
 */
export async function removePlacement(
  tenantId: string,
  boardId: string,
  placementId: string,
  shardCount = 1,
): Promise<boolean> {
  const skMap = await placementSkMap(tenantId, boardId, shardCount)
  const sk = skMap.get(placementId)
  if (!sk) return false
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { PK: placementPk(tenantId, boardId, placementId, shardCount), SK: sk },
  }))
  return true
}

/**
 * Board ids that contain a product (access pattern 5, GSI1). Only placements created
 * via addPlacement carry the GSI1 keys, so this reflects live-added placements — used
 * by notify to fan a ProductPriceChanged out to the affected boards' members.
 */
export async function boardsContainingProduct(productId: string): Promise<string[]> {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :b)',
    ExpressionAttributeValues: { ':p': productPk(productId), ':b': 'BOARD#' },
  }))
  return [...new Set(Items.map(i => String(i.GSI1SK).replace('BOARD#', '')))]
}

// ─── Mappers: raw item → contract type ───────────────────────────────────────
// The translation boundary from the storage shape to the domain shape. Runtime
// validation is the route layer's job (BoardView.parse); these only reshape.

function toBoard(i: Item): Board {
  return {
    id: parseBoardPk(String(i.PK))?.boardId ?? '',
    name: i.name,
    season: i.season,
    createdAt: i.createdAt,
  }
}

function toPlacement(i: Item): Placement {
  // SK is ITEM#<zzzz>#<uuid>; the placement id is the last segment.
  const id = String(i.SK).split('#')[2] ?? ''
  return {
    id,
    productId: String(i.productId),
    x: i.x,
    y: i.y,
    w: i.w,
    h: i.h,
    z: i.z,
    version: i.version,
  }
}
