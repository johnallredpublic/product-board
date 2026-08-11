# ADR 0008: Debounced persistence on drag

## Status

Accepted (2026-08-11)

## Context

Dragging tiles on the board is the primary interaction. A pointer move event
fires at display refresh rate, typically 60 times per second, and a drag may
move a multi-selection of dozens of items.

Writing to DynamoDB on every move event would produce thousands of writes per
drag, throttle the table, cost real money, and provide no user benefit since only
the final position matters.

Not persisting until some explicit save action would mean losing work if the tab
closes mid-session, and would require a save button that the interaction model
does not otherwise need.

## Decision

Local state updates immediately and optimistically on every pointer move, so the
UI is never waiting on the network.

Persistence is decoupled and debounced: a 400ms trailing debounce during
sustained dragging, plus an immediate flush on pointer up.

Moves accumulate into a pending set and are sent as one batched request.

On failure, the affected IDs return to the pending set and retry on the next
flush. On a version conflict, the board reloads.

## Consequences

- The interaction is smooth regardless of network latency, because rendering
  never waits on a request.
- One write per drag gesture instead of hundreds.
- Multi-item moves are one request rather than N.
- **A crash or tab close mid-drag loses up to 400ms of movement.** Acceptable:
  the user was mid-gesture and the loss is a small position delta, not data.
- **Optimistic local state can diverge from the server** if a write fails
  silently. Mitigated by the retry path and by reloading on conflict, but the
  window exists.
- The debounce interval is a guess. Too short and it defeats the purpose; too
  long and more work is at risk. 400ms should be validated against real usage.
- Reloading the whole board on conflict is heavy-handed. It is correct and
  simple; a merge strategy would be better UX and considerably more complex. See
  ADR 0009.
