# ADR 0004: DynamoDB with single-table design

## Status

Accepted (2026-08-11). **Amended by [ADR 0020](0020-auth-verification-and-tenant-keys.md)**
— the board aggregate's partition keys are now tenant-prefixed (`TENANT#<t>#BOARD#<id>`,
built in one central `db/keys.ts` module); products stay `PROD#<id>`. The single-table
design and its access patterns are otherwise unchanged.

## Context

The data is a small number of entity types with well-understood relationships:
workspaces contain boards, boards contain placements, placements reference
products, products have assets.

The access patterns are enumerable and stable:

1. Get a board's metadata
2. List boards in a workspace
3. Get all placements on a board, in z-order
4. Get products by a set of IDs
5. Find every board containing a given product
6. Get a product with its assets in one call
7. Recent activity on a board, newest first

The board load path (patterns 1, 3, 4 together) is latency-sensitive and is the
most frequent operation in the product.

A relational database would serve all of this competently and would additionally
support ad hoc queries. DynamoDB offers predictable single-digit millisecond
latency at any scale, no capacity planning under on-demand billing, and no
operational surface.

## Decision

DynamoDB, single table, with generic key attributes (`PK`, `SK`, `GSI1PK`,
`GSI1SK`) and type-prefixed key values (`BOARD#`, `PROD#`, `ITEM#`).

One overloaded GSI serving both the placement-by-product reverse lookup and
product browsing by season.

Placement sort keys encode z-order as a zero-padded integer
(`ITEM#0042#<uuid>`), so a single query returns items already in draw order.

Board metadata and placements share a partition, so `#META` and `ITEM#` items
come back in one query. Change events live in a separate partition
(`BOARD#<id>#EVT`) to avoid unbounded growth in the board's item collection.

## Consequences

- All seven access patterns resolve to a single `GetItem` or `Query`. No scans.
- The item collection functions as a pre-computed join: one query returns a board
  and everything on it.
- Predictable latency regardless of data volume, and no database to operate.
- **The design is welded to this list of access patterns.** A new pattern may
  require a new GSI, a backfill, or a key migration. This rigidity is the
  principal cost.
- **No ad hoc querying.** Arbitrary filtering across twenty attributes is not
  possible here and would require a search index fed from Streams.
- No joins and no aggregations. Anything analytical needs a separate store.
- Generic key names make the table hard to read for anyone unfamiliar with the
  pattern. The access-pattern list must be maintained as documentation or the
  design becomes opaque.
- Single-table design is contested practice. A few tables grouped by entity
  cluster would be simpler to reason about at a modest cost in round trips, and
  is a defensible alternative if the access patterns prove less stable than
  expected.
