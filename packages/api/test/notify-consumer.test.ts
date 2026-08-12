import { describe, it, expect } from 'vitest'
import type { SQSEvent } from 'aws-lambda'
import { createNotifyHandler, type NotifyDeps } from '../src/handlers/notify-consumer.js'
import { getCorrelationId } from '../src/obs/correlation.js'

// Pure unit test: the batching/idempotency logic with injected deps. No AWS.

function sqsEvent(bodies: unknown[]): SQSEvent {
  return {
    Records: bodies.map((b, i) => ({ messageId: `m${i}`, body: JSON.stringify(b) })),
  } as SQSEvent
}

describe('notify consumer', () => {
  it('collapses many records for one recipient into a single digest', async () => {
    const sent: { userId: string; count: number }[] = []
    const deps: NotifyDeps = {
      findSubscribers: async () => [{ userId: 'u1' }],
      sendDigestOnce: async (userId, items) => { sent.push({ userId, count: items.length }) },
    }
    const event = sqsEvent(
      Array.from({ length: 500 }, (_, i) => ({ eventId: `e${i}`, boardId: 'b', placementId: `p${i}` })),
    )

    const res = await createNotifyHandler(deps)(event)

    expect(res.batchItemFailures).toEqual([])
    expect(sent).toHaveLength(1)          // 1 digest, not 500 emails
    expect(sent[0]).toEqual({ userId: 'u1', count: 500 })
  })

  it('sends one digest per recipient', async () => {
    const sent: string[] = []
    const deps: NotifyDeps = {
      findSubscribers: async () => [{ userId: 'u1' }, { userId: 'u2' }],
      sendDigestOnce: async (u) => { sent.push(u) },
    }
    await createNotifyHandler(deps)(sqsEvent([{ eventId: 'e1', boardId: 'b', placementId: 'p' }]))
    expect(sent.sort()).toEqual(['u1', 'u2'])
  })

  it('produces a stable digest key across redeliveries (idempotency)', async () => {
    const keys: string[] = []
    const deps: NotifyDeps = {
      findSubscribers: async () => [{ userId: 'u1' }],
      sendDigestOnce: async (_u, _i, key) => { keys.push(key) },
    }
    const h = createNotifyHandler(deps)
    // Same content, different order — the key must be identical (sorted eventIds).
    await h(sqsEvent([{ eventId: 'e2', boardId: 'b', placementId: 'p' }, { eventId: 'e1', boardId: 'b', placementId: 'q' }]))
    await h(sqsEvent([{ eventId: 'e1', boardId: 'b', placementId: 'q' }, { eventId: 'e2', boardId: 'b', placementId: 'p' }]))
    expect(keys[0]).toBe(keys[1])
  })

  it('binds the correlation id carried in the event (cross-boundary trace)', async () => {
    let seen: string | undefined
    const deps: NotifyDeps = {
      findSubscribers: async () => { seen = getCorrelationId(); return [] },
      sendDigestOnce: async () => {},
    }
    await createNotifyHandler(deps)(
      sqsEvent([{ eventId: 'e1', boardId: 'b', placementId: 'p', correlationId: 'trace-42' }]),
    )
    expect(seen).toBe('trace-42')
  })

  it('reports only the poison record in batchItemFailures', async () => {
    const deps: NotifyDeps = {
      findSubscribers: async () => [{ userId: 'u1' }],
      sendDigestOnce: async () => {},
    }
    const event = {
      Records: [
        { messageId: 'good', body: JSON.stringify({ eventId: 'e1', boardId: 'b', placementId: 'p' }) },
        { messageId: 'bad', body: 'not-json{' },
      ],
    } as SQSEvent
    const res = await createNotifyHandler(deps)(event)
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }])
  })
})
