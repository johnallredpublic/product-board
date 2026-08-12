import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { ddb, TABLE } from '../src/db/table.js'
import { indexProduct, searchProducts, type ProductDoc } from '../src/search/client.js'

// The search subsystem is optional (SEARCH_ENABLED=false — the free-tier switch).
// With it off, indexing is a no-op and the catalog is served straight from DynamoDB.
// searchEnabled() reads the env per call, so we flip it for this file and restore it.

const tenant = randomUUID()
const otherTenant = randomUUID()
let prev: string | undefined

const putProduct = (over: Partial<ProductDoc>) => {
  const p: ProductDoc = {
    id: randomUUID(), tenantId: tenant, style: 'S', name: 'Item',
    colorway: 'Black', priceCents: 1000, season: 'FA26', ...over,
  }
  return ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PROD#${p.id}`, SK: '#META', tenantId: p.tenantId,
    style: p.style, name: p.name, colorway: p.colorway, priceCents: p.priceCents, season: p.season,
  }}))
}

beforeAll(async () => {
  prev = process.env.SEARCH_ENABLED
  process.env.SEARCH_ENABLED = 'false'
  await putProduct({ style: 'RUN1', name: 'Trail Runner', colorway: 'Black', priceCents: 12000, season: 'FA26' })
  await putProduct({ style: 'BOOT1', name: 'Winter Boot', colorway: 'Brown', priceCents: 20000, season: 'FA26' })
  await putProduct({ style: 'SAND1', name: 'Summer Sandal', colorway: 'Tan', priceCents: 5000, season: 'SP26' })
  await putProduct({ tenantId: otherTenant, name: 'Secret Runner', colorway: 'Black' })
})

afterAll(() => {
  if (prev === undefined) delete process.env.SEARCH_ENABLED
  else process.env.SEARCH_ENABLED = prev
})

describe('catalog with search disabled (DynamoDB fallback)', () => {
  it('indexing is a no-op and does not throw', async () => {
    await expect(indexProduct({
      id: randomUUID(), tenantId: tenant, style: 'X', name: 'X', colorway: 'X', priceCents: 1, season: 'X',
    })).resolves.toBeUndefined()
  })

  it('full-text-ish match stays within the tenant (no cross-tenant leak)', async () => {
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
})
