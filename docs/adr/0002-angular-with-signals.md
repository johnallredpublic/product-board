# ADR 0002: Angular with standalone components and signals

## Status

Accepted (2026-08-11)

## Context

The client is a data-dense application whose central surface is a canvas-based
board holding hundreds of interactive items, alongside conventional list and
form views.

The framework choice is constrained externally: this project exists in part to
build fluency in a specific stack, and Angular is that stack.

Within Angular there is still a real decision. The framework has two coexisting
models: the older NgModule-based architecture with zone.js change detection, and
the newer standalone-component architecture with signals. Both are supported.
Material written before roughly 2023 describes the older one.

The canvas board makes change detection performance a first-order concern. A
zone.js-driven check triggered by every pointer event during a drag would be
wasteful given that the canvas repaints itself.

## Decision

Angular 19+ using standalone components, signals for state, `inject()` for
dependency injection, and the `@if` / `@for` control flow syntax.

`ChangeDetectionStrategy.OnPush` on every component.

RxJS retained only where it is genuinely the right tool: HTTP calls, and
debounced or cancellable streams via `switchMap`. Bridged to signals with
`toSignal` and `toObservable`.

## Consequences

- Fine-grained reactivity: a signal change updates only the DOM that reads it,
  rather than triggering a component-tree check.
- `OnPush` is effectively free with signals, so the performance-conscious default
  costs nothing.
- `input.required<T>()` makes a missing input a build error rather than a runtime
  surprise.
- Signals inside `effect()` give a clean bridge from reactive state to the
  imperative canvas render loop.
- Most Angular material online predates this model, so answers found by search
  frequently describe patterns that are no longer idiomatic.
- Anyone joining who knows Angular from before 2023 needs to relearn the state
  model.
- RxJS cannot be avoided entirely, so the codebase carries two async models. The
  boundary between them must be maintained deliberately or it becomes confusing.
