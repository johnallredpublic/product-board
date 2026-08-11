# ADR 0007: Zod as the contract, OpenAPI generated from it

## Status

Accepted (2026-08-11)

## Context

The client and server must agree on the shape of every request and response.
TypeScript types alone are insufficient because they are erased at runtime: an
annotation asserts a shape, it does not verify one. Anything crossing a network
boundary can violate its declared type and the compiler will not notice.

There are two broad approaches.

**Spec-first.** Write an OpenAPI document, review it, generate types and clients
for both sides from it. The specification becomes an artifact that is approved
before implementation. This is the stronger governance model, particularly when
a separate team or vendor implements one side.

**Code-first.** Define schemas in code, derive both the runtime validation and
the specification from them. Faster, and the spec cannot drift from the
implementation because it is generated from it. But the spec *describes* what
was built rather than constraining what should be.

This project has one developer implementing both sides, so the governance benefit
of spec-first is largely theoretical here, while its friction is real.

## Decision

Zod schemas in the shared package as the single source of truth. TypeScript types
derived via `z.infer`. OpenAPI generated from the same schemas.

Validation at every boundary:

- The server parses request bodies with the schema before using them
- The server parses its own responses in development, to catch contract drift
- The client parses responses before handing them to application code

`openapi.json` is committed, so CI can detect breaking changes between commits.

## Consequences

- One definition produces the TypeScript type, the runtime validator, and the
  API documentation. They cannot drift from each other.
- A contract violation surfaces as a clear error at the boundary rather than as
  an undefined value several frames later.
- CI can fail on a stale spec or a breaking change, so the contract is enforced
  by tooling rather than by attention.
- **This is not true spec-first.** The API defines the contract rather than
  negotiating it. If a second team or a vendor consumed this API, that would be
  the wrong arrangement and this decision should be revisited.
- Zod adds runtime cost on every request. Negligible at these payload sizes;
  would matter for very large responses, where parsing could be made
  development-only.
- Generated OpenAPI is less expressive than a hand-written spec. Some documentation
  detail is lost.
- Coupling to Zod specifically. Migrating to another validator would touch the
  entire contract layer.
