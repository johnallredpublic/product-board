import { beforeAll, describe, expect, it } from 'vitest'
import type { DynamoDBRecord } from 'aws-lambda'
import { marshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'node:crypto'
import { ensureProductIndex, indexProduct, searchProducts, type ProductDoc } from '../src/search/client.js'
import { processRecord } from '../src/handlers/stream-consumer.js'

// Catalog search against a real OpenSearch (docker compose up -d). Uses a random
// tenant per run so it's isolated from other runs' documents.

const tenant = randomUUID()
const otherTenant = randomUUID()

const doc = (over: Partial<ProductDoc>): ProductDoc => ({
  id: randomUUID(), tenantId: tenant, style: 'S', name: 'Item', colorway: 'Black', priceCents: 1000, season: 'FA26', ...over,
})

beforeAll(async () => {
  try {
    await ensureProductIndex()
  } catch {
    throw new Error('OpenSearch not reachable at :9200 — run `docker compose up -d`')
  }
  await indexProduct(doc({ style: 'RUN1', name: 'Trail Runner', colorway: 'Black', priceCents: 12000, season: 'FA26' }))
  await indexProduct(doc({ style: 'BOOT1', name: 'Winter Boot', colorway: 'Brown', priceCents: 20000, season: 'FA26' }))
  await indexProduct(doc({ style: 'SAND1', name: 'Summer Sandal', colorway: 'Tan', priceCents: 5000, season: 'SP26' }))
  // Another tenant's product that also matches "runner" — must never leak.
  await indexProduct(doc({ tenantId: otherTenant, name: 'Secret Runner', colorway: 'Black' }))
})

describe('catalog search', () => {
  it('full-text matches within the tenant only (no cross-tenant leak)', async () => {
    const hits = await searchProducts(tenant, { q: 'runner' })
    expect(hits.map(h => h.name)).toContain('Trail Runner')
    expect(hits.every(h => h.tenantId === tenant)).toBe(true)
    expect(hits.some(h => h.name === 'Secret Runner')).toBe(false)
  })

  it('filters by season', async () => {
    const hits = await searchProducts(tenant, { season: 'SP26' })
    expect(hits.map(h => h.name)).toEqual(['Summer Sandal'])
  })

  it('filters by price range', async () => {
    const hits = await searchProducts(tenant, { minPrice: 15000 })
    expect(hits.map(h => h.name)).toEqual(['Winter Boot'])
  })

  it('combines filters (colorway + season)', async () => {
    const hits = await searchProducts(tenant, { colorway: 'Black', season: 'FA26' })
    expect(hits.map(h => h.name)).toEqual(['Trail Runner'])
  })

  it('is fed by the stream: a projected product becomes searchable', async () => {
    const id = randomUUID()
    const rec = {
      eventName: 'INSERT',
      dynamodb: {
        Keys: marshall({ PK: `PROD#${id}`, SK: '#META' }),
        NewImage: marshall({
          PK: `PROD#${id}`, SK: '#META', tenantId: tenant,
          style: 'STR1', name: 'Streamed Sneaker', colorway: 'Red', priceCents: 8000, season: 'FA26',
        }),
        SequenceNumber: 'S1', StreamViewType: 'NEW_AND_OLD_IMAGES',
      },
    } as unknown as DynamoDBRecord

    await processRecord(rec)

    const hits = await searchProducts(tenant, { q: 'streamed' })
    expect(hits.map(h => h.id)).toContain(id)
  })
})
