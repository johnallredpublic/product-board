// Local stand-in for the AWS Lambda event-source mapping (Phase 11). Polls the
// table's DynamoDB stream and drives the same handler() a Lambda would.
//
//   LOCAL=1 pnpm stream:consume          # watch continuously
//   LOCAL=1 pnpm stream:consume --once   # drain what's available, then exit (tests)
//
// Reads from TRIM_HORIZON: because the consumer is idempotent, re-reading history
// is harmless (every replay is a no-op).

import type { DynamoDBStreamEvent } from 'aws-lambda'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBStreamsClient, DescribeStreamCommand, GetShardIteratorCommand, GetRecordsCommand,
} from '@aws-sdk/client-dynamodb-streams'
import { handler } from '../src/handlers/stream-consumer.js'
import { TABLE } from '../src/db/table.js'

const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000'
const creds = { accessKeyId: 'x', secretAccessKey: 'x' }
const once = process.argv.includes('--once')

const dynamo = new DynamoDBClient({ endpoint: ENDPOINT, region: 'local', credentials: creds })
const streams = new DynamoDBStreamsClient({ endpoint: ENDPOINT, region: 'local', credentials: creds })

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

function toEvent(records: any[]): DynamoDBStreamEvent {
  return {
    Records: records.map(r => ({
      eventID: r.eventID,
      eventName: r.eventName,
      eventSource: 'aws:dynamodb',
      dynamodb: {
        Keys: r.dynamodb?.Keys,
        NewImage: r.dynamodb?.NewImage,
        OldImage: r.dynamodb?.OldImage,
        SequenceNumber: r.dynamodb?.SequenceNumber,
        ApproximateCreationDateTime: r.dynamodb?.ApproximateCreationDateTime
          ? Math.floor(new Date(r.dynamodb.ApproximateCreationDateTime).getTime() / 1000)
          : undefined,
        StreamViewType: r.dynamodb?.StreamViewType,
      },
    })),
  } as DynamoDBStreamEvent
}

async function streamArn(): Promise<string> {
  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: TABLE }))
  const arn = Table?.LatestStreamArn
  if (!arn) throw new Error('Table has no stream — run `pnpm db:reset` to recreate with Streams.')
  return arn
}

async function pollShard(arn: string, shardId: string) {
  let it = (await streams.send(new GetShardIteratorCommand({
    StreamArn: arn, ShardId: shardId, ShardIteratorType: 'TRIM_HORIZON',
  }))).ShardIterator

  while (it) {
    const res = await streams.send(new GetRecordsCommand({ ShardIterator: it, Limit: 100 }))
    if (res.Records?.length) {
      const out = await handler(toEvent(res.Records))
      const failed = out.batchItemFailures.length
      console.log(`processed ${res.Records.length} record(s)${failed ? `, ${failed} failed` : ''}`)
    } else if (once) {
      break // caught up
    } else {
      await delay(1000)
    }
    it = res.NextShardIterator
  }
}

const arn = await streamArn()
const { StreamDescription } = await streams.send(new DescribeStreamCommand({ StreamArn: arn }))
const shards = StreamDescription?.Shards ?? []
console.log(`polling ${shards.length} shard(s) of ${TABLE}${once ? ' (once)' : ''}`)

await Promise.all(shards.map(s => pollShard(arn, s.ShardId!)))
if (once) console.log('caught up.')
