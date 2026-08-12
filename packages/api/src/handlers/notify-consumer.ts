import type { SQSEvent, SQSBatchResponse } from 'aws-lambda'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from '../db/table.js'
import { runWithCorrelation, newCorrelationId } from '../obs/correlation.js'
import { recordMetric, flushMetrics } from '../obs/observability.js'
import { listBoardMembers } from '../db/members.js'
import { boardsContainingProduct } from '../db/boards.js'

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
  // Two event shapes flow through this queue: a placement move (has boardId +
  // placementId) and a product price change (has productId, no boardId).
  if (detail?.productId && detail?.boardId == null) {
    return {
      eventId: String(detail.eventId),
      boardId: '',
      text: `Product ${String(detail.productId).slice(0, 8)} price changed to $${(Number(detail.to) / 100).toFixed(2)}`,
    }
  }
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

/**
 * A board's subscribers are its members (anyone who's loaded or edited it), minus
 * the actor who caused the event — you don't get notified of your own move.
 */
export async function boardMemberSubscribers(detail: any): Promise<Subscriber[]> {
  const tenantId = String(detail?.tenantId ?? '')
  const boardId = String(detail?.boardId ?? '')
  if (!tenantId || !boardId) return []
  const members = await listBoardMembers(tenantId, boardId)
  return members
    .filter(userId => userId !== detail?.actorUserId)
    .map(userId => ({ userId }))
}

/**
 * A product event's subscribers are the members of every board the product sits on
 * (access pattern 5 via GSI1), unioned and minus the actor. This is what "lights up"
 * ProductPriceChanged — a price edit notifies everyone watching an affected board.
 * The tenant rides in on the event so the (tenant-scoped) board keys can be built.
 */
export async function productSubscribers(detail: any): Promise<Subscriber[]> {
  const tenantId = String(detail?.tenantId ?? '')
  const productId = String(detail?.productId ?? '')
  if (!tenantId || !productId) return []
  const boardIds = await boardsContainingProduct(productId)
  const memberLists = await Promise.all(boardIds.map(boardId => listBoardMembers(tenantId, boardId)))
  const members = new Set(memberLists.flat())
  return [...members]
    .filter(userId => userId !== detail?.actorUserId)
    .map(userId => ({ userId }))
}

/** Route an event to the right subscriber resolver by its shape. */
export async function findSubscribers(detail: any): Promise<Subscriber[]> {
  if (detail?.boardId) return boardMemberSubscribers(detail)
  if (detail?.productId) return productSubscribers(detail)
  return []
}

const defaultDeps: NotifyDeps = {
  findSubscribers,
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
