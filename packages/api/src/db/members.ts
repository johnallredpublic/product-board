import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from './table.js'
import { boardPk } from './keys.js'

// Board membership: who has loaded or edited a board. Stored in the board's
// (tenant-scoped) partition (SK MEMBER#<userId>), team-sized. This is the subscriber
// list the notification consumer fans out to. getBoardView / the stream consumer
// ignore these items (they key on #META / ITEM#).

export async function recordBoardMember(tenantId: string, boardId: string, userId: string): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: boardPk(tenantId, boardId),
      SK: `MEMBER#${userId}`,
      userId,
      lastSeenAt: new Date().toISOString(),
    },
  }))
}

export async function listBoardMembers(tenantId: string, boardId: string): Promise<string[]> {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :m)',
    ExpressionAttributeValues: { ':pk': boardPk(tenantId, boardId), ':m': 'MEMBER#' },
  }))
  return Items.map(i => String(i.userId))
}
