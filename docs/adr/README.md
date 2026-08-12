# Architecture Decision Records

This directory holds the record of significant architectural decisions made on
this project: what was decided, why, and what it cost.

## Why these exist

Code shows *what* was built. It almost never shows *why*. The reasoning behind a
decision lives in a chat thread, a whiteboard nobody photographed, or one
person's head, and within a year or two it is gone. Someone new arrives, looks
at a design that seems strange, and has no way to tell whether it was a
considered tradeoff or an accident.

An ADR puts the reasoning in version control next to the code it explains, so
that a future reader can distinguish "this was deliberate, here are the
constraints" from "nobody thought about it."

The format was proposed by Michael Nygard in 2011 and is now widely used.

## Format

One decision per file. Five sections. Keep it to a page.

- **Status**: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN, with a date
- **Context**: the forces at play, written so a reader in three years can tell
  whether they still hold
- **Decision**: what we are doing, stated plainly and in the active voice
- **Consequences**: what follows, good and bad. Both are required.

### On each section

**Status** carries more weight than it appears to. A decision that changes does
not get edited: you write a *new* ADR and mark the old one
`Superseded by ADR-NNNN`. The superseded record stays in place, unmodified.
The trajectory of what the team believed over time is more useful than a tidy
snapshot of the current position.

**Context** should describe the situation, not the solution. Write it in terms
of constraints that were true when the decision was made.

**Consequences is the section that does the work**, and specifically the
negative half. Every real architectural choice costs something. An ADR listing
only benefits is marketing, and an experienced reader will discount the whole
set.

## What deserves an ADR

Write one when the decision is **expensive to reverse**, or when a reasonable
engineer could have chosen differently. Data storage, API contract strategy,
auth approach, rendering strategy, deployment topology, anything that becomes an
interface others build against.

## What does not

Decisions with one obvious answer, anything trivially reversible, coding
conventions, formatting, and lint configuration.

The test: **would this be painful to unwind in a year?** If not, skip it.

## Conventions here

- Files are numbered sequentially and never renumbered
- Filenames are descriptive, so the directory listing works as a table of contents
- One page maximum
- Superseded records stay. Nothing is deleted from this directory.

## A habit worth adopting

When you reach a decision point and feel uncertain, **write the Context section
before you decide.** Articulating the constraints usually makes the answer
obvious, and it produces a more honest record than reverse-engineering a
rationale after the fact.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-monorepo-pnpm-workspaces.md) | Monorepo with pnpm workspaces | Accepted |
| [0002](0002-angular-with-signals.md) | Angular with standalone components and signals | Accepted |
| [0003](0003-canvas-for-board-rendering.md) | Canvas 2D for board rendering | Accepted |
| [0004](0004-dynamodb-single-table.md) | DynamoDB with single-table design | Accepted |
| [0005](0005-s3-presigned-uploads.md) | S3 with presigned uploads | Accepted |
| [0006](0006-fastify-on-lambda.md) | Fastify on Lambda | Accepted |
| [0007](0007-zod-contract-generated-openapi.md) | Zod as the contract, OpenAPI generated | Accepted |
| [0008](0008-debounced-drag-persistence.md) | Debounced persistence on drag | Accepted |
| [0009](0009-optimistic-locking.md) | Optimistic locking for placements | Accepted |
| [0010](0010-aws-cdk-for-infrastructure.md) | AWS CDK for infrastructure | Accepted |
| [0011](0011-dynamodb-streams-for-change-propagation.md) | DynamoDB Streams for change propagation | Accepted |
| [0012](0012-single-service-split-media.md) | Split media processing, keep everything else together | Accepted |
| [0013](0013-async-only-between-services.md) | Asynchronous communication only between services | Accepted |
| [0014](0014-idempotent-consumers.md) | Idempotent consumers via deterministic IDs | Accepted |
| [0015](0015-auth-and-tenancy.md) | Authentication and multi-tenancy | Accepted; superseded in part by 0020 |
| [0016](0016-realtime-collaboration.md) | Real-time collaboration over WebSocket | Accepted |
| [0017](0017-catalog-search.md) | Catalog search via OpenSearch fed by Streams | Accepted |
| [0018](0018-hot-tenant-handling.md) | Hot-tenant handling (bulkheads + write-sharding) | Accepted |
| [0019](0019-placement-lifecycle-and-product-editing.md) | Placement lifecycle and product editing | Accepted |
| [0020](0020-auth-verification-and-tenant-keys.md) | JWT signature verification and tenant-in-partition-key | Accepted |
| [0021](0021-asset-delivery-and-canary-deploys.md) | Private asset delivery and canary deploys | Accepted |
