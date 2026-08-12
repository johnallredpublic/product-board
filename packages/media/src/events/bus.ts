import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'

const BUS = process.env.EVENT_BUS_NAME
const SOURCE = 'assortment.media' // media's events carry its own source

const client = new EventBridgeClient({
  maxAttempts: 4,
  retryMode: 'adaptive', // backoff + jitter
  ...(process.env.LOCAL
    ? {
        endpoint: process.env.EVENTBRIDGE_ENDPOINT ?? 'http://localhost:4566',
        region: 'us-east-1',
        credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      }
    : {}),
})

/** Publish a domain event. No-ops without a configured bus (wired by CDK, Phase 11). */
export async function publishDomainEvent(
  detailType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!BUS) return
  await client.send(new PutEventsCommand({
    Entries: [{ EventBusName: BUS, Source: SOURCE, DetailType: detailType, Detail: JSON.stringify(detail) }],
  }))
}
