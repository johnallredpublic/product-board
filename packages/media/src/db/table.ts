// Media's own DynamoDB client. It shares the physical table with the API but owns
// only the ASSET# key space (ADR 0012 — the IAM-scoped compromise "at this scale").
// A production media stack would enforce that boundary with a scoped IAM policy.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

const client = new DynamoDBClient(
  process.env.LOCAL
    ? { endpoint: 'http://localhost:8000', region: 'local', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }
    : {},
)

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
})

export const TABLE = process.env.TABLE_NAME ?? 'assortment'
