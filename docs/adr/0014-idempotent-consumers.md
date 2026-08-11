# ADR 0014: Idempotent consumers via deterministic IDs

## Status

Accepted (2026-08-11)

## Context

Every messaging mechanism in this system delivers at least once. DynamoDB
Streams, EventBridge, and SQS standard queues all redeliver under normal
operation: Lambda retries on error, a batch partially fails and is retried in
full, a visibility timeout expires while work is still in progress, or an
acknowledgment is lost.

Exactly-once *delivery* is not achievable in a distributed system, because the
sender cannot distinguish a lost message from a lost acknowledgment.
Exactly-once *processing* is achievable, and it is at-least-once delivery plus
idempotent handling.

Duplicates are therefore not a bug to be fixed but a contract to be designed
around.

The options for achieving idempotency:

**Deterministic IDs.** Derive the record identity from something stable in the
source event, so a duplicate write overwrites or is rejected rather than
inserting a second row.

**A dedup table.** Record processed message IDs and check before processing.
Works generally, but adds a read and a write per message and needs TTL
management.

**Naturally idempotent operations.** `SET status = X` is safe to repeat;
`INCREMENT count` is not.

## Decision

Deterministic IDs as the primary mechanism, combined with conditional writes.

For stream consumers, the DynamoDB `SequenceNumber` is stable across
redeliveries and is used as the event ID. The change-event write uses
`ConditionExpression: attribute_not_exists(eventId)`, so a redelivery is a no-op.

For projections, prefer operations that are naturally idempotent: recompute and
set, rather than increment.

For notifications, derive a digest key by hashing the recipient and the sorted
set of source event IDs, so the same digest is never sent twice.

Every consumer is written this way, and it is an explicit review checkpoint.

## Consequences

- Redelivery is harmless. Retries, partial batch failures, and visibility timeout
  expiry all become safe.
- No dedup table, so no extra read and write per message and no TTL management.
- Idempotency is a property of the write itself rather than of a surrounding
  check, so there is no race between checking and writing.
- **This is a convention, not a mechanism.** Nothing prevents a developer from
  writing a non-idempotent consumer. It cannot be enforced by tooling and must be
  caught in review, which makes it fragile as the team grows.
- Deterministic IDs require a stable identifier in the source event. Where none
  exists, a dedup table is the fallback and that path is not currently built.
- Naturally idempotent operations can be more expensive than incremental ones.
  Recomputing a count is heavier than incrementing it, and this will not scale
  indefinitely.
- Conditional writes consume capacity even when they fail, so a heavily
  redelivered record costs write units without doing work.
- This handles duplicates but **not reordering.** Out-of-order delivery is a
  separate concern requiring version or timestamp checks, and it is not addressed
  here.
