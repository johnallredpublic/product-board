# product-board
A collaborative assortment board. Products live in a catalog with images. Users arrange them on an infinite canvas board, panning, zooming, selecting, and dragging tiles. Positions persist.

## Testing

The test pyramid (Phase 14):

| Layer | Where | What |
|---|---|---|
| **Unit** | `web` (Karma/Jasmine, **headless Chrome**) | Pure canvas geometry (`worldToScreen`/`screenToWorld` round-trip), `BoardStore` logic via TestBed |
| **Integration** | `api` + `media` (Vitest vs. **real** DynamoDB Local + MinIO) | Every route/consumer/job against real infra — never mocked; incl. optimistic-locking, stream idempotency, poison-batch, reconciliation |
| **E2E** | `web` (Playwright) | Load a board, move a placement, reload, confirm it persisted |

```bash
docker compose up -d                       # integration + E2E need real infra

pnpm test                                  # all packages (web unit is headless now)
pnpm --filter @assortment/api test         # just the API/media integration suite
pnpm --filter @assortment/web test         # web unit tests (needs Google Chrome)
pnpm --filter @assortment/web e2e          # Playwright E2E (needs the API running)
```

Notes:
- Web unit tests run under **`ChromeHeadless`** (uses the installed Chrome; set
  `CHROME_BIN` if auto-detection fails), so root `pnpm test` is CI-safe.
- The Playwright E2E uses `channel: 'chrome'` (the installed Google Chrome — **no
  browser download**) and expects the API on `:3000`
  (`LOCAL=1 pnpm --filter @assortment/api dev`).
- **Never mock the database** — mocked tests pass while key conditions are wrong.
  Cross-service flows (Streams → EventBridge → SQS) are covered by testing
  consumers as **pure functions** with synthetic events; a full **LocalStack**
  integration (via `@testcontainers/localstack`, already a dev dep) is the
  remaining option for exercising the real bus end-to-end.
