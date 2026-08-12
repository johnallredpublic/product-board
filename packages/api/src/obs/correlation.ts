import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

// Correlation ID carried through an async operation so every log line for one
// logical flow shares an id. A trace through a synchronous HTTP chain works
// automatically; Lambda -> Streams -> Lambda -> EventBridge -> SQS -> Lambda drops
// the context unless you deliberately propagate it (through the event payload).
// This is the single most common gap in serverless observability.

interface Ctx {
  correlationId: string
}

const als = new AsyncLocalStorage<Ctx>()

/** Run `fn` within a correlation scope (scoped: nested runs restore the parent). */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return als.run({ correlationId }, fn)
}

/** Bind a correlation id for the current async chain onward (e.g. a request hook). */
export function enterCorrelation(correlationId: string): void {
  als.enterWith({ correlationId })
}

export function getCorrelationId(): string | undefined {
  return als.getStore()?.correlationId
}

export function newCorrelationId(): string {
  return randomUUID()
}
