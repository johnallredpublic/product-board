import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { withCorrelationId } from '../obs/observability.js'

const BUS = process.env.EVENT_BUS_NAME
const SOURCE = 'assortment.board'

const client = new EventBridgeClient({
  // adaptive = backoff + JITTER. Without jitter, retries from many clients
  // synchronize into waves — a retry storm that keeps the system down after the
  // original trigger clears. That's a metastable failure.
  maxAttempts: 4,
  retryMode: 'adaptive',
  ...(process.env.LOCAL
    ? {
        endpoint: process.env.EVENTBRIDGE_ENDPOINT ?? 'http://localhost:4566',
        region: 'us-east-1',
        credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      }
    : {}),
})

/**
 * Publish a domain event. Distinct from the raw DynamoDB stream record: a stream
 * record is a table-row diff coupled to our schema; a domain event is a statement
 * about the business that consumers can depend on.
 *
 * No-ops when no bus is configured — the bus, rules, and targets are provisioned
 * by CDK in Phase 11, so locally this stays quiet unless EVENT_BUS_NAME is set.
 */
export async function publishDomainEvent(
  detailType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!BUS) return
  await client.send(new PutEventsCommand({
    Entries: [{
      EventBusName: BUS,
      Source: SOURCE,
      DetailType: detailType,
      // Carry the correlation id in the payload so the trace survives the hop.
      Detail: JSON.stringify(withCorrelationId(detail)),
    }],
  }))
}
