import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from '../db/table.js'
import { ConflictError } from '../errors.js'
import { placementPk } from '../db/sharding.js'

/**
 * One position update. Addressed by the item's FULL sort key, not the bare
 * placement id — see the "Addressing" note below.
 */
export interface Move {
  sk: string       // ITEM#<zzzz>#<id>
  x: number
  y: number
  version: number  // the optimistic-lock token the client last read
}

// ─── Design choice: one transaction per chunk (all-or-nothing) ───────────────
// A TransactWrite makes every move in the chunk succeed or every move fail. That
// is the RIGHT semantics for dragging a multi-selection: you never want half a
// group to move and the other half to stay behind.
//
// The cost, stated so it can be defended:
//   • ~2x write capacity — TransactWrite consumes double the WCUs of a plain Update.
//   • All-or-nothing failure — if ONE item's version is stale, the whole chunk is
//     cancelled, including the moves that would have succeeded.
//
// The alternative is individual conditional UpdateItem calls with per-item
// conflict reporting: cheaper, and it lets the fresh moves through while telling
// the client exactly which ones lost. For independent single-tile edits that is
// arguably better; for grouped drags the atomic transaction wins. We chose the
// transaction because the multi-select drag is the interaction that matters here.
//
// ─── Optimistic locking ──────────────────────────────────────────────────────
// `ConditionExpression: version = :expected` is the lock. If another writer bumped
// the version since the client read it, the condition fails, DynamoDB raises
// TransactionCanceledException, and we surface a 409 Conflict. Each successful
// write increments version, so the next stale write is rejected.
//
// ─── Addressing (a real tension worth naming) ────────────────────────────────
// The item's SK embeds z-order (ITEM#<zzzz>#<id>, see ADR 0004), so an item cannot
// be addressed by its placement id alone. A reposition changes x/y but NOT z, so
// the SK is stable across a move — the caller passes the full SK. The route layer
// (Step 5) resolves the contract's placement `id` -> `sk` via the board query
// before calling this. Trade: SK-embedded z gives free ordering but costs direct
// id-addressability; the resolution step is the price we pay for that ordering.

export async function movePlacements(tenantId: string, boardId: string, moves: Move[], userId: string, shardCount = 1) {
  // TransactWrite caps at 100 items per call.
  for (let i = 0; i < moves.length; i += 100) {
    const chunk = moves.slice(i, i + 100)
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: chunk.map(m => ({
          Update: {
            TableName: TABLE,
            // Route to the placement's shard (the board PK when unsharded). The id is
            // the last segment of the SK (ITEM#<zzzz>#<id>).
            Key: { PK: placementPk(tenantId, boardId, m.sk.split('#')[2] ?? '', shardCount), SK: m.sk },
            // updatedBy rides into the stream's NewImage -> PlacementMoved.actorUserId,
            // so the notifier can skip notifying the mover of their own move.
            UpdateExpression: 'SET x = :x, y = :y, version = version + :one, updatedBy = :u',
            ConditionExpression: 'version = :expected',
            ExpressionAttributeValues: {
              ':x': m.x, ':y': m.y, ':one': 1, ':expected': m.version, ':u': userId,
            },
          },
        })),
      }))
    } catch (e: any) {
      if (e.name === 'TransactionCanceledException') {
        throw new ConflictError('A placement was modified by someone else')
      }
      throw e
    }
  }
}
