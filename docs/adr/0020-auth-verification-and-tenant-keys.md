# ADR 0020: JWT signature verification and tenant-in-partition-key

## Status

Accepted (2026-08-12)

## Context

Two hardening items were deferred from [ADR 0015](0015-auth-and-tenancy.md):

1. Auth **decoded** the bearer token's claims but never **verified its signature** — an
   attacker could forge any tenant/user by editing the payload.
2. Isolation was enforced only in the application layer (an ownership `if` on every
   route). [DESIGN.md §5](../DESIGN.md) calls for the tenant to live in the **partition
   key** (`TENANT#<t>#BOARD#<id>`) so it can also be enforced below the app, and so a
   forgotten tenant scope becomes structurally impossible.

## Decision

**JWKS signature verification (auth.ts).** In a non-dev environment the token is
verified with [`jose`](https://github.com/panva/jose): `createRemoteJWKSet` fetches and
caches the IdP's public keys (by `kid`, refreshed on rotation) and `jwtVerify` checks
the signature plus optional `JWT_ISSUER` / `JWT_AUDIENCE`. Config (`JWKS_URI`, issuer,
audience) is read per-request, and auth **fails closed**: a non-dev deploy with no
`JWKS_URI` rejects every request rather than trusting an unverified token. The local
dev header fallback (`LOCAL` / `AUTH_MODE=dev`) is unchanged, so seeds and offline work
keep working. `resolveAuth` is now async (the verify is I/O); the request hook and the
WebSocket handshake both await it.

**Tenant-in-partition-key for the board aggregate.** Boards, placements, change-events,
members, and the `#SUMMARY` all live under `TENANT#<tenantId>#BOARD#<boardId>` (a hot
board's shards under `…#S<n>`, its events under `…#EVT`). Every board key is built in
**one module, [db/keys.ts](../../packages/api/src/db/keys.ts)** — there is no way to
construct a board key without a tenantId, so "forgot the tenant scope" stops being a bug
class. System consumers that see all tenants (stream, reconcile) recover the tenant by
**parsing the key** (`parseBoardPk`); `PlacementMoved` now carries `tenantId` so notify
can build the tenant-scoped member keys it fans out to.

## Consequences

- **Forging a token no longer works**, and a cross-tenant read now fails at the key
  level, not just an `if` — the ownership checks remain as defense in depth. A new
  `tenancy.test.ts` proves a board created by tenant A is invisible to tenant B and is
  physically stored under the tenant-scoped PK (there is no bare `BOARD#<id>` row).
- **This unlocks, but does not itself apply, the AWS-layer enforcement.** The IAM
  `dynamodb:LeadingKeys` session policy (the request handler assuming a per-tenant role)
  is deploy-only and remains a documented next step — the key layout is now the shape it
  needs.
- **Products are deliberately NOT tenant-prefixed yet.** Their keys are read/written
  across the API *and the media service* (AssetProcessed writes a product's asset ref),
  so prefixing them means threading tenant through three event contracts and the media
  package. Out of scope here; products stay protected by the application-layer ownership
  checks (ADR 0015). This is the honest boundary of this pass.
- **A real deployment still needs the IdP wired**: set `JWKS_URI` (e.g. the Cognito
  user-pool JWKS) plus issuer/audience; without them the service fails closed by design.
- No data migration was needed here (local/seed data only); a real migration of existing
  bare-keyed rows would be a Streams-driven backfill, never a big-bang rewrite (ADR 0004).
