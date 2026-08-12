# ADR 0019: Placement lifecycle and product editing

## Status

Accepted (2026-08-12)

## Context

The board could only *move* placements that already existed (seeded). The API
contract in [DESIGN.md §3](../DESIGN.md) lists `PlacementAdded`/`PlacementRemoved`
and a product catalog you edit, but neither add/remove nor product editing was
implemented — and `ProductPriceChanged`, which the notify pipeline already subscribed
to ([core-stack](../../infra/lib/core-stack.ts)), was dead wiring nothing emitted.

## Decision

**Placement add/remove as first-class routes.**
- `POST /api/boards/:id/placements` adds a product to a board. The server assigns the
  id, the next **z-order** (top of the stack), and version 0. Ownership is checked on
  **both** the board and the product — a caller can't place another tenant's product;
  each failure is a 404 (BOLA, ADR 0015).
- `DELETE /api/boards/:id/placements/:pid` removes one. The id is resolved to its full
  z-embedded sort key first (the same id→SK tension as the move route, ADR 0004).
- Adds stamp **GSI1** (`PROD#<pid>` / `BOARD#<id>`), making access pattern 5 — "boards
  containing a product" — real for the first time. Reads/writes route to the
  placement's shard for a hot board (ADR 0018); unsharded boards are unchanged.
- Both fan out over the realtime channel as `placements.added` / `placements.removed`.
  An add ships the **product alongside the placement**, so a peer who doesn't have that
  product loaded can render immediately.

**Product editing with field-level merge (§6.2).** `PATCH /api/products/:id` sets only
the attributes present in the patch, leaving the rest untouched — so two editors
changing *different* fields don't clobber each other (contrast positions, which are
last-write-wins). `updatedBy` is stamped so a resulting event names the editor.

**`ProductPriceChanged` via the transactional outbox.** The price event is **not**
emitted by the API route; the stream consumer detects a `priceCents` diff on a product
`#META` MODIFY and publishes it — the same outbox discipline as `PlacementMoved`
(dedup identity = stream `eventId`, deterministic timestamp from the record). Notify
resolves its subscribers as the **members of every board the product sits on** (GSI1),
unioned and minus the actor.

## Consequences

- The board is now fully editable — build a board from the catalog, not just rearrange
  a seeded one. The catalog side-panel + Delete-key wire the client to these routes.
- **Price-change notifications only reach boards whose placements were added via the new
  endpoint** — seeded placements predate the GSI1 stamping. Honest and acceptable; a
  one-off backfill (Streams-driven, like reconciliation) would seed GSI1 for old rows.
- Add/remove reuse the existing stream path unchanged: INSERT/REMOVE already produced
  change events and drove the `#SUMMARY` recount (ADR 0004 / Phase 8), so activity feed
  and counts stayed correct with no new code.
- `name` is a DynamoDB reserved word, so product updates route every field through
  `ExpressionAttributeNames` — a small tax for arbitrary field patches.
- Deferred: optimistic add on the client (the server assigns the id, so an add is a
  round-trip, not instant); a dedicated `PlacementAdded`/`Removed` *domain* event on
  EventBridge (only the realtime deltas and the raw stream change-events exist today).
