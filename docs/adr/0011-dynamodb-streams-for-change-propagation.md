# ADR 0011: DynamoDB Streams for change propagation

## Status

Accepted (2026-08-11)

## Context

Several things need to happen when a placement changes: a change-history event is
recorded, a board summary projection is updated, and downstream consumers may
need notifying.

The naive implementation writes the change and then publishes an event:

```
await ddb.update(...)        // succeeds
await eventBridge.put(...)   // fails
```

The database and its consumers now disagree, permanently. Reversing the order
only changes which side is wrong. There is no transaction spanning both systems.
This is the **dual write problem**.

The established solution is the **transactional outbox**: write the business
record and the event atomically to the same store, then publish from the outbox
asynchronously. The publisher may publish twice, which is acceptable because
consumers are idempotent.

DynamoDB Streams provides this without building an outbox table. The stream is
produced atomically with the write and is a durable, ordered log of every change.

## Decision

Enable DynamoDB Streams with `NEW_AND_OLD_IMAGES`, because change history needs
before and after state.

A consumer Lambda reads the stream and performs downstream work: writing change
events, updating projections, and emitting domain events to EventBridge.

The application never explicitly dual-writes.

Event source mapping configured with `bisectBatchOnError`,
`reportBatchItemFailures`, a bounded `maxRecordAge`, and an SQS failure
destination.

## Consequences

- The dual write problem does not arise. The stream is the outbox and it is
  atomic with the write by construction.
- A complete, ordered log of every change, which is also the basis for change
  history and for rebuilding projections.
- New consumers can be added without touching the write path.
- **Couples the architecture to DynamoDB.** Migrating stores would mean rebuilding
  this mechanism.
- **No control over the event shape.** The stream carries database rows, not
  domain events. This is why ADR 0013 introduces a translation step rather than
  exposing stream records to other services.
- **Delivery is at-least-once and ordering is per-shard, not global.** Consumers
  must be idempotent (ADR 0014) and must not assume global ordering.
- **A failing record blocks its shard** until it succeeds or ages out. This is
  the single most important operational hazard here, and it is why the retry,
  bisect, and failure-destination settings are not optional.
- Stream records are retained 24 hours. A consumer broken longer than that loses
  data and must be recovered by reconciliation (ADR 0012 area) rather than replay.
- Downstream state is eventually consistent. The board summary can lag the
  underlying data by seconds.
