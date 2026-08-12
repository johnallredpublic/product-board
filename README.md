# product-board (Assortment)

A collaborative assortment board: products live in a catalog with images; users
arrange them on an infinite HTML5-canvas board — panning, zooming, selecting, and
dragging tiles — and positions persist. Built on Angular + Canvas + Node/Fastify +
DynamoDB + S3 + the AWS event-driven stack.

## Architecture at a glance

```
Browser (Angular + Canvas)
        │  HTTPS (same origin via CloudFront)
        ▼
CloudFront ──/api/*──▶ HTTP API ──▶ API Lambda (Fastify)
        │                                    │  writes
        └──static──▶ S3 (web)                ▼
                                    DynamoDB (single table) ──Streams──▶ Stream consumer Lambda
                                        ▲                                    │ change events (outbox)
                          presigned PUT │                                    ▼
Browser ─────────────────▶ S3 (assets) ─Object Created─▶ EventBridge ──▶ Media Lambda (Sharp)
                                                              │                │ AssetProcessed
                                                              ├──▶ SQS ──▶ Notify Lambda (digests)
                                                              └──▶ Reconcile Lambda (nightly)
```

Two deployables: the **core** service (boards/placements/products/API/web) and the
**media** service (image processing), split deliberately — see
[ADR 0012](docs/adr/0012-single-service-split-media.md). The full reasoning behind
every choice is in [docs/adr/](docs/adr/); the scale-up design is in
[docs/DESIGN.md](docs/DESIGN.md).

## Repository layout

```
packages/
  shared/   @assortment/shared   Zod contract shared by client + server
  api/      @assortment/api      Fastify API, DynamoDB, S3, stream/notify/reconcile handlers
  media/    @assortment/media    image derivative service (Sharp)
  web/      @assortment/web      Angular 20 app + the canvas board
infra/      @assortment/infra    AWS CDK — two stacks (core + media)
docs/       ADRs + DESIGN.md
```

## Prerequisites

- **Node 22** and **pnpm 11** (`packageManager` is pinned).
- **Docker** — DynamoDB Local + MinIO for local dev. If `docker` isn't on your PATH,
  Docker Desktop keeps its CLI at
  `/Applications/Docker.app/Contents/Resources/bin` (add it, or open Docker Desktop).
- **Google Chrome** — for `web` unit tests and the Playwright E2E.
- For deploy only: an **AWS account**, credentials, and the **AWS CDK** (bundled as a
  dev dependency in `infra`).

## Run it locally

```bash
pnpm install                                   # 1. install the workspace
docker compose up -d                           # 2. DynamoDB Local, MinIO, OpenSearch (:9200)
pnpm --filter @assortment/api db:create        # 3. create the table (PK/SK + GSI1 + Streams)
pnpm --filter @assortment/api s3:create        # 4. create the assets bucket in MinIO
pnpm --filter @assortment/api search:setup     # 5. create the OpenSearch products index (skip if SEARCH_ENABLED=false)
pnpm --filter @assortment/api seed:demo        # 6. seed a demo board (prints a board id + URL)

# 7. start both servers (two terminals)
LOCAL=1 pnpm --filter @assortment/api dev      #    API on http://localhost:3000
pnpm --filter @assortment/web start            #    web on http://localhost:4200 (proxies /api → :3000)
```

Open **http://localhost:4200**, click a board (or use the id `seed:demo` printed):
wheel to zoom, alt/middle-drag to pan, drag a tile, marquee-select empty space.
**Add** products from the catalog panel on the right; **remove** the selection with
Delete/Backspace. Drags, adds, and removals persist across reload.

To see the **event-driven** half locally, run the stream poller (the local stand-in
for the Lambda event-source mapping) in another terminal and watch change events
appear as you drag:

```bash
pnpm --filter @assortment/api stream:consume   # drains DynamoDB Local's stream → the consumer
curl http://localhost:3000/api/boards/<id>/events
```

### Useful commands

