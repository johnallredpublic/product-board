import { Client } from '@opensearch-project/opensearch'
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { listProductsByTenant } from '../db/products.js'

// Search read model (ADR 0017 / DESIGN.md §6.4): products are projected into
// OpenSearch by the stream consumer and queried here. Locally this is the
// OpenSearch container on :9200 (security disabled); in prod it's a managed domain
// reached with SigV4 — the same client either way (like MinIO stands in for S3).

const INDEX = 'products'
const ENDPOINT = process.env.OPENSEARCH_ENDPOINT ?? 'http://localhost:9200'

// The whole search subsystem is optional. Set SEARCH_ENABLED=false to run without
// OpenSearch — the managed domain is the one resource that isn't free-tier, so the
// switch lets a deploy skip it (CDK omits the domain) and lets local dev skip the
// container. When off: indexing is a no-op and catalog search falls back to a
// DynamoDB scan (below). Read as a function, not a const, so tests can toggle it.
export const searchEnabled = (): boolean => process.env.SEARCH_ENABLED !== 'false'

// Built lazily and only when search is enabled — a disabled deploy has no endpoint
// and shouldn't resolve AWS credentials for a SigV4 client it will never use.
let _client: Client | null = null
function os(): Client {
  if (_client) return _client
  if (process.env.LOCAL || !process.env.OPENSEARCH_ENDPOINT) {
    _client = new Client({ node: ENDPOINT })
  } else {
    _client = new Client({
      node: ENDPOINT,
      ...AwsSigv4Signer({
        region: process.env.AWS_REGION ?? 'us-west-2',
        service: 'es', // managed OpenSearch Service domain
        getCredentials: () => defaultProvider()(),
      }),
    })
  }
  return _client
}

export interface ProductDoc {
  id: string
  tenantId: string
  style: string
  name: string
  colorway: string
  priceCents: number
  season: string
}

export interface CatalogQuery {
  q?: string
  season?: string
  colorway?: string
  minPrice?: number
  maxPrice?: number
  limit?: number
}

let ensured = false
async function ensureIndex(): Promise<void> {
  if (!searchEnabled() || ensured) return
  const exists = await os().indices.exists({ index: INDEX })
  if (!exists.body) {
    await os().indices.create({
      index: INDEX,
      body: {
        mappings: {
          properties: {
            tenantId: { type: 'keyword' },
            style: { type: 'text', fields: { keyword: { type: 'keyword' } } },
            name: { type: 'text' },
            colorway: { type: 'keyword' },
            priceCents: { type: 'integer' },
            season: { type: 'keyword' },
          },
        },
      },
    })
  }
  ensured = true
}

/** Explicit index/mapping creation (search:setup). Idempotent. No-op when disabled. */
export async function ensureProductIndex(): Promise<void> {
  if (!searchEnabled()) return
  ensured = false
  await ensureIndex()
}

export async function indexProduct(doc: ProductDoc): Promise<void> {
  if (!searchEnabled()) return // no read model to feed; catalog reads DynamoDB directly
  await ensureIndex()
  // refresh so it's immediately searchable (dev/test convenience; prod bulk-indexes
  // and lets the refresh interval apply — search is eventually consistent anyway).
  await os().index({ index: INDEX, id: doc.id, body: doc, refresh: true })
}

export async function deleteProduct(id: string): Promise<void> {
  if (!searchEnabled()) return
  try {
    await os().delete({ index: INDEX, id, refresh: true })
  } catch (e: any) {
    if (e?.meta?.statusCode !== 404) throw e
  }
}

/**
 * Tenant-scoped catalog search: arbitrary filter combinations over product attrs.
 * With search disabled, falls back to a DynamoDB scan + in-memory filter — correct
 * and tenant-isolated, just without relevance ranking and O(products) per query, so
 * it suits small/free-tier deploys, not scale (that's exactly what OpenSearch is for).
 */
export async function searchProducts(tenantId: string, query: CatalogQuery): Promise<ProductDoc[]> {
  if (!searchEnabled()) return fallbackSearch(tenantId, query)
  await ensureIndex()

  const filter: any[] = [{ term: { tenantId } }] // isolation: only this tenant's products
  if (query.season) filter.push({ term: { season: query.season } })
  if (query.colorway) filter.push({ term: { colorway: query.colorway } })
  if (query.minPrice != null || query.maxPrice != null) {
    filter.push({ range: { priceCents: { gte: query.minPrice, lte: query.maxPrice } } })
  }

  const must: any[] = query.q
    ? [{ multi_match: { query: query.q, fields: ['name^2', 'style', 'colorway'] } }]
    : [{ match_all: {} }]

  const res = await os().search({
    index: INDEX,
    body: { size: query.limit ?? 50, query: { bool: { filter, must } } },
  })
  return (res.body.hits.hits as any[]).map(h => h._source as ProductDoc)
}

/** DynamoDB-backed catalog for a search-disabled deploy — same filters, no ranking. */
async function fallbackSearch(tenantId: string, query: CatalogQuery): Promise<ProductDoc[]> {
  const products = (await listProductsByTenant(tenantId)).map(p => ({
    id: String(p.PK).replace('PROD#', ''),
    tenantId: String(p.tenantId ?? ''),
    style: String(p.style ?? ''),
    name: String(p.name ?? ''),
    colorway: String(p.colorway ?? ''),
    priceCents: Number(p.priceCents ?? 0),
    season: String(p.season ?? ''),
  }))
  const q = query.q?.toLowerCase()
  return products
    .filter((p) => {
      if (query.season && p.season !== query.season) return false
      if (query.colorway && p.colorway !== query.colorway) return false
      if (query.minPrice != null && p.priceCents < query.minPrice) return false
      if (query.maxPrice != null && p.priceCents > query.maxPrice) return false
      if (q && !`${p.name} ${p.style} ${p.colorway}`.toLowerCase().includes(q)) return false
      return true
    })
    .slice(0, query.limit ?? 50)
}
