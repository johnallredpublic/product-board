# Assortment at scale — system design

**Scope.** This describes a version of Assortment serving **500 tenants and 10,000
concurrent users** — a system we are deliberately *not* building yet. What existed at
the first draft (single-region, single-table DynamoDB, a Fastify API, a media service
split off over EventBridge, a canvas client) was the starting point; this document is
where it goes when the load justifies it. Every significant choice names its
tradeoff, and the last section says what I would deliberately defer.

> **Implementation status (2026-08-12).** This is still a forward-looking design, but
> much of it is now built at single-region / dev scale. **Implemented:** the API
> surface in §3 (including add/remove placement and product edit); tenant-in-partition
> -key, a central key-builder, and JWKS signature verification (§5); field-level
> product merge (§6.2); reserved-concurrency bulkheads and opt-in write-sharding
> (§6.3); OpenSearch search with a DynamoDB off-switch (§6.4); immutable keys, origin
> shield, and private presigned delivery (§6.5); canary deploys with alarm rollback,
> reconciliation, and correlation IDs (§7–§8). Real-time (§6.1) works locally via
> in-process broadcast. **Still target-only:** the API Gateway WebSocket tier +
> DynamoDB connection registry + fan-out Lambda (§4/§6.1), IAM `LeadingKeys` and
> tenant-prefixed *products* (§5), per-tenant-tier queues (§6.3), a web client token
> flow for a real IdP, and every §9 deferral. See the README's "Done / Still open" and
> `docs/adr/` for detail.

---

## 1. Requirements and assumptions

**Functional**
- Tenants organize products onto pan/zoom boards; positions persist.
- Multiple users edit the same board **concurrently** and see each other's moves in
  near-real-time.
- Products carry images; uploads generate derivatives asynchronously.
- Users browse/filter a catalog of thousands of products per tenant.

**Non-functional (the numbers that drive decisions)**
- **Scale:** 500 tenants, 10,000 concurrent users, peak during synchronized "line
  review" sessions where a tenant's team (~50 people) is on one board at once.
- **Latency budget:** board load **p99 < 300 ms**; a peer's move visible **p95 <
  500 ms**; image derivatives ready **< 30 s** (async, tolerant).
- **Availability:** **99.9%** single-region. Not 99.99% — see §9.
- **Consistency:** a board's placements are **read-your-writes** within an editing
  session (optimistic locking, as built in Phase 7). Summaries, activity feeds,
  and search are **eventually consistent** and the UI shows that honestly.
- **Durability:** no lost placements; a lost *thumbnail* is recoverable (reprocess).

**Assumptions stated explicitly** (a good design answer starts here)
- Read-heavy: board loads and catalog browsing dominate; writes spike only during
  line reviews.
- Tenants are mutually distrusting; isolation is a hard requirement, not a feature.
- Images are the bulk of storage; records are tiny.
- A single AWS region is acceptable for launch; data-residency/multi-region is a
  later, customer-driven requirement.

---

## 2. Back-of-envelope (estimate only what changes a decision)

- **Placement records:** 500 tenants × 20 boards × 300 placements ≈ **3M items** ×
  ~200 B ≈ **600 MB**. Trivial for DynamoDB — *volume is not the constraint;
  access patterns and hot partitions are.*
- **Products:** ~2.5M items; one **hot tenant at 50k products** is the outlier that
  shapes the catalog design (§6.3).
- **Images:** 2.5M products × (~2 MB original + ~100 KB of derivatives) ≈ **5 TB**
  in S3, ~250 GB of derivatives served hot. → CloudFront is mandatory, not optional.
- **Write rate:** moves debounce to ~2.5 writes/s per active dragger; ~200
  simultaneous draggers at peak ≈ **~500 writes/s**, bursty. On-demand absorbs it.
- **Real-time fan-out:** 500 writes/s × ~20 viewers/board ≈ **~10k messages/s** to
  push. *This*, not the database, is the scaling story (§6.1).
- **Connections:** 10k concurrent **WebSocket** connections to hold open.

---

## 3. The API contract (for a platform, the interface is the product)

REST for request/response, WebSocket for live updates.