| Command (prefix `pnpm --filter @assortment/api`) | Does |
|---|---|
| `db:create` / `db:reset` | create / recreate the table |
| `s3:create` | create the assets bucket |
| `seed:demo` | seed a populated, listable board |
| `stream:consume` | poll the stream and drive the consumer |
| `reconcile:run` | repair `#SUMMARY` drift (see [Phase 12](docs/DESIGN.md)) |
| `sweep:assets` | delete abandoned pending uploads |
| `bench` | time `GET /api/boards/:id` (target < 200 ms) |

## Testing

The test pyramid:

| Layer | Where | What |
|---|---|---|
| **Unit** | `web` (Karma/Jasmine, **headless Chrome**) | Canvas geometry round-trip, `BoardStore` via TestBed |
| **Integration** | `api` + `media` (Vitest vs. **real** DynamoDB Local + MinIO) | Every route/consumer/job — never mocked; optimistic-locking, stream idempotency, poison-batch, reconciliation |
| **E2E** | `web` (Playwright) | Load a board, move a placement, reload, confirm it persisted |

```bash
docker compose up -d                      # integration + E2E need real infra
pnpm test                                 # all packages (web unit is headless)
pnpm --filter @assortment/api test        # api + media integration
pnpm --filter @assortment/web test        # web unit (needs Google Chrome; set CHROME_BIN if not found)
pnpm --filter @assortment/web e2e         # Playwright E2E (needs the API on :3000)
```

Cross-service flows (Streams → EventBridge → SQS) are covered by testing consumers
as **pure functions** with synthetic events; **never mock the database** for the
integration layer. A full **LocalStack** run (`@testcontainers/localstack`, already
a dev dep) is the remaining option for exercising the real bus end-to-end.

## Deploy to AWS

The infrastructure is AWS CDK (TypeScript), two stacks. `cdk synth` runs fully
offline (the CI gate); `cdk deploy` needs credentials.

```bash
# 0. one-time per account/region
pnpm --filter @assortment/infra exec cdk bootstrap aws://<account>/<region>

# 1. build the web app (CloudFront serves it from S3)
pnpm --filter @assortment/web build

# 2. validate offline — produces CloudFormation, no AWS needed
pnpm --filter @assortment/infra synth

# 3. deploy both stacks (needs AWS creds; core first, media depends on it).
#    Choose an auth mode (see below) — deploying with NEITHER makes the API 401
#    every request. This is the throwaway-demo form:
AUTH_MODE=dev pnpm --filter @assortment/infra deploy
```

The `deploy` script bundles each handler (esbuild → `infra/dist/*`) and builds the
Sharp Lambda layer (a cross-install for linux/arm64 — needs npm network access, **not**
Docker), then runs `cdk deploy --all`. On success, `AssortmentCore` outputs **`CdnUrl`**
(open this — it's the app) and **`ApiUrl`**.

**Choose an auth mode — the app is unusable without one.** The API takes the tenant
from the caller's identity, resolved per the env set at deploy time:

- **Dev mode (throwaway demo, INSECURE):** `AUTH_MODE=dev`. Every request resolves to a
  single shared `dev-tenant` / `dev-user` with **no authentication** — anyone with the
  URL has full access. This is the only mode where the app works end-to-end today, so
  it's what a free-account trial uses. Tear it down when done.
- **Real IdP (secure):** set `JWKS_URI` (+ optional `JWT_ISSUER` / `JWT_AUDIENCE`) so the
  API verifies token signatures (ADR 0020). **Caveat:** the web client does not yet send
  a token, so you'd wire a login/token flow before this path is interactively usable.
  ```bash
  JWKS_URI=https://<idp>/.well-known/jwks.json JWT_ISSUER=https://<idp>/ JWT_AUDIENCE=<app> \
    pnpm --filter @assortment/infra deploy
  ```

With neither `AUTH_MODE=dev` nor `JWKS_URI`, the API **fails closed** and returns 401 to
everything (safe default, but nothing works).

### Deploying on a free-tier account

The managed **OpenSearch domain is the one resource that isn't free-tier** (a
`t3.small.search` node + EBS, ~15–20 min to create). Turn it off with
`SEARCH_ENABLED=false` — CDK omits the domain and its grants, and the API serves the
catalog from a **DynamoDB fallback** (same tenant-scoped filters, no relevance ranking;
see [ADR 0017](docs/adr/0017-catalog-search.md)). A complete, runnable free-tier deploy —
no OpenSearch, dev auth so the app actually works:

