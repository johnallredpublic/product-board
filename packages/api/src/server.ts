import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BoardView, Product, MovePlacements, AddPlacement, UpdateProduct, UploadRequest, CreateBoardRequest, BoardEvents, CatalogResults } from '@assortment/shared'
import { getBoardView, placementSkMap, createBoard, listBoards, getBoardEvents, getBoardMeta, addPlacement, removePlacement } from './db/boards.js'
import { getProductMeta, updateProduct, toProductContract } from './db/products.js'
import { recordBoardMember } from './db/members.js'
import { shardCountOf } from './db/sharding.js'
import { movePlacements, type Move } from './routes/placements.js'
import { createAssetUpload } from './routes/assets.js'
import { searchProducts } from './search/client.js'
import { ConflictError, UnauthorizedError } from './errors.js'
import { enterCorrelation } from './obs/correlation.js'
import { registerAuth, resolveAuth } from './auth.js'
import { subscribe, unsubscribeAll, broadcastMoved, broadcastAdded, broadcastRemoved } from './realtime.js'

/** Flatten a ZodError into a single human-readable line for the error body. */
const zodMessage = (e: ZodError) =>
  e.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')

export function buildServer() {
  const app = Fastify({ logger: true, genReqId: () => randomUUID() })

  // Dev convenience: the Angular dev server (:4200) is a different origin from the
  // API (:3000). In production the app is served same-origin via CloudFront (ADR
  // 015 territory), so this reflect-origin policy is a local-only affordance.
  app.register(cors, { origin: true })

  // Resolve the caller's tenant/user on every request (req.auth). Tenant comes
  // from the token, never a request parameter — see auth.ts / ADR 0015.
  registerAuth(app)

  // Bind a correlation id per request (Fastify's genReqId is a UUID). Any domain
  // events published while handling the request carry it downstream.
  app.addHook('onRequest', async (req) => {
    enterCorrelation(String(req.id))
  })

  // Central error mapping. Input validation (MovePlacements.parse on the body) throws
  // a ZodError -> 400 validation_failed. ConflictError from the optimistic lock -> 409.
  // Everything else is an unexpected server fault -> 500. Note: OUTPUT validation
  // failures are NOT routed here as 400s (see the GET handler) — those are our bug.
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_failed', message: zodMessage(error) },
      })
    }
    if (error instanceof ConflictError) {
      return reply.code(409).send({
        error: { code: 'conflict', message: error.message },
      })
    }
    if (error instanceof UnauthorizedError) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: error.message },
      })
    }
    req.log.error(error)
    return reply.code(500).send({
      error: { message: 'Internal Server Error' },
    })
  })

  app.get('/api/boards', async (req) => {
    return { boards: await listBoards(req.auth.tenantId) }
  })

  // Catalog search — OpenSearch read model, scoped to the caller's tenant.
  // Eventually consistent with the authoritative product records (DESIGN.md §6.4).
  app.get('/api/catalog', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const docs = await searchProducts(req.auth.tenantId, {
      q: q.q,
      season: q.season,
      colorway: q.colorway,
      minPrice: q.minPrice != null ? Number(q.minPrice) : undefined,
      maxPrice: q.maxPrice != null ? Number(q.maxPrice) : undefined,
    })
    const items = docs.map(d => ({
      id: d.id, style: d.style, name: d.name,
      colorway: d.colorway, priceCents: d.priceCents, season: d.season,
    }))
    return CatalogResults.parse({ items, total: items.length })
  })

  app.post('/api/boards', async (req, reply) => {
    const input = CreateBoardRequest.parse(req.body)
    const board = await createBoard(req.auth.tenantId, input)
    return reply.code(201).send(board)
  })

  app.get<{ Params: { id: string } }>('/api/boards/:id', async (req, reply) => {
    const view = await getBoardView(req.params.id, req.auth.tenantId)
    if (!view) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'Board not found' },
      })
    }
    // Validate our OWN output. TypeScript types are erased at runtime; this catches
    // contract drift before it reaches the client. A failure here is a SERVER bug,
    // so it maps to 500 (not the 400 the central handler gives input ZodErrors).
    // Consider making this dev-only for latency in production.
    const out = BoardView.safeParse(view)
    if (!out.success) {
      req.log.error({ issues: out.error.issues }, 'response failed BoardView validation')
      return reply.code(500).send({ error: { message: 'Response contract drift' } })
    }
    // Loading a board makes you a member (a notification subscriber).
    await recordBoardMember(req.auth.tenantId, req.params.id, req.auth.userId)
    return out.data
  })

  app.get<{ Params: { id: string } }>('/api/boards/:id/events', async (req, reply) => {
    const board = await getBoardMeta(req.auth.tenantId, req.params.id)
    if (!board) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Board not found' } })
    }
    return BoardEvents.parse({ items: await getBoardEvents(req.auth.tenantId, req.params.id) })
  })

  app.patch<{ Params: { id: string } }>('/api/boards/:id/placements', async (req, reply) => {
    const boardId = req.params.id

    // Ownership first: another tenant's board reads as "not found". With the tenant in
    // the partition key, getBoardMeta can only find THIS tenant's board.
    const board = await getBoardMeta(req.auth.tenantId, boardId)
    if (!board) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Board not found' } })
    }
    const shardCount = shardCountOf(board)

    const body = MovePlacements.parse(req.body) // validate at the boundary

    // Translate contract ids -> DynamoDB sort keys. See placementSkMap / ADR 0004:
    // the SK embeds z-order, so a board query resolves the mapping (scatter-gather
    // across shards for a hot board). Acceptable because the client debounces (~400ms).
    const skMap = await placementSkMap(req.auth.tenantId, boardId, shardCount)
    const unknown = body.moves.filter(m => !skMap.has(m.id)).map(m => m.id)
    if (unknown.length) {
      return reply.code(404).send({
        error: { code: 'not_found', message: `Unknown placement(s): ${unknown.join(', ')}` },
      })
    }
    const moves: Move[] = body.moves.map(m => ({
      sk: skMap.get(m.id)!, x: m.x, y: m.y, version: m.version,
    }))

    // A ConflictError here bubbles to the central error handler -> 409.
    await movePlacements(req.auth.tenantId, boardId, moves, req.auth.userId, shardCount)
    await recordBoardMember(req.auth.tenantId, boardId, req.auth.userId)

    // Fan out the move to everyone watching this board in real time. Locally this
    // is an in-process broadcast; in AWS a fan-out Lambda on PlacementMoved does it.
    broadcastMoved({
      boardId,
      actorUserId: req.auth.userId,
      moves: body.moves.map(m => ({ id: m.id, x: m.x, y: m.y, version: m.version + 1 })),
    })
    return { ok: true }
  })

  // Add a product to a board. Ownership is checked on BOTH the board and the product
  // (a caller can't place another tenant's product), each failing as 404.
  app.post<{ Params: { id: string } }>('/api/boards/:id/placements', async (req, reply) => {
    const boardId = req.params.id
    const board = await getBoardMeta(req.auth.tenantId, boardId)
    if (!board) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Board not found' } })
    }
    const input = AddPlacement.parse(req.body)
    const product = await getProductMeta(input.productId)
    if (!product || product.tenantId !== req.auth.tenantId) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Product not found' } })
    }

    const placement = await addPlacement(req.auth.tenantId, boardId, input, shardCountOf(board))
    await recordBoardMember(req.auth.tenantId, boardId, req.auth.userId)
    // Ship the product alongside so peers who don't have it loaded can render at once.
    broadcastAdded({ boardId, actorUserId: req.auth.userId, placement, product: toProductContract(product) })
    return reply.code(201).send(placement)
  })

  // Remove a placement from a board.
  app.delete<{ Params: { id: string; pid: string } }>('/api/boards/:id/placements/:pid', async (req, reply) => {
    const boardId = req.params.id
    const board = await getBoardMeta(req.auth.tenantId, boardId)
    if (!board) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Board not found' } })
    }
    const removed = await removePlacement(req.auth.tenantId, boardId, req.params.pid, shardCountOf(board))
    if (!removed) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Placement not found' } })
    }
    await recordBoardMember(req.auth.tenantId, boardId, req.auth.userId)
    broadcastRemoved({ boardId, actorUserId: req.auth.userId, placementId: req.params.pid })
    return { ok: true }
  })

  // Edit a product (field-level merge). A price change flows through the stream as a
  // ProductPriceChanged domain event (stream-consumer.ts) to the notify pipeline.
  app.patch<{ Params: { id: string } }>('/api/products/:id', async (req, reply) => {
    const product = await getProductMeta(req.params.id)
    if (!product || product.tenantId !== req.auth.tenantId) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Product not found' } })
    }
    const patch = UpdateProduct.parse(req.body)
    const updated = await updateProduct(req.params.id, patch, req.auth.userId)
    return Product.parse(toProductContract(updated))
  })

  app.post<{ Params: { id: string } }>('/api/products/:id/assets', async (req, reply) => {
    // UploadRequest's content-type enum is the allow-list; a bad type -> 400.
    const { contentType } = UploadRequest.parse(req.body)
    const product = await getProductMeta(req.params.id)
    if (!product || product.tenantId !== req.auth.tenantId) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Product not found' } })
    }
    return createAssetUpload(req.params.id, contentType)
  })

  // Real-time subscription. Register the websocket plugin and the route together in
  // a nested scope so the route is transformed into a WS route (ordering matters).
  // Browsers can't set headers on a WebSocket, so the tenant resolves from the dev
  // fallback locally and from a query-param token in prod (ADR 0016). A client sends
  // {type:'subscribe', boardId}; we verify board ownership before registering it.
  app.register(async (instance) => {
    await instance.register(websocket)
    instance.get('/realtime', { websocket: true }, async (socket, req) => {
      let ctx
      try {
        ctx = await resolveAuth(req)
      } catch {
        socket.close()
        return
      }
      socket.on('message', async (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg?.type === 'subscribe' && typeof msg.boardId === 'string') {
            const board = await getBoardMeta(ctx.tenantId, msg.boardId)
            if (board) subscribe(socket, msg.boardId)
          }
        } catch {
          /* ignore malformed frames */
        }
      })
      socket.on('close', () => unsubscribeAll(socket))
    })
  })

  return app
}

// Listen only when run directly (`pnpm dev`), not when imported by tests, which
// drive the app in-process via app.inject().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer()
  const port = Number(process.env.PORT ?? 3000)
  app.listen({ port, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
}
