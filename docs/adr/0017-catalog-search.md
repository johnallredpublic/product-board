# ADR 0017: Catalog search via OpenSearch fed by Streams

## Status

Accepted (2026-08-12)

## Context

The catalog needs arbitrary filtering — full-text plus combinations of season,
colorway, price range, and more ([docs/DESIGN.md §6.4](../DESIGN.md)). That is not a
key-value access pattern: forcing ~20 filter combinations into DynamoDB means either
table scans or a GSI per filter. Search is a different query shape and belongs in a
different engine.

## Decision

A **separate search read model in OpenSearch, fed by DynamoDB Streams.** The stream
consumer projects product `#META` changes into an OpenSearch `products` index
(INSERT/MODIFY → index the doc; REMOVE → delete it). `GET /api/catalog` queries the
index with a `bool` of a mandatory `tenantId` term (isolation) plus optional
season/colorway/price filters and a `multi_match` over name/style/colorway.

The **same client runs locally and in prod** — an OpenSearch container on `:9200`
(security disabled) for dev, and a managed OpenSearch Service domain reached with
SigV4 in prod (chosen by `OPENSEARCH_ENDPOINT` / `LOCAL`), the same way MinIO stands
in for S3. The prod domain is provisioned in `core-stack`, with the stream consumer
granted read/write (indexing) and the API granted read (searching).

**Search is switchable off** (`SEARCH_ENABLED=false`, enabled by default). The
managed domain is the only resource in the stack that isn't free-tier, so the switch
lets a deploy skip it entirely: `core-stack` omits the `opensearch.Domain` and its
grants, and the Lambdas get `SEARCH_ENABLED=false` instead of an endpoint. With
search off, `indexProduct`/`deleteProduct` become no-ops and `GET /api/catalog` falls
back to a **DynamoDB scan of the tenant's products with in-memory filtering** — the
same filters and the same tenant-isolation guarantee, minus relevance ranking, at
O(products) per query. Correct for small/free-tier deploys; it's the exact cost that
motivates OpenSearch at scale, so the fallback is a deliberate downgrade, not a
replacement. The switch also lets local dev skip the container.

## Consequences

- Arbitrary multi-attribute filtering scales, without warping the DynamoDB key design.
- **A second datastore to operate** — another thing to run, secure, and size.
- **Eventually consistent** with the authoritative product records: a just-edited
  product may lag in search by the refresh interval. Acceptable for browse; the
  DynamoDB record stays the source of truth. (Locally we `refresh: true` on index for
  read-your-writes; prod bulk-indexes and lets the interval apply.)
- **Tenant isolation is the mandatory `tenantId` filter** on every query — the search
  equivalent of the BOLA guard on the board routes (ADR 0015).
- This is the projection/read-model pattern again (CQRS, like the board `#SUMMARY`):
  the stream is the single feed keeping the model in sync, and reconciliation would
  rebuild it if the consumer fell behind.
- **The off-switch fallback reintroduces the scan this ADR set out to avoid** — that's
  the point: it trades scale for zero standing cost, bounded to deploys small enough
  that a per-query scan is fine. Turning search back on (`SEARCH_ENABLED` unset) needs
  no data migration — the stream re-projects products as they next change, or a
  reconcile-style backfill can seed the index.
