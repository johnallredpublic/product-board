import { ScanCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from '../db/table.js'
import { logger, recordMetric, flushMetrics } from '../obs/observability.js'
import { countPlacements, shardCountOf } from '../db/sharding.js'
import { boardPk, parseBoardPk } from '../db/keys.js'

// Every eventually-consistent projection drifts eventually — stream records expire,
// consumers have bugs, DLQ messages get abandoned. The #SUMMARY read model
// (Phase 8) will eventually disagree with the placements it counts. This job finds
// and REPAIRS that drift, and it doubles as the recovery path: if the stream
// consumer is broken for a day, reconciliation catches up without replaying a
// stream that may have expired. Runs nightly on an EventBridge schedule (Phase 15).

export interface Discrepancy {
  boardId: string
  expected: number
  found: number | null
}

/** Enumerate every board (tenant + id + shardCount) by scanning for its #META item. */
async function* iterateBoards(): AsyncGenerator<{ tenantId: string; boardId: string; shardCount: number }> {
  let ExclusiveStartKey: Record<string, any> | undefined
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE,
      // Board #META keys are TENANT#<t>#BOARD#<id>; `contains` picks boards out of the
      // #META items (products are PROD#<id>#META and don't contain '#BOARD#').
      FilterExpression: 'SK = :meta AND contains(PK, :b)',
      ExpressionAttributeValues: { ':meta': '#META', ':b': '#BOARD#' },
      ProjectionExpression: 'PK, shardCount',
      ExclusiveStartKey,
    }))
    for (const item of page.Items ?? []) {
      const ref = parseBoardPk(String(item.PK))
      if (ref) yield { tenantId: ref.tenantId, boardId: ref.boardId, shardCount: shardCountOf(item) }
    }
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
}

async function getBoardSummaryCount(tenantId: string, boardId: string): Promise<number | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: boardPk(tenantId, boardId), SK: '#SUMMARY' },
  }))
  return typeof Item?.placementCount === 'number' ? Item.placementCount : null
}

async function repairBoardSummary(tenantId: string, boardId: string, actual: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: boardPk(tenantId, boardId), SK: '#SUMMARY' },
    UpdateExpression: 'SET placementCount = :c, lastReconciled = :t',
    ExpressionAttributeValues: { ':c': actual, ':t': new Date().toISOString() },
  }))
}

export async function reconcileBoardSummaries(): Promise<Discrepancy[]> {
  const discrepancies: Discrepancy[] = []

  for await (const { tenantId, boardId, shardCount } of iterateBoards()) {
    const [actual, found] = await Promise.all([
      countPlacements(tenantId, boardId, shardCount),
      getBoardSummaryCount(tenantId, boardId),
    ])
    if (found !== actual) {
      discrepancies.push({ boardId, expected: actual, found })
      await repairBoardSummary(tenantId, boardId, actual) // repair, don't just report
    }
  }

  // Emit the count as a metric and alarm on it (Phase 15): a job that silently
  // repairs is hiding a bug — rising drift means something upstream is broken.
  recordMetric('ReconciliationDiscrepancies', discrepancies.length)
  flushMetrics()

  if (discrepancies.length > 0) {
    // Log WHAT was repaired — the pattern in what drifts tells you where the bug is.
    logger.warn('repaired summary drift', { discrepancies })
  }

  return discrepancies
}

/** Lambda entry point for the nightly EventBridge schedule (Phase 15). */
export async function handler(): Promise<void> {
  await reconcileBoardSummaries()
}
