// ─── The one place board-aggregate keys are built (DESIGN.md §5) ──────────────
//
// The board aggregate is TENANT-SCOPED IN THE PARTITION KEY:
//
//   TENANT#<tenantId>#BOARD#<boardId>            board #META, placements, members, #SUMMARY
//   TENANT#<tenantId>#BOARD#<boardId>#S<n>       a hot board's placement shard (ADR 0018)
//   TENANT#<tenantId>#BOARD#<boardId>#EVT        the board's change-event log
//
// Encoding the tenant as the LEADING part of the key does two things:
//   1. It makes an IAM `dynamodb:LeadingKeys` condition possible — a request handler
//      assuming a per-tenant role literally cannot touch another tenant's partitions,
//      so even a logic bug can't cross tenants at the AWS layer (defense in depth).
//   2. A forgotten tenant scope becomes impossible: there is no way to build a board
//      key without a tenantId, because every caller goes through this module.
//
// Products (PROD#<id>) are NOT tenant-prefixed yet — that path crosses into the media
// service and its event contracts (see ADR 0020). They stay protected by the
// application-layer ownership checks already in place (ADR 0015).

/** Partition key for a board's own item collection (#META, placements, members). */
export const boardPk = (tenantId: string, boardId: string): string =>
  `TENANT#${tenantId}#BOARD#${boardId}`

/** Partition key for a hot board's Nth placement shard. */
export const boardShardPk = (tenantId: string, boardId: string, shard: number): string =>
  `TENANT#${tenantId}#BOARD#${boardId}#S${shard}`

/** Partition key for a board's change-event log (its own partition, grows unbounded). */
export const boardEventsPk = (tenantId: string, boardId: string): string =>
  `TENANT#${tenantId}#BOARD#${boardId}#EVT`

/** Partition key for a tenant's board-listing pointers (the workspace IS the tenant). */
export const workspacePk = (tenantId: string): string => `WS#${tenantId}`

/** Partition key for a product (not tenant-prefixed — see the module header). */
export const productPk = (productId: string): string => `PROD#${productId}`

export interface BoardRef {
  tenantId: string
  boardId: string
}

/**
 * Recover { tenantId, boardId } from any board-aggregate PK, stripping a trailing
 * `#S<n>` shard suffix or `#EVT` events suffix. Returns null for a non-board PK
 * (e.g. a product), so the stream consumer can branch on it. Robust to a tenantId
 * that contains `#`, as long as it doesn't contain the literal `#BOARD#`.
 */
export function parseBoardPk(pk: string): BoardRef | null {
  if (!pk.startsWith('TENANT#')) return null
  const afterTenant = pk.slice('TENANT#'.length)
  const idx = afterTenant.indexOf('#BOARD#')
  if (idx < 0) return null
  const tenantId = afterTenant.slice(0, idx)
  const boardId = afterTenant
    .slice(idx + '#BOARD#'.length)
    .replace(/#S\d+$/, '')
    .replace(/#EVT$/, '')
  if (!tenantId || !boardId) return null
  return { tenantId, boardId }
}
