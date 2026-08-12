# @assortment/api

Fastify + DynamoDB backend for the assortment board. Runs against **DynamoDB
Local** and **MinIO** in development (see [`docker-compose.yml`](../../docker-compose.yml)),
and the same SDK code runs against real AWS in production.

## Prerequisites

1. **Dependencies installed** (from the repo root):
   ```bash
   pnpm install
   ```

2. **Containers running** (from the repo root):
   ```bash
   docker compose up -d      # DynamoDB Local :8000, MinIO :9000/:9001
   ```
   > If `docker` isn't on your PATH, Docker Desktop keeps its CLI in the app
   > bundle. Either add it once —
   > `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` — or
   > open Docker Desktop, which installs the symlinks.

## The `LOCAL` switch

[`src/db/table.ts`](src/db/table.ts) reads `process.env.LOCAL`. When set, the
DynamoDB client points at `http://localhost:8000` with dummy credentials;
otherwise it uses the default AWS credential chain. All local commands below set
it for you.

## Commands

Run these from `packages/api` (or from the repo root with
`pnpm --filter @assortment/api <script>`):

| Command | What it does |
|---|---|
| `pnpm db:create` | Create the `assortment` table on DynamoDB Local (PK/SK + overloaded GSI1). Idempotent — skips if it already exists. |
| `pnpm db:reset` | Drop and recreate the table (`--recreate`). Use after changing the key schema. |
| `LOCAL=1 pnpm dev` | Start the API with hot reload (`tsx watch`) on `:3000` (override with `PORT`). |
| `pnpm bench` | **Phase 3 checkpoint** — seed a board and time `GET /api/boards/:id`. |
| `pnpm typecheck` | `tsc --noEmit` over `src` + `scripts` (via [`tsconfig.json`](tsconfig.json)). |
| `pnpm test` | Vitest integration tests (Phase 14 — none yet). |

### First-run sequence

```bash
# from repo root
docker compose up -d
pnpm --filter @assortment/api db:create
LOCAL=1 pnpm --filter @assortment/api dev      # API now on http://localhost:3000
```

## The benchmark (Phase 3 checkpoint)

Seeds one board with N placements (default 200) and N distinct products — so
`N > 100` also exercises the `BatchGet` 100-key chunking in `getBoardView` — then
times the board-load endpoint over 10 runs after a warm-up.

```bash
LOCAL=1 pnpm bench            # 200 placements
LOCAL=1 N=500 pnpm bench      # override the count
```

The guide's target is a median **well under 200 ms** locally. It exits non-zero
if the median blows the budget, so it can gate CI later. Example run:

```
GET /api/boards/:id — 200 placements, 200 products hydrated
  warm-up : 135.8 ms
  10 runs -> min 65.7 | median 77.5 | max 95.1 ms
✅ median under the 200ms budget
```

## Notes

- The scripts under [`scripts/`](scripts/) are **local dev tooling**, not the
  production path — the real table is provisioned by `infra/` (CDK, Phase 15).
  `create-table.ts` is the local mirror of that definition.
- The benchmark seeds a fresh random board id each run, so repeated runs don't
  collide. DynamoDB Local runs in-memory (`-inMemory`), so everything is cleared
  when the container restarts.
