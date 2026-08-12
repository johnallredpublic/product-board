# ADR 0021: Private asset delivery and canary deploys

## Status

Accepted (2026-08-12)

## Context

Two operational gaps from [DESIGN.md](../DESIGN.md) were still open:

- **§6.5 image delivery.** The assets bucket is `BlockPublicAccess.BLOCK_ALL`, but the
  asset reference stored on a product was a **public base URL** (`ASSET_BASE_URL/<key>`)
  that resolves to nothing in prod — so there was no working, private delivery path for
  derivatives.
- **§8 deploys.** The API Lambda was deployed as a single `$LATEST` behind the HTTP API:
  a bad deploy hit 100% of traffic instantly, with no automatic rollback.

## Decision

**Private delivery via presigned GET, batch-signed at board load.** A processed asset is
now **stored as derivative keys** (`key128`/`key512`), never a URL. When a `BoardView` is
built, each product's asset is signed into **short-lived presigned GET URLs**
(`s3/signAssetGet` → `products/signAsset`, default 1 h TTL). The bucket stays fully
private; the browser reads derivatives with a URL that expires, and a reload re-signs.
Signing is a local HMAC (no network call), so signing every product on a board load is
cheap. The same signing runs on the product-edit response and the realtime add-broadcast.
In front of S3, CloudFront gains **origin shield** (a regional caching tier that collapses
origin fetches so a cold or viral edge can't stampede S3 / the API).

**Canary deploys with automatic rollback.** The HTTP API now targets a Lambda **alias**,
not the raw function. A CodeDeploy `LambdaDeploymentGroup`
(`CANARY_10PERCENT_5MINUTES`) shifts 10% of traffic to a new version for five minutes
while watching an **errors alarm** on the alias; a breach (or a failed/stopped
deployment) rolls traffic back to the previous version automatically.

## Consequences

- **Derivatives are deliverable and private** — no public bucket, no CloudFront signing
  keys to manage. The tradeoff is that URLs expire (a board open past the TTL re-signs on
  reload) and each board load signs N URLs (cheap, local). The stored/contract split is
  clean: `StoredAsset` (keys) in DynamoDB, `AssetRef` (signed URLs) in the API response.
- **A bad API deploy is contained** to ~10% of requests for a few minutes instead of
  everyone, and self-heals via rollback. Cost: deploys take longer (the bake window).
  Only the API (the request path) is canaried; async consumers deploy all-at-once, which
  is fine — their DLQs + alarms already bound a bad batch.
- **Origin shield adds a small per-request hop** but cuts origin load sharply under fan-out
  — the right trade for image-heavy, cacheable traffic.
- **Deploy-only pieces remain deploy-only**: the canary bake and rollback can't be
  exercised without an actual `cdk deploy`; `cdk synth` verifies the wiring (alias +
  deployment group + alarm + origin shield all appear in the template).
- The asset **stored shape changed** (keys, not URLs); pre-existing records with the old
  URL shape would sign to `null` (no `key128`) and render as placeholders until
  reprocessed — acceptable given there's no production data.
