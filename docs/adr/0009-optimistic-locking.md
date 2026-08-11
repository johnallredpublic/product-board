# ADR 0009: Optimistic locking for placements

## Status

Accepted (2026-08-11)

## Context

Two users can move the same tile on the same board at the same time. The system
must decide what happens.

The options, in ascending order of cost:

**Last write wins.** Simplest. The later write silently overwrites. No conflict
is ever surfaced.

**Optimistic locking.** Each placement carries a version. A write asserts the
expected version and fails if it has changed. Conflicts are detected and
surfaced.

**Field-level merge.** Store position at finer granularity so two users editing
different attributes do not collide. More complex model.

**CRDTs or operational transformation.** True concurrent editing with automatic
convergence. A substantial subsystem.

The product is collaborative, so silent data loss is undesirable. But the data in
conflict is a tile position: low-value, easily redone, and visually obvious when
wrong. That materially lowers the cost of getting it slightly wrong.

## Decision

Optimistic locking. Each placement has a `version` attribute. Move requests carry
the expected version, and the write uses a DynamoDB `ConditionExpression`
asserting it. A mismatch returns HTTP 409.

Multi-item moves use `TransactWriteItems`, so a multi-selection drag either fully
applies or fully fails.

The client reloads the board on 409.

## Consequences

- Concurrent modification is detected rather than silently losing a write.
- Transactional multi-item moves mean a dragged group never half-applies, which
  would be visually confusing.
- The version attribute is part of the API contract, so clients must round-trip
  it. This is a small but real burden on any future consumer.
- **`TransactWriteItems` costs double the write units** and caps at 100 items per
  transaction, requiring chunking for larger selections.
- **All-or-nothing failure on a group move is arguably wrong for positions.**
  Individual conditional updates with per-item conflict reporting would let 19 of
  20 items move while reporting one conflict. Chosen against for simplicity, but
  this is the weakest part of this decision and worth revisiting.
- **Reloading the board on conflict is heavy-handed.** For tile positions
  specifically, last-write-wins would probably be acceptable and less disruptive.
  This design is more conservative than the data warrants.
- This does not scale to real-time collaborative editing. If the product moves
  toward simultaneous multi-user manipulation, a CRDT-based approach supersedes
  this entirely.
