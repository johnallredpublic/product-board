# ADR 0006: Fastify on Lambda

## Status

Accepted (2026-08-11)

## Context

The API serves a small number of routes with low steady traffic and unpredictable
bursts. It is not latency-critical in the sub-50ms sense, but board loads should
feel instant.

Two decisions are bundled here: the HTTP framework and the compute model.

**Framework.** Express is the most widely known but its TypeScript support is
retrofitted and it has no built-in schema validation. Fastify has first-class
TypeScript types, integrated schema handling, and better throughput. Hono is a
newer option optimized for edge runtimes.

**Compute.** Lambda costs nothing at idle and scales automatically, at the cost
of cold starts and a 15-minute ceiling. Fargate has no cold starts and is cheaper
under sustained load, but costs money continuously and requires capacity
decisions.

Given bursty, low-average traffic and a strong preference for no operational
surface, the idle cost matters more than the cold start.

## Decision

Fastify, running as a single Lambda behind an API Gateway HTTP API.

HTTP API rather than REST API: roughly 70% cheaper, lower latency, and none of
the REST-only features (request transformation, usage plans, WAF integration) are
needed.

Lambda memory set to 1024MB initially, to be tuned by measurement rather than
assumption.

## Consequences

- No servers to operate, no capacity planning, nothing paid at idle.
- Fastify's TypeScript integration means route handlers are typed without
  additional plumbing.
- **Cold starts add latency on the first request to a new execution environment**,
  typically a few hundred milliseconds for a Node bundle. Acceptable for this
  workload; would justify provisioned concurrency if the API became
  latency-critical.
- **Lambda is more expensive than containers under sustained high load.** The
  crossover point is roughly consistent high utilization. Worth re-examining if
  traffic becomes steady rather than bursty.
- Running a full HTTP framework inside Lambda adds bundle size and a small amount
  of per-invocation overhead compared to a bare handler. The tradeoff is local
  development parity and route organization.
- Module-scope state persists across invocations in the same execution
  environment. This is desirable for SDK clients and dangerous for anything
  request-specific. Must be a review checkpoint.
- 15-minute execution ceiling. Nothing currently approaches it; long-running work
  would need a different compute model.