```
GET    /api/boards                      → boards in the caller's tenant
POST   /api/boards                      → create board
GET    /api/boards/:id                  → BoardView (board + placements + products), one round trip
POST   /api/boards/:id/placements       → add a product to the board
PATCH  /api/boards/:id/placements       → batched moves, optimistic-locked (409 on conflict)
DELETE /api/boards/:id/placements/:pid  → remove a placement
GET    /api/boards/:id/events           → activity feed (newest first)
POST   /api/products/:id/assets         → presigned upload URL (bytes go browser→S3)
PATCH  /api/products/:id                → edit a product (field-level merge)
GET    /api/catalog?filter=...          → search/filter (OpenSearch, or a DynamoDB scan when off)

WS     /realtime  (subscribe boardId)   → { PlacementMoved, PlacementAdded, PlacementRemoved }
```

Contracts are **Zod schemas in a shared package**, versioned; consumers are
tolerant readers (ADR 0013). Tenant is **never** a request parameter — it is
derived from the auth token (§5).

---

## 4. Architecture and the primary request paths

Same shape as today, scaled: CloudFront (static app + `/api/*`), API on Lambda
behind an HTTP API, DynamoDB single-table with Streams, EventBridge, the media
service, and — new at this scale — an **API Gateway WebSocket** tier, a **connection
registry**, and an **OpenSearch** read model.

**Board load** (`GET /api/boards/:id`): one Query returns board `#META` +
placements (item collection as a precomputed join), then a `BatchGet` hydrates
products. p99 < 300 ms; measured at 77 ms for 200 placements locally.

**Tile move (real-time):** client optimistically moves → debounced `PATCH` →
conditional `TransactWrite` (optimistic lock) → **DynamoDB Stream** emits the change
→ stream consumer writes the change-event (transactional outbox, Phase 8) and
publishes `PlacementMoved` to EventBridge → a **fan-out Lambda** looks up the
board's active connections and pushes to each peer's WebSocket. The mover already
sees their own change locally; peers see it p95 < 500 ms later.

**Image upload:** `POST …/assets` returns a presigned URL and emits
`AssetUploadRequested`; media records the pending asset, processes on `ObjectCreated`,
emits `AssetProcessed`; the API applies it to the product (Phase 10). Fully async;
the board renders placeholders until derivatives land.

---

## 5. Multi-tenancy

**Pooled, not siloed.** One table, tenant encoded in the partition key
(`TENANT#<t>#BOARD#<id>` — now implemented for the board aggregate via a central
key-builder; products remain `PROD#<id>` for now). A table (or stack) *per tenant*
is rejected at 500 tenants: it multiplies operational surface, capacity planning,
and deploy risk by tenant count for no isolation benefit a scoped key can't give.

**Isolation, defense in depth:**
- **Tenant comes from the token, never the request.** The `tenantId` claim is
  injected server-side into every key. A client cannot ask for another tenant's
  board because it cannot name the partition.
- **This is the BOLA class** (Broken Object Level Authorization) — the most common
  API vulnerability. Every read/write is scoped by the token's tenant; there is no
  code path where an id from the URL selects a partition on its own.
- **IAM session policies** for a second layer: the request handler assumes a
  short-lived role with a `dynamodb:LeadingKeys` condition pinned to the tenant, so
  even a logic bug can't cross tenants at the AWS level.

**Cost:** every query must carry the tenant prefix; a forgotten prefix is a bug
class, so it's centralized in one key-builder module and covered by tests.

---

## 6. The hard problems (a decision and a tradeoff each)

### 6.1 Real-time collaboration
**Decision:** API Gateway **WebSocket** + a **connection registry** in DynamoDB
(`CONN#<boardId>` items with a TTL so dead connections self-evict). On `PlacementMoved`,
a fan-out Lambda queries the board's connections and posts to each. Reconnect:
client re-fetches the board (`GET`) to resync, then resubscribes — the socket
carries deltas, not truth.
**Tradeoff:** fan-out cost is O(viewers) per write; a 200-viewer board at peak is a
hot fan-out. Mitigations: batch deltas per board per ~100 ms; shard fan-out by
connection range. **Deferred:** operational-transform/CRDT sync — unnecessary when
LWW positions are acceptable (§6.2).

### 6.2 Concurrent editing
**Decision:** keep **optimistic locking with last-write-wins for positions** (built
in Phase 7 / ADR 0009). Two users dragging the *same* tile: one wins, the loser's
client reloads. For non-positional fields (name, price), **field-level merge**.
**Tradeoff:** LWW can lose an in-flight drag on a rare same-tile collision — cheap
and correct enough for spatial arrangement. **CRDTs** would make every edit
mergeable but add substantial client/server complexity and payload size;
unjustified until customers report real conflict pain.

