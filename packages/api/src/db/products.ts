import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { Product, UpdateProduct } from '@assortment/shared'
import { ddb, TABLE } from './table.js'

type Item = Record<string, any>

/** Load a product's #META (for tenant ownership checks). Null if it doesn't exist. */
export async function getProductMeta(productId: string): Promise<Item | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `PROD#${productId}`, SK: '#META' },
  }))
  return Item ?? null
}

/**
 * Field-level merge of a product (DESIGN.md §6.2): SET only the attributes present in
 * the patch, leaving the rest untouched — so two editors changing *different* fields
 * don't clobber each other (unlike positions, which are last-write-wins). `updatedBy`
 * rides into the stream's NewImage so a resulting ProductPriceChanged names the editor.
 * `name` is a DynamoDB reserved word, so every field goes through ExpressionAttributeNames.
 */
export async function updateProduct(
  productId: string,
  patch: UpdateProduct,
  userId: string,
): Promise<Item> {
  const names: Record<string, string> = {}
  const values: Record<string, any> = { ':u': userId }
  const sets: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    names[`#${k}`] = k
    values[`:${k}`] = v
    sets.push(`#${k} = :${k}`)
  }
  sets.push('updatedBy = :u')

  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `PROD#${productId}`, SK: '#META' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(PK)', // the product must still exist
    ReturnValues: 'ALL_NEW',
  }))
  return Attributes!
}

/** Raw product #META item → the Product contract shape. */
export function toProductContract(i: Item): Product {
  return {
    id: String(i.PK).replace('PROD#', ''),
    style: i.style,
    name: i.name,
    colorway: i.colorway,
    priceCents: i.priceCents,
    season: i.season,
    asset: i.asset ?? null,
  }
}

/**
 * All of a tenant's product #META items, via a paginated Scan. A Scan is the access
 * pattern the single-table design deliberately avoids (ADR 0004) — it exists only to
 * back the catalog when OpenSearch is switched off (search/client.ts fallback), where
 * the tradeoff is acceptable because that mode targets small/free-tier deploys.
 */
export async function listProductsByTenant(tenantId: string): Promise<Item[]> {
  const items: Item[] = []
  let ExclusiveStartKey: Record<string, any> | undefined
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :meta AND begins_with(PK, :prod) AND tenantId = :t',
      ExpressionAttributeValues: { ':meta': '#META', ':prod': 'PROD#', ':t': tenantId },
      ExclusiveStartKey,
    }))
    items.push(...(res.Items ?? []))
    ExclusiveStartKey = res.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}
