# @assortment/infra

AWS CDK (TypeScript) — two stacks that deploy the whole system.

- **`AssortmentCore`** — DynamoDB table (Streams enabled) + GSI1, the stream
  consumer with its event-source mapping and DLQ, the API Lambda (Fastify) behind
  an HTTP API, the EventBridge bus + notification queue/DLQ/Lambda, the shared
  assets bucket, the Angular build in S3 served through CloudFront (OAC, same-origin
  `/api/*`, 404→`index.html`), the nightly reconciliation schedule, alarms, and
  14-day log retention.
- **`AssortmentMedia`** — the media service: the Sharp processing Lambda (its own
  DLQ), triggered by S3 `Object Created` (via EventBridge) and by `AssetUploadRequested`.

## Commands

```bash
pnpm --filter @assortment/infra synth     # bundle handlers + cdk synth (no AWS needed)
pnpm --filter @assortment/infra deploy    # bundle + cdk deploy --all (needs AWS creds)
```

`synth`/`deploy` first run `bundle.mjs`, which esbuilds each handler to
`dist/<name>/index.mjs`. Our source uses NodeNext `.js` import specifiers that
resolve to `.ts`; a small esbuild plugin maps them. `@aws-sdk/*` (on the runtime)
and `sharp` (a layer) are left external. The web assets come from
`packages/web/dist/web/browser`, so run `pnpm --filter @assortment/web build` first.

## Deploy notes / decisions

- **Sharp** is a native binary that can't be esbuild-bundled, so it ships as a
  **Lambda layer**. Set `SHARP_LAYER_ARN` (per region) before deploy; the code
  falls back to a placeholder ARN so `synth` stays valid.
- The **assets bucket lives in core**, not media, to avoid a cross-stack dependency
  cycle (the API presigns uploads to it; media reads/writes derivatives). S3 object
  events reach media through **EventBridge** rather than a direct bucket→function
  notification, for the same reason.
- `cdk synth` runs fully offline and is the CI gate; `cdk deploy` needs credentials
  and a bootstrapped account (`cdk bootstrap`).
