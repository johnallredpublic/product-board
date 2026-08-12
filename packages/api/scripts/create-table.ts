// Creates the single DynamoDB table on DynamoDB Local for local development.
//
//   pnpm db:create            create if absent (idempotent)
//   pnpm db:reset             drop and recreate (--recreate)
//
// Prod table creation lives in infra/ (CDK, Phase 15); this is the local mirror.
// Override the endpoint/name with DDB_ENDPOINT / TABLE_NAME if needed.

import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, DeleteTableCommand,
} from '@aws-sdk/client-dynamodb'

const TABLE = process.env.TABLE_NAME ?? 'assortment'
const client = new DynamoDBClient({
  endpoint: process.env.DDB_ENDPOINT ?? 'http://localhost:8000',
  region: 'local',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
})

const recreate = process.argv.includes('--recreate')

async function exists(): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE }))
    return true
  } catch {
    return false
  }
}

if (await exists()) {
  if (!recreate) {
    console.log(`table "${TABLE}" already exists — nothing to do (pass --recreate to rebuild)`)
    process.exit(0)
  }
  await client.send(new DeleteTableCommand({ TableName: TABLE }))
  console.log(`dropped existing table "${TABLE}"`)
}

await client.send(new CreateTableCommand({
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'GSI1PK', AttributeType: 'S' },
    { AttributeName: 'GSI1SK', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: [{
    IndexName: 'GSI1',
    KeySchema: [
      { AttributeName: 'GSI1PK', KeyType: 'HASH' },
      { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  }],
}))

console.log(`created table "${TABLE}" with overloaded GSI1 (serves access patterns 5 + 6)`)
