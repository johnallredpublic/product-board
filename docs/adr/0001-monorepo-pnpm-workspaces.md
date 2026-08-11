# ADR 0001: Monorepo with pnpm workspaces

## Status

Accepted (2026-08-11)

## Context

The project has three code artifacts that are developed together: an Angular
web client, a Node API, and a set of shared type definitions and validation
schemas that both sides depend on.

The shared package is the problem. The client and server must agree on the shape
of every request and response. If they live in separate repositories, sharing
those types requires publishing a package: version it, publish to a registry,
bump the dependency on both sides, open two pull requests. Every contract change
becomes a release process, and the two sides can drift between releases.

There is one developer on this project and no requirement for independent
release cadences between the client and the API.

## Decision

A single repository using pnpm workspaces, with packages under `packages/` and
infrastructure code under `infra/`.

pnpm specifically, over npm or yarn workspaces, for its content-addressable
store (one copy of each dependency on disk, hard-linked into each package) and
its strict non-flat `node_modules`, which prevents importing a transitive
dependency that was never declared.

Local packages are referenced with `workspace:*`, so pnpm symlinks them rather
than resolving from a registry.

## Consequences

- Contract changes are one commit and one CI run. A mismatch between client and
  server is a compile error before it can merge.
- Editing the shared package is immediately visible to its consumers with no
  build-and-publish loop.
- One lockfile covers everything, so builds are reproducible across the whole
  project rather than per package.
- CI runs every package on every change until filtering is added. Acceptable at
  four packages; would justify Turborepo or Nx above roughly ten, or once CI
  exceeds five minutes.
- pnpm's strictness will surface phantom-dependency errors that npm would have
  silently allowed. This is the desired behavior but it costs time on first
  encounter.
- Independent versioning of the packages is not possible without additional
  tooling. Not currently needed.
- Access control cannot be split by package. Irrelevant here, would matter with
  multiple teams.
