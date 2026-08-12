import { beforeAll, describe, expect, it } from 'vitest'
import type { DynamoDBRecord } from 'aws-lambda'
import { marshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'node:crypto'
import { priceChangeEvent } from '../src/handlers/stream-consumer.js'
import { productSubscribers, findSubscribers } from '../src/handlers/notify-consumer.js'
import { addPlacement } from '../src/db/boards.js'
import { recordBoardMember } from '../src/db/members.js'

// priceChangeEvent is pure (no infra). The subscriber tests hit DynamoDB Local's
// GSI1 via addPlacement + membership, so they need `docker compose up -d`.

const prod = (over: Record<string, unknown>) => ({
  PK: 'PROD#x', SK: '#META', tenantId: 't', style: 'S', name: 'N',
  colorway: 'Black', priceCents: 1000, season: 'FA26', ...over,
})

const modifyRecord = (oldImg: Record<string, unknown>, newImg: Record<string, unknown>): DynamoDBRecord => ({
  eventName: 'MODIFY',
  dynamodb: {
    Keys: marshall({ PK: 'PROD#x', SK: '#META' }),
    OldImage: marshall(oldImg),
    NewImage: marshall(newImg),
    SequenceNumber: 'SEQ1',
    ApproximateCreationDateTime: 1_700_000_000,
  },
} as unknown as DynamoDBRecord)

describe('priceChangeEvent (pure)', () => {
  it('emits from/to when the price changed', () => {
    const evt = priceChangeEvent(modifyRecord(prod({ priceCents: 1000 }), prod({ priceCents: 1500, updatedBy: 'u9' })), 'PROD#p1')
    expect(evt).toMatchObject({ version: 1, productId: 'p1', from: 1000, to: 1500, eventId: 'SEQ1', actorUserId: 'u9' })
  })

  it('returns null when the price is unchanged', () => {
    expect(priceChangeEvent(modifyRecord(prod({ priceCents: 1000 }), prod({ priceCents: 1000 })), 'PROD#p1')).toBeNull()
  })

  it('returns null for a non-MODIFY record', () => {
    const insert = { ...modifyRecord(prod({}), prod({ priceCents: 2000 })), eventName: 'INSERT' } as DynamoDBRecord
    expect(priceChangeEvent(insert, 'PROD#p1')).toBeNull()
  })
})

describe('product subscribers (notify)', () => {
  const TENANT = 'dev-tenant'
  const boardId = randomUUID()
  const productId = randomUUID()

  beforeAll(async () => {
    await recordBoardMember(TENANT, boardId, 'editor')
    await recordBoardMember(TENANT, boardId, 'viewer')
    // addPlacement stamps GSI1 (PROD#<id> / BOARD#<id>) — the link productSubscribers reads.
    await addPlacement(TENANT, boardId, { productId, x: 0, y: 0 })
  })

  it('resolves to the affected boards\' members, minus the actor', async () => {
    const subs = await productSubscribers({ tenantId: TENANT, productId, actorUserId: 'editor' })
    expect(subs.map(s => s.userId)).toEqual(['viewer'])
  })

  it('findSubscribers routes a product event to productSubscribers', async () => {
    const subs = await findSubscribers({ tenantId: TENANT, productId, actorUserId: 'editor' })
    expect(subs.map(s => s.userId)).toEqual(['viewer'])
  })

  it('findSubscribers returns nothing for an event with neither boardId nor productId', async () => {
    expect(await findSubscribers({ foo: 'bar' })).toEqual([])
  })
})
