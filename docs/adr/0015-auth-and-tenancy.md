# ADR 0015: Authentication and multi-tenancy

## Status

Accepted (2026-08-12). **Superseded in part by [ADR 0020](0020-auth-verification-and-tenant-keys.md)**:
the two "not yet" items in Consequences below — JWT signature verification, and
tenant-in-partition-key — are now implemented there. The rest of this record stands.

## Context

The system launched with no authentication and no tenant isolation: keys were
`BOARD#<id>` and any caller who reached the API could read any board. Assortment is
multi-tenant and tenants are mutually distrusting, so this is the top blocker before
real data. The scale-up design ([docs/DESIGN.md §5](../DESIGN.md)) specifies the
target: the tenant comes from the caller's token (never a request parameter), lives
in the partition key, and is enforced with IAM `LeadingKeys` session policies as
defense in depth. This ADR records what we implemented now and why it stops short of
that full form.

## Decision

**Identity comes from the token, on every request.** An auth plugin resolves
`{ tenantId, userId }` and hangs it on `req.auth`. In production a bearer JWT
supplies the claims; locally (`LOCAL` / `AUTH_MODE=dev`) `x-tenant-id` / `x-user-id`
headers (defaulting to `dev-tenant` / `dev-user`) keep the app and seeds usable
without an IdP. The tenant is **never** taken from a URL or body.

**The workspace is the tenant.** Boards are listed under `WS#<tenantId>`, and every
board's and product's `#META` is stamped with its `tenantId`.

**Ownership is enforced at every board/product route (application layer).** A read or
write for a board/product whose `tenantId` doesn't match the caller's returns **404**
(not 403) — so a valid id in another tenant is indistinguishable from a missing one.
This is the BOLA (Broken Object Level Authorization) defense.

## Consequences

- Cross-tenant access is blocked: the BOLA test asserts a known board id in the wrong
  tenant reads as 404.
- The app keeps working locally with zero auth ceremony (dev fallback), while any
  non-local environment requires a token.
- **This is application-layer enforcement, not key-level.** Keys are still
  `BOARD#<id>`, not `TENANT#<t>#BOARD#<id>`. The full form — tenant in the partition
  key plus IAM `LeadingKeys` — is stronger (it survives an application bug) and remains
  the documented next step (DESIGN.md §5). Adopting it is a key-migration, backfilled
  via Streams.
  > **Corrected 2026-08-12 (ADR 0020):** the board aggregate is now tenant-prefixed in
  > the partition key (`TENANT#<t>#BOARD#<id>`), built in one central `db/keys.ts`
  > module. IAM `LeadingKeys` (deploy-only) and tenant-prefixing products remain open.
- **JWT verification is not complete.** The plugin decodes claims but does not yet
  verify the signature against the IdP's JWKS (e.g. Cognito) — that must be wired
  before production; a decoded-but-unverified token is trusted today.
  > **Corrected 2026-08-12 (ADR 0020):** no longer true — bearer tokens are now
  > signature-verified against the IdP's JWKS (optional issuer/audience checks), and
  > auth **fails closed** when `JWKS_URI` is unset outside dev.
- Hydrated products in a board view are fetched by the board's own placement
  references and not individually re-checked against the tenant; normal data is
  same-tenant, but the stronger key-level scheme would make this impossible by
  construction.
- System jobs (stream consumer, reconciliation, notifications) run cross-tenant by
  design and carry no tenant context.
