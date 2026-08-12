import type { SQSEvent, SQSBatchResponse } from 'aws-lambda'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from '../db/table.js'
import { runWithCorrelation, newCorrelationId } from '../obs/correlation.js'
import { recordMetric, flushMetrics } from '../obs/observability.js'

export interface Notification { eventId: string; boardId: string; text: string }
export interface Subscriber { userId: string }

/** Injected so the batching/idempotency logic can be unit-tested without AWS. */
export interface NotifyDeps {
  findSubscribers(detail: any): Promise<Subscriber[]>
  /** Must be idempotent: at-least-once means the same digest can be attempted twice. */
  sendDigestOnce(userId: string, items: Notification[], digestKey: string): Promise<void>
}

/** Deterministic key from the content, so a redelivered batch dedupes on send. */
function digestKey(userId: string, items: Notification[]): string {
  return `${userId}:${items.map(i => i.eventId).sort().join(',')}`
}

function toNotification(detail: any): Notification {
  return {
    eventId: String(detail.eventId),
    boardId: String(detail.boardId),
    text: `Placement ${String(detail.placementId).slice(0, 8)} moved`,
  }
}

export function createNotifyHandler(deps: NotifyDeps) {
  return async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
    const failures: { itemIdentifier: string }[] = []

    // Group by recipient so a bulk update becomes ONE digest, not N emails — the
    // part most naive implementations get wrong.
    const byRecipient = new Map<string, Notification[]>()

    for (const record of event.Records) {
      try {
        const detail = JSON.parse(record.body)
        // Bind the correlation id carried in the event so downstream logs join the
        // same trace across the EventBridge -> SQS boundary.
        const correlationId = detail.correlationId ?? newCorrelationId()
        await runWithCorrelation(correlationId, async () => {
          for (const s of await deps.findSubscribers(detail)) {
            const list = byRecipient.get(s.userId) ?? []
            list.push(toNotification(detail))
            byRecipient.set(s.userId, list)
          }
        })
      } catch {
        failures.push({ itemIdentifier: record.messageId })
      }
    }

    for (const [userId, items] of byRecipient) {
      await deps.sendDigestOnce(userId, items, digestKey(userId, items))
    }

    recordMetric('DigestsSent', byRecipient.size)
    flushMetrics()
    return { batchItemFailures: failures }
  }
}

// ─── Default wiring (used by the real Lambda in Phase 11) ─────────────────────

const defaultDeps: NotifyDeps = {
  // A real subscriber model (board watchers) is Phase 13 design work.
  async findSubscribers() {
    return []
  },
  async sendDigestOnce(userId, items, key) {
    try {
      // Idempotency guard: only the first attempt writes (and would "send").
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `NOTIFY#${userId}`,
          SK: `DIGEST#${key}`,
          count: items.length,
          at: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      }))
      console.log(`digest -> ${userId}: ${items.length} change(s)`) // real send goes here
    } catch (e: any) {
      if (e.name !== 'ConditionalCheckFailedException') throw e
      // Already sent — the dedupe guard doing its job.
    }
  },
}

export const handler = createNotifyHandler(defaultDeps)
