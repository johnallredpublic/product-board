# ADR 0016: Real-time collaboration transport

## Status

Accepted (2026-08-12)

## Context

Multiple users edit the same board at once and must see each other's moves in
near-real-time (target p95 < 500 ms, [docs/DESIGN.md §6.1](../DESIGN.md)). The move
pipeline already emits `PlacementMoved`; this ADR covers how that reaches other
clients.

## Decision

**WebSockets**, with two transports for the two environments:

- **Local/dev:** an in-process connection registry in the API (`board id -> sockets`)
  and a direct broadcast on the move route. A client opens `/realtime`, sends
  `{type:'subscribe', boardId}` (ownership-checked against its tenant), and receives
  `placements.moved` deltas.
- **Production:** an API Gateway **WebSocket API**, the connection registry in
  DynamoDB (`CONN#<boardId>` items with a TTL so dead connections self-evict), and a
  **fan-out Lambda** subscribed to `PlacementMoved` that `postToConnection`s each
  subscriber. This keeps the producer decoupled from delivery.

Deltas carry **absolute** positions and the new version, so applying one is
idempotent — a client re-applying its own echo is a no-op. On a dropped socket the
client reconnects, resubscribes, and **re-fetches the board** (the socket carries
deltas, not truth).

## Consequences

- Two tabs on one board sync live; the feature is demonstrable locally today.
- **The local and prod transports differ.** In-process broadcast is the dev
  equivalent of the decoupled EventBridge→fan-out path — the same divergence as the
  stream poller vs. the Lambda event-source mapping. The prod WebSocket API +
  connection registry + fan-out Lambda are **CDK wiring not yet built** (deferred,
  like other AWS-only infrastructure).
- Fan-out cost is O(viewers) per move; a hot board needs delta batching and
  connection-range sharding (DESIGN.md §6.1).
- **Browsers can't set headers on a WebSocket**, so the subscribe path authenticates
  from the dev fallback locally and must use a query-param token in prod — real JWT
  verification there is part of the auth hardening (ADR 0015).
- No operational-transform/CRDT: last-write-wins positions are acceptable (ADR 0009),
  so ordering conflicts resolve by the same rule the REST path uses.
