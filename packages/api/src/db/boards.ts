import { QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb'
import type { Board, Placement, Product } from '@assortment/shared'
import { ddb, TABLE } from './table.js'

/** A raw DynamoDB item: generic keys (PK/SK/GSI…) plus domain attributes. */
type Item = Record<string, any>

export async function getBoardView(boardId: string) {
  // One query gets metadata AND placements: #META sorts before ITEM#
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `BOARD#${boardId}` },
  }))

  const board = Items.find(i => i.SK === '#META')
  if (!board) return null

  const placements = Items.filter(i => String(i.SK).startsWith('ITEM#'))

  // Hydrate products. BatchGet caps at 100 keys per request.
  const ids = [...new Set(placements.map(p => String(p.productId)))]
  const products = await batchGetProducts(ids)

  return { board: toBoard(board), placements: placements.map(toPlacement), products }
}

async function batchGetProducts(ids: string[]) {
  const out: Item[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TABLE]: { Keys: chunk.map(id => ({ PK: `PROD#${id}`, SK: '#META' })) },
      },
    }))
    out.push(...(res.Responses?.[TABLE] ?? []))
    // NOTE: production code must retry res.UnprocessedKeys
  }
  return out.map(toProduct)
}

/**
 * Map each placement id -> its full sort key for a board. The SK embeds z-order
 * (ITEM#<zzzz>#<id>, ADR 0004) so it can't be derived from the id alone; the move
 * route uses this to translate the contract's `id` into the key DynamoDB needs.
 */
export async function placementSkMap(boardId: string): Promise<Map<string, string>> {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :item)',
    ExpressionAttributeValues: { ':pk': `BOARD#${boardId}`, ':item': 'ITEM#' },
  }))
  const map = new Map<string, string>()
  for (const i of Items) {
    const sk = String(i.SK)
    const id = sk.split('#')[2] ?? ''
    if (id) map.set(id, sk)
  }
  return map
}

// ─── Mappers: raw item → contract type ───────────────────────────────────────
// The translation boundary from the storage shape to the domain shape. Runtime
// validation is the route layer's job (BoardView.parse); these only reshape.

function toBoard(i: Item): Board {
  return {
    id: String(i.PK).replace('BOARD#', ''),
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

function toProduct(i: Item): Product {
  return {
    id: String(i.PK).replace('PROD#', ''),
    style: i.style,
    name: i.name,
    colorway: i.colorway,
    priceCents: i.priceCents,
    season: i.season,
    asset: i.asset ?? null,
  }
}
