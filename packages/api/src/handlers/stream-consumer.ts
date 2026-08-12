import type {
  DynamoDBStreamEvent, DynamoDBRecord, DynamoDBBatchResponse,
} from 'aws-lambda'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from '../db/table.js'
import { publishDomainEvent } from '../events/bus.js'

// ─── The transactional outbox, for free ──────────────────────────────────────
// The stream IS the change log, produced atomically with each write — so there's
// no dual-write problem (write the row, then publish, and the second can fail).
//
// Delivery is AT-LEAST-ONCE: Lambda retries and records can be redelivered, so a
// duplicate is the contract, not a bug. We make the handler idempotent BY
// CONSTRUCTION: the event's dedup identity is the stream SequenceNumber, and the
// write is conditional — a replay produces the same key and becomes a no-op.

export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const failures: { itemIdentifier: string }[] = []

  for (const record of event.Records) {
    try {
      await processRecord(record)
    } catch (err) {
      console.error({ err, seq: record.dynamodb?.SequenceNumber }, 'stream record failed')
      // Partial batch response: only the failed records are retried, so one bad
      // record doesn't re-run the whole batch (needs ReportBatchItemFailures on
      // the event source mapping — Phase 11).
      failures.push({ itemIdentifier: record.dynamodb!.SequenceNumber! })
    }
  }

  return { batchItemFailures: failures }
}

export async function processRecord(record: DynamoDBRecord): Promise<void> {
  const keys = unmarshall(record.dynamodb!.Keys as any)
  const sk = String(keys.SK)
  if (!sk.startsWith('ITEM#')) return // only placements generate change events

  const oldImage = record.dynamodb!.OldImage ? unmarshall(record.dynamodb!.OldImage as any) : null
  const newImage = record.dynamodb!.NewImage ? unmarshall(record.dynamodb!.NewImage as any) : null
  const boardId = String(keys.PK).replace('BOARD#', '')
  const eventId = record.dynamodb!.SequenceNumber!

  // Deterministic timestamp from the record (NOT new Date()) so a replay yields the
  // same sort key and the conditional write is a true no-op. Chronological when the
  // stream provides a creation time; still deterministic (by eventId) if it doesn't.
  const secs = record.dynamodb?.ApproximateCreationDateTime
  const at = secs ? new Date(secs * 1000).toISOString() : ''

  const placementId = sk.split('#')[2] ?? ''
  const before = oldImage ? { x: Number(oldImage.x), y: Number(oldImage.y) } : null
  const after = newImage ? { x: Number(newImage.x), y: Number(newImage.y) } : null

  await writeChangeEvent(boardId, eventId, at, {
    type: record.eventName as 'INSERT' | 'MODIFY' | 'REMOVE',
    placementId,
    before,
    after,
    at: at || new Date().toISOString(),
  })

  // Emit a domain event for moves. No-ops locally without a bus (Phase 11 wires it).
  if (record.eventName === 'MODIFY') {
    await publishDomainEvent('PlacementMoved', {
      version: 1, boardId, placementId, from: before, to: after,
      at: at || new Date().toISOString(), eventId,
    })
  }

  await updateBoardSummary(boardId)
}

async function writeChangeEvent(
  boardId: string,
  eventId: string,
  at: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        // Own partition: change events grow without bound; keeping them out of the
        // board's item collection avoids a hot partition. TTL expires them.
        PK: `BOARD#${boardId}#EVT`,
        SK: `EVT#${at}#${eventId}`,
        eventId,
        ...body,
        ttl: Math.floor(Date.now() / 1000) + 90 * 86400, // 90 days
      },
      ConditionExpression: 'attribute_not_exists(SK)',
    }))
  } catch (e: any) {
    if (e.name !== 'ConditionalCheckFailedException') throw e
    // Already processed — the idempotency guard doing its job.
  }
}

/**
 * CQRS read model: keep a denormalized #SUMMARY (placement count + last modified)
 * in sync via the stream. It's eventually consistent — a move may show a stale
 * count for a second or two — which is acceptable and is why reconciliation
 * (Phase 12) exists.
 */
async function updateBoardSummary(boardId: string): Promise<void> {
  const { Count = 0 } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :i)',
    ExpressionAttributeValues: { ':pk': `BOARD#${boardId}`, ':i': 'ITEM#' },
    Select: 'COUNT',
  }))

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `BOARD#${boardId}`, SK: '#SUMMARY' },
    UpdateExpression: 'SET placementCount = :c, lastModified = :t',
    ExpressionAttributeValues: { ':c': Count, ':t': new Date().toISOString() },
  }))
}
