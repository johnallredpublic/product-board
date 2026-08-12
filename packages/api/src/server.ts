import Fastify from 'fastify'
import cors from '@fastify/cors'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BoardView, MovePlacements, UploadRequest, CreateBoardRequest, BoardEvents } from '@assortment/shared'
import { getBoardView, placementSkMap, createBoard, listBoards, getBoardEvents } from './db/boards.js'
import { movePlacements, type Move } from './routes/placements.js'
import { createAssetUpload } from './routes/assets.js'
import { ConflictError } from './errors.js'
import { enterCorrelation } from './obs/correlation.js'

/** Flatten a ZodError into a single human-readable line for the error body. */
const zodMessage = (e: ZodError) =>
  e.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')

export function buildServer() {
  const app = Fastify({ logger: true, genReqId: () => randomUUID() })

  // Dev convenience: the Angular dev server (:4200) is a different origin from the
  // API (:3000). In production the app is served same-origin via CloudFront (ADR
  // 015 territory), so this reflect-origin policy is a local-only affordance.
  app.register(cors, { origin: true })

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
    req.log.error(error)
    return reply.code(500).send({
      error: { message: 'Internal Server Error' },
    })
  })

  app.get('/api/boards', async () => {
    return { boards: await listBoards() }
  })

  app.post('/api/boards', async (req, reply) => {
    const input = CreateBoardRequest.parse(req.body)
    const board = await createBoard(input)
    return reply.code(201).send(board)
  })

  app.get<{ Params: { id: string } }>('/api/boards/:id', async (req, reply) => {
    const view = await getBoardView(req.params.id)
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
    return out.data
  })

  app.get<{ Params: { id: string } }>('/api/boards/:id/events', async (req) => {
    return BoardEvents.parse({ items: await getBoardEvents(req.params.id) })
  })

  app.patch<{ Params: { id: string } }>('/api/boards/:id/placements', async (req, reply) => {
    const boardId = req.params.id
    const body = MovePlacements.parse(req.body) // validate at the boundary

    // Translate contract ids -> DynamoDB sort keys. See placementSkMap / ADR 0004:
    // the SK embeds z-order, so one board query resolves the mapping. This costs a
    // read per batch; acceptable because the client debounces saves (~400ms).
    const skMap = await placementSkMap(boardId)
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
    await movePlacements(boardId, moves)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/products/:id/assets', async (req) => {
    // UploadRequest's content-type enum is the allow-list; a bad type -> 400.
    const { contentType } = UploadRequest.parse(req.body)
    return createAssetUpload(req.params.id, contentType)
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