```bash
pnpm --filter @assortment/web build                                   # 1. web assets (required)
SEARCH_ENABLED=false pnpm --filter @assortment/infra synth            # 2. verify the domain is gone
SEARCH_ENABLED=false AUTH_MODE=dev pnpm --filter @assortment/infra deploy   # 3. deploy
```

Then open the `CdnUrl` output. Everything else stays within the 12-month free tier for a
light trial (Lambda, HTTP API, CloudFront, S3, DynamoDB on-demand); a few items carry a
small non-zero cost — DynamoDB point-in-time recovery, CloudFront origin-shield requests,
and CloudWatch alarms beyond the free 10 (the stack defines 6).

The `SEARCH_ENABLED` switch works locally too: run with `SEARCH_ENABLED=false` and skip
the OpenSearch container and `search:setup` in "Run it locally". Re-enable later by
leaving it unset — no data migration; products re-project into the index as they next
change (ADR 0017).

To tear down: `pnpm --filter @assortment/infra exec cdk destroy --all` (the table and
assets bucket are `RETAIN` — delete them by hand if you really mean it).

See [infra/README.md](infra/README.md) for the stack contents and the two design
calls (assets bucket in core; S3→EventBridge to avoid a stack cycle).

## Next steps — what to finish before real use

This is a complete reference implementation of the build guide, not a
production-hardened product.

**Done** (see git history):
- ✅ **Authentication & multi-tenancy** — every request resolves `{ tenantId, userId }`
  from the token (dev-header fallback locally); boards/products are tenant-stamped and
  scoped, and cross-tenant access returns **404** (BOLA prevention). See
  [ADR 0015](docs/adr/0015-auth-and-tenancy.md).
- ✅ **Auth hardening** — bearer tokens are **signature-verified against the IdP's JWKS**
  (`jose`, with optional issuer/audience checks; fails closed if `JWKS_URI` is unset in
  prod), and the board aggregate now carries the **tenant in its partition key**
  (`TENANT#<t>#BOARD#<id>`), built in one central module so a forgotten tenant scope is
  impossible. Cross-tenant isolation is proven at the key level, not just an `if`.
  [ADR 0020](docs/adr/0020-auth-verification-and-tenant-keys.md). *Remaining:* the IAM
  `LeadingKeys` policy (deploy-only) and tenant-prefixing products (crosses into media).
- ✅ **`AssetProcessed` consumer wired** — bundle target + Lambda + EventBridge rule
  in `core-stack`, so processed images attach to products in a deployed environment.
- ✅ **Real Sharp Lambda layer** — `pnpm --filter @assortment/infra layer:sharp`
  builds the linux/arm64 binary; the media Lambda runs on ARM64 with it (ARN fallback
  for synth without the build).
- ✅ **CI/CD** — [.github/workflows/ci.yml](.github/workflows/ci.yml): typecheck all
  packages, integration tests against real DynamoDB Local + MinIO, headless web unit
  tests, web build (enforces the Angular bundle budget), and `cdk synth`.
- ✅ **Real subscriber model** — board **membership** (`MEMBER#<userId>`, recorded when
  a user loads or edits a board); `notify`'s `findSubscribers` fans out to a board's
  members **minus the actor** (the mover's `userId` rides move → stream →
  `PlacementMoved.actorUserId`), so no one is notified of their own change.

