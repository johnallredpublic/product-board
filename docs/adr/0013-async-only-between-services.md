# ADR 0013: Asynchronous communication only between services

## Status

Accepted (2026-08-11)

## Context

With two services (ADR 0012), they must communicate. The API needs to tell media
that an asset requires processing, and media needs to tell the API when
derivatives are ready.

**Synchronous HTTP** is simpler to reason about and immediately consistent. But
it couples availability: if media is down, the calling operation fails. Chained
availability multiplies, so two services at 99.9% give 99.8% together, and
latency accumulates the same way.

**Asynchronous messaging** decouples them. The producer does not know or care who
consumes, and a consumer being down does not break the producer. The cost is
eventual consistency and a flow that exists in no single place in the code.

Nothing in the media workflow requires a synchronous answer. The user needs to
know their upload succeeded, which S3 confirms directly; they do not need to wait
for a thumbnail.

## Decision

No synchronous calls between services. All inter-service communication flows
through EventBridge.

Events are **domain events**, not database change records. The stream consumer
translates DynamoDB stream records into events describing business facts
(`AssetUploadRequested`, `AssetProcessed`, `AssetFailed`) before publishing.

Every event carries an explicit `version` field. Changes are additive only;
breaking changes require a new version published alongside the old during a
migration window.

Consumers are tolerant readers: they read the fields they need and ignore
everything else.

## Consequences

- Either service can be down without breaking the other. Graceful degradation
  rather than cascading failure.
- Consumers can be added without modifying producers.
- Publishing domain events rather than stream records means consumers depend on
  business facts rather than on our table design, so the data model can change
  without breaking them.
- **Eventual consistency everywhere between services.** The UI must handle
  `pending` states rather than assuming immediate completion.
- **The end-to-end flow is not visible in any single file.** Understanding what
  happens on upload requires tracing across two services and a bus. This is the
  principal cost and it is why observability (correlation IDs across async
  boundaries) is not optional.
- **Event schemas are a contract with consumers that may not be known.** Once
  published, a shape cannot be taken back.
- Debugging requires distributed tracing. Without correlation IDs propagated
  through event payloads, a failure is very difficult to follow.
- Testing requires either LocalStack or careful separation of pure logic from
  transport.
