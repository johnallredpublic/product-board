import type {
  DynamoDBStreamEvent, DynamoDBRecord, DynamoDBBatchResponse,
} from 'aws-lambda'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from '../db/table.js'
import { publishDomainEvent } from '../events/bus.js'
import { runWithCorrelation, newCorrelationId } from '../obs/correlation.js'
import { logError, recordMetric, flushMetrics } from '../obs/observability.js'
import { indexProduct, deleteProduct } from '../search/client.js'
import { getBoardMeta } from '../db/boards.js'
import { shardCountOf, countPlacements } from '../db/sharding.js'
import { boardPk, boardEventsPk, parseBoardPk } from '../db/keys.js'

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
    // Stream records don't carry a correlation id (they're DB diffs), so start a
    // fresh trace here; publishDomainEvent then propagates it downstream.
    const correlationId = newCorrelationId()
    try {
      await runWithCorrelation(correlationId, () => processRecord(record))
      recordMetric('ChangeRecordsProcessed', 1)
    } catch (err) {
      logError('stream record failed', err, { seq: record.dynamodb?.SequenceNumber, correlationId })
      // Partial batch response: only the failed records are retried, so one bad
      // record doesn't re-run the whole batch (needs ReportBatchItemFailures on
      // the event source mapping — Phase 15).
      failures.push({ itemIdentifier: record.dynamodb!.SequenceNumber! })
    }
  }

  flushMetrics()
  return { batchItemFailures: failures }
}

export async function processRecord(record: DynamoDBRecord): Promise<void> {
  const keys = unmarshall(record.dynamodb!.Keys as any)
  const sk = String(keys.SK)
  const pk = String(keys.PK)

  // Products are projected into the OpenSearch read model, fed by this stream, and a
  // price change is published as a domain event (transactional outbox, like moves).
  if (pk.startsWith('PROD#') && sk === '#META') {
    await indexProductRecord(record, pk)
    await maybePublishPriceChange(record, pk)
    return
  }

  if (!sk.startsWith('ITEM#')) return // only placements generate change events

  const oldImage = record.dynamodb!.OldImage ? unmarshall(record.dynamodb!.OldImage as any) : null
  const newImage = record.dynamodb!.NewImage ? unmarshall(record.dynamodb!.NewImage as any) : null
  // Recover tenant + board from the tenant-scoped PK (strips a #S<n> shard suffix).
  const ref = parseBoardPk(pk)
  if (!ref) return // not a board-aggregate item
  const { tenantId, boardId } = ref
  const eventId = record.dynamodb!.SequenceNumber!

  // Deterministic timestamp from the record (NOT new Date()) so a replay yields the
  // same sort key and the conditional write is a true no-op. Chronological when the
  // stream provides a creation time; still deterministic (by eventId) if it doesn't.
  const secs = record.dynamodb?.ApproximateCreationDateTime
  const at = secs ? new Date(secs * 1000).toISOString() : ''

  const placementId = sk.split('#')[2] ?? ''
  const before = oldImage ? { x: Number(oldImage.x), y: Number(oldImage.y) } : null
  const after = newImage ? { x: Number(newImage.x), y: Number(newImage.y) } : null

  await writeChangeEvent(tenantId, boardId, eventId, at, {
    type: record.eventName as 'INSERT' | 'MODIFY' | 'REMOVE',
    placementId,
    before,
    after,
    at: at || new Date().toISOString(),
  })

  // Emit a domain event for moves. No-ops locally without a bus (Phase 11 wires it).
  // tenantId rides along so notify can build the tenant-scoped board/member keys.
  if (record.eventName === 'MODIFY') {
    await publishDomainEvent('PlacementMoved', {
      version: 1, tenantId, boardId, placementId, from: before, to: after,
      at: at || new Date().toISOString(), eventId,
      actorUserId: newImage?.updatedBy ? String(newImage.updatedBy) : undefined,
    })
  }

  await updateBoardSummary(tenantId, boardId)
}

/** Project a product #META change into the OpenSearch read model. */
async function indexProductRecord(record: DynamoDBRecord, pk: string): Promise<void> {
  const productId = pk.replace('PROD#', '')
  if (record.eventName === 'REMOVE') {
    await deleteProduct(productId)
    return
  }
  const img = record.dynamodb!.NewImage ? unmarshall(record.dynamodb!.NewImage as any) : null
  if (!img) return
  await indexProduct({
    id: productId,
    tenantId: String(img.tenantId ?? ''),
    style: String(img.style ?? ''),
    name: String(img.name ?? ''),
    colorway: String(img.colorway ?? ''),
    priceCents: Number(img.priceCents ?? 0),
    season: String(img.season ?? ''),
  })
}

/**
 * The ProductPriceChanged payload for a product #META change — or null if this record
 * isn't a price change. Pure (no I/O) so the detection is unit-testable. Same outbox
 * discipline as PlacementMoved: the dedup identity is the stream `eventId`, and the
 * timestamp comes from the record (not new Date()) so a replay is deterministic.
 */
export function priceChangeEvent(record: DynamoDBRecord, pk: string): Record<string, unknown> | null {
  if (record.eventName !== 'MODIFY') return null
  const oldImg = record.dynamodb!.OldImage ? unmarshall(record.dynamodb!.OldImage as any) : null
  const newImg = record.dynamodb!.NewImage ? unmarshall(record.dynamodb!.NewImage as any) : null
  if (!oldImg || !newImg) return null
  const from = Number(oldImg.priceCents)
  const to = Number(newImg.priceCents)
  if (from === to || Number.isNaN(from) || Number.isNaN(to)) return null

  const secs = record.dynamodb?.ApproximateCreationDateTime
  return {
    version: 1,
    productId: pk.replace('PROD#', ''),
    tenantId: newImg.tenantId ? String(newImg.tenantId) : undefined,
    from, to,
    at: secs ? new Date(secs * 1000).toISOString() : new Date().toISOString(),
    eventId: record.dynamodb!.SequenceNumber!,
    actorUserId: newImg.updatedBy ? String(newImg.updatedBy) : undefined,
  }
}

async function maybePublishPriceChange(record: DynamoDBRecord, pk: string): Promise<void> {
  const evt = priceChangeEvent(record, pk)
  if (evt) await publishDomainEvent('ProductPriceChanged', evt)
}

async function writeChangeEvent(
  tenantId: string,
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
        PK: boardEventsPk(tenantId, boardId),
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
async function updateBoardSummary(tenantId: string, boardId: string): Promise<void> {
  // Count across shards for a hot board (one query when unsharded).
  const meta = await getBoardMeta(tenantId, boardId)
  const count = await countPlacements(tenantId, boardId, shardCountOf(meta))

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: boardPk(tenantId, boardId), SK: '#SUMMARY' },
    UpdateExpression: 'SET placementCount = :c, lastModified = :t',
    ExpressionAttributeValues: { ':c': count, ':t': new Date().toISOString() },
  }))
}
