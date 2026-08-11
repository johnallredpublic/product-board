# ADR 0012: Split media processing, keep everything else together

## Status

Accepted (2026-08-11)

## Context

The system could be decomposed along many lines: boards, placements, products,
catalog, assets, notifications, identity. The question is where, if anywhere, a
service boundary is justified.

The default assumption should be against splitting. A distributed system converts
every in-process call into a network call that can fail, time out, or arrive
twice; removes cross-service transactions; and multiplies operational overhead by
service count. A monolith with clean internal module boundaries retains most of
the organizational benefit at none of that cost.

Splitting is justified when a component has genuinely different characteristics
along at least one axis that matters.

Image processing is the one component that does:

- **Different scaling profile.** Bursty and CPU-heavy, while the API is steady
  and IO-bound.
- **Different resource needs.** Sharp requires substantial memory and a native
  binary that inflates the deployment bundle.
- **Different failure tolerance.** A thumbnail failing to generate should not
  affect anyone using a board.
- **Clean data ownership.** It owns asset records and nothing else writes them.
- **Genuinely asynchronous.** Nothing waits on it synchronously.

Boards, placements, products, and the catalog have none of these properties
relative to each other. They change together, share a data model, and are read in
the same request.

## Decision

Extract media processing into its own deployable service with its own CDK stack,
its own queue and DLQ, and its own Lambda configuration.

**Everything else stays in one service.** Boards, placements, products, and
catalog remain together.

Media owns asset records. The API service does not write them.

## Consequences

- Media can scale, fail, and deploy independently of the API.
- Its memory-heavy, native-dependency deployment is isolated from the API's
  bundle.
- A media outage degrades gracefully: uploads still succeed, boards still render
  with placeholders, images appear when the service recovers.
- **Two deployments, two sets of logs, two alarm sets.** Real operational
  overhead for one boundary.
- **A contract to maintain between them**, versioned and backward compatible.
- **Debugging now spans services** and requires correlation IDs propagated across
  an async boundary, which does not happen automatically.
- **Asset state is eventually consistent** with the product record.
- Splitting further would produce a distributed monolith: the remaining entities
  are queried together and change together, so separating them would add network
  hops and coordination without buying independence. If deployment friction on
  the core service becomes a real observed problem, that judgment is worth
  revisiting, but it should be driven by evidence, not by architectural
  preference.
