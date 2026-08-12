# ADR 0018: Hot-tenant handling

## Status

Accepted (2026-08-12)

## Context

At scale, one noisy tenant must not degrade the rest ([docs/DESIGN.md §6.3](../DESIGN.md)):
a customer bulk-importing 50k products shouldn't starve everyone's notifications, and
one viral board shouldn't exceed a single DynamoDB partition's write throughput.

## Decision

Two independent techniques.

**Bulkheads — reserved concurrency per async consumer.** Each consumer (stream,
notify, asset-processed, reconcile, media) gets a `reservedConcurrentExecutions`
slice in CDK. A flood on one path can't consume the account's whole concurrency pool
and starve the others; the interactive API is left to scale freely. Per-tenant-tier
**queues** (a separate bulk queue with its own concurrency) are the next refinement.

**Opt-in write-sharding for a hot board.** A board's placements normally live in one
partition (`BOARD#<id>`). A board flagged with `shardCount > 1` on its `#META` spreads
placements across `BOARD#<id>#S<n>`, the shard chosen by a stable hash of the
placement id. Reads **scatter-gather** across shards and merge; writes route to the
placement's shard. The stream consumer strips the `#S<n>` suffix to recover the board
id, and the `#SUMMARY` projection and reconciliation count across shards.

Sharding is **opt-in and evidence-driven** — `shardCount <= 1` (the default) is
byte-identical to the unsharded layout, so ordinary boards pay nothing. Shard a board
only when its measured throughput needs it.

## Consequences

- One tenant's burst is contained: bounded consumer concurrency and (for a hot board)
  writes spread across partitions instead of hammering one.
- **Sharded reads cost N queries** (scatter-gather) instead of one, and complicate the
  hottest code path — which is exactly why it's per-board and by evidence, not global.
- **Reserved concurrency reserves account capacity** — the reservations sum against the
  account limit and must be budgeted; unbounded consumers are the alternative risk.
- The board `#SUMMARY` and reconciliation had to become shard-aware; both default to a
  single "shard" (`BOARD#<id>`) so unsharded boards are unchanged.
- Deferred: per-tenant-tier queues, automatic shard-count tuning, and resharding an
  already-hot board (a backfill across the new shard set).