- ✅ **Real-time collaboration (local)** — WebSocket `/realtime`: subscribe to a board,
  receive peers' moves as absolute-position deltas applied to the canvas; reconnect
  resubscribes and re-fetches. In-process broadcast locally; the prod **API Gateway
  WebSocket API + connection registry + fan-out Lambda** is the remaining deploy
  wiring (ADR [0016](docs/adr/0016-realtime-collaboration.md)).
- ✅ **Catalog search** — **OpenSearch fed by Streams**: the stream consumer projects
  products into an OpenSearch index; `GET /api/catalog` runs tenant-scoped full-text +
  season/colorway/price filters, eventually consistent (ADR
  [0017](docs/adr/0017-catalog-search.md)). Real OpenSearch locally (docker) and a
  managed domain in CDK — same client both ways. **Switchable off** with
  `SEARCH_ENABLED=false` (the managed domain isn't free-tier); the catalog then falls
  back to a DynamoDB scan — see "Deploying on a free-tier account" above.
- ✅ **Hot-tenant handling** — **bulkheads** (reserved Lambda concurrency per async
  consumer, so one tenant's flood can't starve others) and **opt-in write-sharding**
  for a viral board (placements spread across `BOARD#<id>#S<n>` by a stable hash;
  reads scatter-gather; stream/summary/reconcile are shard-aware; unsharded boards are
  byte-identical). ADR [0018](docs/adr/0018-hot-tenant-handling.md).
- ✅ **Placement lifecycle & product editing** — `POST`/`DELETE` placements (add a
  catalog product to a board, remove one; both ownership-checked and broadcast live),
  and `PATCH /api/products/:id` with **field-level merge**. A price edit now flows
  through the stream as a **`ProductPriceChanged`** domain event (previously dead
  wiring) to the notify pipeline, fanned out to the members of the affected boards via
  GSI1. ADR [0019](docs/adr/0019-placement-lifecycle-and-product-editing.md).
- ✅ **Private asset delivery & canary deploys** — derivatives are stored as **keys**
  and delivered via **short-lived presigned GET URLs** batch-signed at board load (the
  bucket stays fully private), with **CloudFront origin shield** in front. The API
  Lambda deploys behind an **alias with a CodeDeploy canary** (10% for 5 min, automatic
  rollback on an errors alarm). ADR [0021](docs/adr/0021-asset-delivery-and-canary-deploys.md).

**Still open** — deploy-wiring and hardening (no new product features):
1. **Real-time prod wiring** — the API Gateway WebSocket API + fan-out Lambda in CDK
   (the local transport works and is tested; the prod transport is CDK, like the
   event-source mapping was for Streams).
2. **Finish the auth hardening at the AWS layer** — JWKS verification and tenant-in-
   partition-key are done ([ADR 0020](docs/adr/0020-auth-verification-and-tenant-keys.md));
   what remains is the IAM `LeadingKeys` session policy (deploy-only) and tenant-prefixing
   products (crosses into the media service + event contracts).
3. **Web client login/token flow** — the browser sends no bearer token, so a real-IdP
   deploy (`JWKS_URI`) isn't interactively usable yet; a hosted deploy works today only
   with `AUTH_MODE=dev`. Wiring a sign-in that attaches a token to API/WebSocket calls is
   the missing piece for a secure hosted app.
4. **Per-tenant-tier queues** — a separate bulk queue with its own concurrency, the
   next refinement past the reserved-concurrency bulkheads (DESIGN.md §6.3).
5. **Actually running `cdk deploy`** — both stacks `synth` cleanly and the wiring is
   verified there (canary group, origin shield, alias, alarms), but nothing has been
   deployed here (no AWS creds). Exercising the canary bake/rollback and the presigned
   delivery against real S3/CloudFront needs a live account.

## Documentation index

- [docs/adr/](docs/adr/) — Architecture Decision Records (start with 0003 and 0012)
- [docs/DESIGN.md](docs/DESIGN.md) — scale-up system design (500 tenants / 10k users)
- [packages/api/README.md](packages/api/README.md) — API local dev + scripts
- [infra/README.md](infra/README.md) — CDK stacks + deploy notes
