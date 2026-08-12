import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from './table.js'
import { boardPk, boardShardPk } from './keys.js'

// Opt-in write-sharding for a hot board (ADR 0018 / DESIGN.md §6.3). A single board
// partition (TENANT#<t>#BOARD#<id>) caps out around a partition's write throughput; a
// viral board spreads its placements across N shard partitions
// (TENANT#<t>#BOARD#<id>#S<n>), chosen by a stable hash of the placement id, with
// reads scatter-gathering across shards. Keys are built in db/keys.ts (ADR 0020).
//
// Sharding is OPT-IN per board (shardCount on #META). The default, shardCount<=1, is
// byte-identical to the unsharded layout — normal boards pay nothing. Apply it to a
// board only when its throughput proves it needs it, never everywhere.

type Item = Record<string, any>

function hashInt(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** shardCount from a board's #META (default 1 = unsharded). */
export function shardCountOf(boardMeta: Item | null | undefined): number {
  const n = Number(boardMeta?.shardCount ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

/** The partition key a placement lives in. Unsharded boards use the board's own PK. */
export function placementPk(tenantId: string, boardId: string, placementId: string, shardCount: number): string {
  if (shardCount <= 1) return boardPk(tenantId, boardId)
  return boardShardPk(tenantId, boardId, hashInt(placementId) % shardCount)
}

/** All partition keys holding a board's placements (one, or N shards). */
export function shardPks(tenantId: string, boardId: string, shardCount: number): string[] {
  if (shardCount <= 1) return [boardPk(tenantId, boardId)]
  return Array.from({ length: shardCount }, (_, n) => boardShardPk(tenantId, boardId, n))
}

/** Scatter-gather the placement items for a board across its shards. */
export async function queryPlacementItems(tenantId: string, boardId: string, shardCount: number): Promise<Item[]> {
  const results = await Promise.all(
    shardPks(tenantId, boardId, shardCount).map(pk =>
      ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :i)',
        ExpressionAttributeValues: { ':pk': pk, ':i': 'ITEM#' },
      })),
    ),
  )
  return results.flatMap(r => r.Items ?? [])
}

/** Count a board's placements across its shards (COUNT, no item transfer). */
export async function countPlacements(tenantId: string, boardId: string, shardCount: number): Promise<number> {
  const counts = await Promise.all(
    shardPks(tenantId, boardId, shardCount).map(async pk => {
      const { Count = 0 } = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :i)',
        ExpressionAttributeValues: { ':pk': pk, ':i': 'ITEM#' },
        Select: 'COUNT',
      }))
      return Count
    }),
  )
  return counts.reduce((a, b) => a + b, 0)
}
