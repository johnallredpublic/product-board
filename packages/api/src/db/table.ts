// src/db/table.ts
//
// Single-table DynamoDB access. See ADR 0004 for the decision and its tradeoffs.
//
// ─── Access patterns → keys ────────────────────────────────────────────────
// The whole discipline: keys follow from patterns. Every pattern below resolves
// to a single GetItem, Query, or BatchGet — no scans.
//
//   1. Board metadata             Query  PK=BOARD#<id>,  SK=#META
//   2. Boards in a workspace      Query  PK=WS#<id>,     SK begins_with BOARD#
//   3. Placements in z-order      Query  PK=BOARD#<id>,  SK begins_with ITEM#
//   4. Products by a set of IDs   BatchGet  PK=PROD#<id>, SK=#META  (≤100/req)
//   5. Boards containing product  Query  GSI1 PK=PROD#<pid>
//   6. Product + its assets       Query  PK=PROD#<id>    (#META + ASSET# items)
//   7. Recent activity on a board Query  PK=BOARD#<id>#EVT, ScanIndexForward=false
//
// Patterns 1 + 3 share partition BOARD#<id>: `#META` (0x23) sorts before `ITEM#`,
// so one query returns the board and everything on it — the item collection is a
// pre-computed join. Change events live in their OWN partition (BOARD#<id>#EVT)
// so they can grow unbounded without creating a hot partition on the board.
//
// ─── Item shapes ───────────────────────────────────────────────────────────
//   Entity        PK              SK                    GSI1PK       GSI1SK
//   Workspace     WS#<id>         #META
//   Board pointer WS#<id>         BOARD#<id>
//   Board         BOARD#<id>      #META
//   Placement     BOARD#<id>      ITEM#<zzzz>#<id>      PROD#<pid>   BOARD#<id>
//   Event         BOARD#<id>#EVT  EVT#<iso>#<id>
//   Product       PROD#<id>       #META                 SEASON#<s>   STYLE#<style>
//   Asset         PROD#<id>       ASSET#<id>
//
// z-order is a zero-padded integer (ITEM#0042#<uuid>) so string sort == draw order.
// GSI1 is overloaded (pattern 5 + product-by-season browse); prefixes never collide.
//
// NOTE: the guide's Phase 3 Step 2 table co-locates events under BOARD#<id>;
// ADR 0004 and Phase 8 supersede that with the separate BOARD#<id>#EVT partition
// used above, to keep the board's item collection bounded.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

const client = new DynamoDBClient(
  process.env.LOCAL
    ? {
        endpoint: 'http://localhost:8000',
        region: 'local',
        credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      }
    : {},
)

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
})

export const TABLE = process.env.TABLE_NAME ?? 'assortment'