### 6.3 Hot tenants and hot partitions
**Decision:** the **bulkhead pattern** — isolate blast radius by tier. Separate SQS
queues and **reserved Lambda concurrency** per tenant tier so one tenant's bulk
import can't starve others. For the 50k-product tenant: paginated catalog reads via
GSI, and **write-sharding** a hot board's partition (suffix the key with a shard
number, scatter-gather on read) if a single viral board exceeds a partition's
throughput.
**Tradeoff:** sharding complicates reads (fan-in) and is only worth it for proven
hotspots — apply per-board, by evidence, not everywhere.

### 6.4 Search and filtering
**Decision:** **OpenSearch fed by DynamoDB Streams.** Twenty arbitrary filter
combinations across product attributes is not a key-value access pattern; forcing it
into DynamoDB means scans or a GSI per filter. Streams project products into an
index; the catalog route queries OpenSearch.
**Tradeoff:** a second datastore to operate, and **eventual consistency** — a
just-edited product may lag in search by seconds. Acceptable for browse; the
authoritative product record stays in DynamoDB.

### 6.5 Image delivery at scale
**Decision:** **CloudFront** in front of the S3 derivatives, **immutable** caching
(the key contains a UUID, so content never changes — Phase 4), origin shield to
collapse origin fetches. Private-tenant assets use signed URLs/cookies.
**Tradeoff:** cache invalidation is a non-issue by design (immutable keys), but
per-tenant signed delivery adds URL-signing on the read path; batch-sign at board
load.

---

## 7. Failure modes (what breaks first, and the blast radius)

- **A viral board** overwhelms fan-out before it overwhelms the DB → back-pressure
  deltas, shard fan-out, degrade to poll-on-interval if the socket tier saturates.
- **DynamoDB hot partition** on one board's writes → write-sharding (§6.3);
  meanwhile on-demand throttles return 429 and the client's debounce retries.
- **OpenSearch falls behind** the stream → search is stale, browse still works, the
  DB remains authoritative; alarm on stream iterator age.
- **Media outage** → uploads still succeed (S3 direct), boards render placeholders,
  images appear on recovery (graceful degradation, ADR 0012). DLQ + alarm.
- **Bad deploy** → blast radius bounded by **canary/gradual Lambda deploys** with
  automatic rollback on error-rate alarm; the media split means a media bug can't
  take down boards.
- **The consumer breaks for a day** → **reconciliation** (Phase 12) rebuilds the
  drifted read models without replaying an expired stream.

---

## 8. Operations

- **Deploy:** CDK, two stacks (core + media), gradual Lambda traffic shifting with
  CloudWatch-alarm rollback. Same-origin via CloudFront (no CORS, first-party
  cookies).
- **Capacity:** DynamoDB on-demand at launch; switch hot tables to
  provisioned + autoscaling once traffic is predictable, for cost.
- **Migrations:** single-table is rigid (ADR 0004) — additive attributes are free;
  new access patterns need a new GSI or a **Streams-driven backfill**. Never a
  big-bang migration.
- **Monitoring:** the Phase 11 alarms — **DLQ depth > 0**, stream **iterator age**,
  API **5xx / p99**, DynamoDB **throttles**, reconciliation **discrepancy count**,
  WebSocket connection count and fan-out latency. Alert on symptoms ("board load
  failing"), not causes ("CPU high"). Correlation IDs propagate across every async
  hop.
- **On-call:** runbooks keyed to each alarm; the DLQ is the first place to look.

---

## 9. What I would defer, and why (right-sizing is the senior signal)

- **Multi-region active-active.** 99.9% in one region meets the target; active-active
  triples cost and forces conflict resolution on global writes. Revisit when a
  contract demands 99.99% or data residency — customer-driven, not preemptive.
- **CRDTs / OT.** LWW positions are acceptable; adopt only if real conflict pain
  appears (§6.2).
- **Per-tenant tables / full siloing.** Only if a regulated customer requires
  physical isolation; the pooled model with scoped keys + IAM covers the rest.
- **A service mesh / more service splits.** Two services is the right number
  (ADR 0012); more would be a distributed monolith. Split further only on evidence
  of divergent scaling or ownership.
- **GraphQL / a BFF layer.** The REST + WebSocket contract is sufficient; add an
  aggregation layer only if client round-trips become a measured problem.

Proposing global active-active and CRDTs for a fifty-person company is enthusiasm,
not judgment. The design above scales to the stated numbers and names the exit
ramps for when the numbers change.
