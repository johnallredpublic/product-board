// Create the OpenSearch product index + mapping (idempotent).
//
//   LOCAL=1 pnpm search:setup

import { ensureProductIndex } from '../src/search/client.js'

await ensureProductIndex()
console.log('search index "products" ready')
