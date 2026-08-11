# Assortment
## Building one application on the VibeIQ stack, from nothing

**What you're building:** a collaborative assortment board. Products live in a catalog with images. Users arrange them on an infinite canvas board, panning, zooming, selecting, and dragging tiles. Positions persist. It is a deliberately small version of what VibeIQ actually sells.

**The stack, because it's theirs:** Angular, HTML5 Canvas, TypeScript, Node.js, DynamoDB, S3, and the AWS services around them.

**What you'll have at the end:** one deployable system, one repository, with a typed contract shared between client and server, a canvas renderer that handles hundreds of tiles smoothly, presigned S3 uploads with derivative generation, single-table DynamoDB, an event-driven pipeline off DynamoDB Streams, a second deployable service with a real boundary between them, EventBridge notifications with a dead letter queue, a reconciliation job, and infrastructure as code.

**Time:** roughly 60 to 85 hours done carefully.

---

## What this covers, and why

Two lists shaped this guide. Your engineering manager named the **stack**: Canvas, Angular, Node, DynamoDB, S3, other AWS services. Your friend inside the company named the **topics**: DynamoDB, AWS in general, event-driven systems, microservice architecture, distributed systems, system design.

An earlier version of this guide covered the stack and largely missed the topics, because a single CRUD service with a rich frontend has no events, no service boundaries, and no distributed coordination. The phases below fix that. Where each topic lives:

| Topic | Phases |
|---|---|
| DynamoDB | 3 (single-table, seven access patterns), 7 (optimistic locking) |
| AWS in general | 4 (S3), 8 (Streams), 9 (EventBridge, SQS, DLQ), 11 (Lambda, CloudFront, CDK) |
| **Event-driven systems** | **8 (Streams as an outbox), 9 (EventBridge, notifications, DLQ)** |
| **Microservice architecture** | **10 (splitting the media service, contracts between services)** |
| **Distributed systems** | **8 (idempotency, at-least-once), 9 (retries, backpressure), 12 (reconciliation)** |
| **System design** | **13 (a written design doc, no code)** |
| Angular + Canvas | 5, 6 |

**Read this before you start**

**Phase 6 is the canvas board and it's the one that matters most.** It's their actual product surface and it's the technology you're least likely to have used. Everything before it exists to give the board real data to render.

**Phases 8 through 13 are what convert this from a CRUD app into something that exercises the topics your friend listed.** If you're rationing effort, Phase 8 is the highest-value single addition, because DynamoDB Streams gives you event-driven architecture, idempotency, at-least-once delivery, and the transactional outbox pattern in one afternoon.

**If you have less than a week, do this instead:** skip to Appendix A, build the canvas board standalone against hardcoded data, and get the mechanics into your hands. Then add Phase 8. Those two give you the most interview value per hour.

**A version note.** Angular moves fast. This assumes Angular 19 or 20, where standalone components, signals, and `@if` / `@for` control flow are the defaults. Run `ng version` and skim the release notes for anything I've gotten stale on.

---

## Phase 0: Decisions before code (1 hour)

Same practice as before. `docs/adr/`, one file per decision, five sections: Status, Context, Decision, Consequences. Copy the ADR README from the Coursebook guide.

Write these before you start:

| # | Decision | Choice here | The tradeoff to name |
|---|---|---|---|
| 001 | Repo structure | pnpm monorepo, three packages | CI runs everything until we filter |
| 002 | Frontend framework | Angular 20, standalone + signals | Team must know signals; smaller hiring pool than React |
| 003 | Board rendering | Canvas 2D, not DOM or SVG or WebGL | Loses free accessibility and text selection; requires a parallel a11y layer |
| 004 | Data store | DynamoDB single-table | Rigid; new access patterns may need migration |
| 005 | Asset storage | S3 with presigned uploads | Two systems that can disagree; needs reconciliation |
| 006 | API framework | Fastify on Lambda | Cold starts; acceptable at this scale |
| 007 | Contract | Zod in a shared package, OpenAPI generated | Not true spec-first; the API defines rather than negotiates |
| 008 | Persistence on drag | Debounced, on pointer-up | Loses in-flight changes on a crash mid-drag |
| 009 | Concurrency | Optimistic locking, last-write-wins for positions | Two users dragging the same tile: one loses |
| 010 | IaC | AWS CDK in TypeScript | Same language as the app; less portable than Terraform |
| 011 | Change propagation | DynamoDB Streams, not application-level publish | Couples us to DynamoDB; no control over event shape |
| 012 | Service boundary | Media processing split out; everything else stays together | Two deploys, a contract to maintain, distributed debugging |
| 013 | Inter-service comms | EventBridge, async only, no synchronous calls between services | Eventual consistency; the flow lives in no single place |
| 014 | Consumer idempotency | Deterministic IDs plus conditional writes | Every consumer must be written this way; not enforceable by tooling |

**ADR 003 is the interesting one for the frontend.** Write it properly. "Why canvas rather than DOM elements" is a genuine architecture question with a real answer (thousands of nodes with transforms destroys layout performance; canvas gives you one element and a draw loop) and a real cost (you lose accessibility, text selection, and browser-native hit testing, and must rebuild each).

**ADR 012 is the interesting one for the backend**, and it is the one most likely to surface in a scenario exercise. The honest content: at this size, splitting services is usually the wrong call, and the specific reason to split media processing is that it has a different scaling profile (bursty, CPU-heavy, latency-tolerant) and a different failure tolerance (an image failing to resize should not affect the board). Write the version that argues *against* splitting everything else, because that restraint is the senior signal.

**Together those two are better interview artifacts than any code in this project.**

---

## Phase 1: The skeleton (1–2 hours)

```bash
mkdir assortment && cd assortment
git init && pnpm init
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'infra'
```

`package.json`:

```json
{
  "name": "assortment",
  "private": true,
  "scripts": {
    "dev": "pnpm --parallel --filter './packages/*' dev",
    "typecheck": "pnpm --filter './packages/*' typecheck",
    "test": "pnpm --filter './packages/*' test"
  },
  "devDependencies": { "typescript": "^5.7.0", "@types/node": "^22.10.0" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

Three packages:

```
packages/
  shared/   ← Zod schemas and types. Depends on nothing.
  api/      ← Fastify + DynamoDB + S3. Depends on shared.
  web/      ← Angular. Depends on shared.
infra/      ← CDK
```

**Local AWS.** `docker-compose.yml`:

```yaml
services:
  dynamodb:
    image: amazon/dynamodb-local
    ports: ['8000:8000']
    command: -jar DynamoDBLocal.jar -sharedDb -inMemory
  minio:
    image: minio/minio
    ports: ['9000:9000', '9001:9001']
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
```

MinIO is S3-compatible, so the same SDK code works locally and in AWS. That matters more than it sounds: you can develop the entire upload flow offline.

**Checkpoint:** both containers up, `pnpm install` clean.

---

## Phase 2: The shared contract (2–3 hours)

Everything downstream depends on this, which is why it's first.

`packages/shared/src/types.ts`:

```ts
import { z } from 'zod'

export const AssetRef = z.object({
  assetId: z.string().uuid(),
  thumb128: z.string().url(),
  thumb512: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type AssetRef = z.infer<typeof AssetRef>

export const Product = z.object({
  id:         z.string().uuid(),
  style:      z.string().min(1).max(64),
  name:       z.string().min(1).max(200),
  colorway:   z.string().max(64),
  priceCents: z.number().int().nonnegative(),
  season:     z.enum(['SP26', 'FA26', 'SP27']),
  asset:      AssetRef.nullable(),
})
export type Product = z.infer<typeof Product>

/** A product placed on a board. Coordinates are WORLD units. */
export const Placement = z.object({
  id:        z.string().uuid(),
  productId: z.string().uuid(),
  x:         z.number(),
  y:         z.number(),
  w:         z.number().positive(),
  h:         z.number().positive(),
  z:         z.number().int().nonnegative(),
  version:   z.number().int().nonnegative(),
})
export type Placement = z.infer<typeof Placement>

export const Board = z.object({
  id:        z.string().uuid(),
  name:      z.string().min(1).max(200),
  season:    Product.shape.season,
  createdAt: z.string().datetime(),
})
export type Board = z.infer<typeof Board>

/** What the board route loads in one request. */
export const BoardView = z.object({
  board:      Board,
  placements: z.array(Placement),
  products:   z.array(Product),
})
export type BoardView = z.infer<typeof BoardView>

export const MovePlacements = z.object({
  moves: z.array(z.object({
    id: z.string().uuid(),
    x: z.number(),
    y: z.number(),
    version: z.number().int().nonnegative(),
  })).min(1).max(200),
})

export const ApiError = z.object({
  error: z.object({
    code: z.enum(['not_found', 'conflict', 'validation_failed', 'unauthorized']),
    message: z.string(),
  }),
})
```

**Three design points worth an ADR note:**

**`BoardView` returns placements and products together.** The board needs both, and two round trips on load is a worse experience than one slightly larger response. This is a deliberate denormalization at the API layer.

**`version` on `Placement`** is your optimistic locking token. It's in the contract because the client has to send it back.

**Coordinates are world units and the type says so in a comment.** In a canvas app, the single most common bug is mixing world and screen coordinates. Naming the space in the type is cheap insurance.

---

## Phase 3: The API and DynamoDB (8–10 hours)

```bash
cd packages/api
pnpm add fastify @fastify/cors @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb \
  @aws-sdk/client-s3 @aws-sdk/s3-request-presigner zod
pnpm add -D tsx typescript vitest @testcontainers/localstack
```

### Step 1: Access patterns, written down first

1. Get a board's metadata
2. List boards in a workspace
3. Get all placements on a board, in z-order
4. Get products by a set of IDs (to hydrate the board)
5. Find every board containing a given product (reverse)
6. Get a product with its colorways and assets in one call
7. Recent activity on a board, newest first

**Do not skip writing these down.** The whole discipline is that keys follow from patterns.

### Step 2: The table

```ts
// src/db/table.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

const client = new DynamoDBClient(
  process.env.LOCAL
    ? { endpoint: 'http://localhost:8000', region: 'local',
        credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }
    : {}
)

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
})

export const TABLE = process.env.TABLE_NAME ?? 'assortment'
```

Item shapes:

| Entity | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Workspace | `WS#<id>` | `#META` | | |
| Board pointer | `WS#<id>` | `BOARD#<id>` | | |
| Board | `BOARD#<id>` | `#META` | | |
| Placement | `BOARD#<id>` | `ITEM#<zzzz>#<id>` | `PROD#<pid>` | `BOARD#<id>` |
| Event | `BOARD#<id>` | `EVT#<iso>#<id>` | | |
| Product | `PROD#<id>` | `#META` | `SEASON#<s>` | `STYLE#<style>` |
| Asset | `PROD#<id>` | `ASSET#<id>` | | |

**The z-order encoding:** `ITEM#0042#<uuid>`, zero-padded to four digits. Sort keys compare as strings, so `0042` sorts before `0100`, while unpadded `42` would sort *after* `100`. Query the partition and items come back in z-order for free, which is exactly the order the canvas needs to draw them.

**GSI1 is overloaded**, serving two unrelated patterns: placements keyed by product (pattern 5) and products keyed by season (browse). Different key prefixes so they never collide.

### Step 3: The queries

```ts
// src/db/boards.ts
import { QueryCommand, BatchGetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLE } from './table.js'

const Z = (z: number) => String(z).padStart(4, '0')

export async function getBoardView(boardId: string) {
  // One query gets metadata AND placements: #META sorts before ITEM#
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `BOARD#${boardId}` },
  }))

  const board = Items.find(i => i.SK === '#META')
  if (!board) return null

  const placements = Items.filter(i => i.SK.startsWith('ITEM#'))

  // Hydrate products. BatchGet caps at 100 keys per request.
  const ids = [...new Set(placements.map(p => p.productId))]
  const products = await batchGetProducts(ids)

  return { board: toBoard(board), placements: placements.map(toPlacement), products }
}

async function batchGetProducts(ids: string[]) {
  const out = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TABLE]: { Keys: chunk.map(id => ({ PK: `PROD#${id}`, SK: '#META' })) },
      },
    }))
    out.push(...(res.Responses?.[TABLE] ?? []))
    // NOTE: production code must retry res.UnprocessedKeys
  }
  return out.map(toProduct)
}
```

**Notice the single query returning board metadata and placements together.** `#` is 0x23 in ASCII, lower than any letter, so `#META` sorts before `ITEM#`. That's the item-collection-as-precomputed-join idea in concrete form, and it's worth being able to point at.

**`UnprocessedKeys` is real.** BatchGet can partially fail under throttling and returns what it couldn't get. Leaving the TODO comment in is honest; handling it is better.

### Step 4: The move endpoint, with optimistic locking

This is the one the canvas hits constantly.

```ts
// src/routes/placements.ts
export async function movePlacements(boardId: string, moves: Move[]) {
  // TransactWrite caps at 100 items
  for (let i = 0; i < moves.length; i += 100) {
    const chunk = moves.slice(i, i + 100)
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: chunk.map(m => ({
          Update: {
            TableName: TABLE,
            Key: { PK: `BOARD#${boardId}`, SK: m.sk },
            UpdateExpression: 'SET x = :x, y = :y, version = version + :one',
            ConditionExpression: 'version = :expected',
            ExpressionAttributeValues: {
              ':x': m.x, ':y': m.y, ':one': 1, ':expected': m.version,
            },
          },
        })),
      }))
    } catch (e: any) {
      if (e.name === 'TransactionCanceledException') {
        throw new ConflictError('A placement was modified by someone else')
      }
      throw e
    }
  }
}
```

**Be ready to defend the design choice here.** A transaction means all moves succeed or none do, which is right when dragging a multi-selection (you don't want half the group to move). The cost is double the write units and an all-or-nothing failure. For positions specifically, you could argue individual conditional updates with per-item conflict reporting is better. **Say the tradeoff out loud in the interview; that's the answer they're listening for.**

### Step 5: Fastify wiring

```ts
// src/server.ts
import Fastify from 'fastify'
import { BoardView, MovePlacements } from '@assortment/shared'

export function buildServer() {
  const app = Fastify({ logger: true, genReqId: () => crypto.randomUUID() })

  app.get('/api/boards/:id', async (req, reply) => {
    const view = await getBoardView((req.params as any).id)
    if (!view) return reply.code(404).send({
      error: { code: 'not_found', message: 'Board not found' },
    })
    return BoardView.parse(view)          // validate our own output
  })

  app.patch('/api/boards/:id/placements', async (req, reply) => {
    const body = MovePlacements.parse(req.body)   // validate at the boundary
    try {
      await movePlacements((req.params as any).id, body.moves)
      return { ok: true }
    } catch (e) {
      if (e instanceof ConflictError) return reply.code(409).send({
        error: { code: 'conflict', message: e.message },
      })
      throw e
    }
  })

  return app
}
```

**Parsing your own response** catches contract drift in development. Consider making it dev-only for latency in production.

**Checkpoint for Phase 3:** all seven access patterns are single Gets or Queries. Seed a board with 200 placements and time `GET /api/boards/:id`. It should be well under 200ms locally.

---

## Phase 4: S3 and image derivatives (4–6 hours)

The canvas depends on this, which is why it comes before the canvas.

### Step 1: Presigned upload

```ts
// src/routes/assets.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const s3 = new S3Client(
  process.env.LOCAL
    ? { endpoint: 'http://localhost:9000', region: 'us-east-1', forcePathStyle: true,
        credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } }
    : {}
)

app.post('/api/products/:id/assets', async (req) => {
  const { contentType } = UploadRequest.parse(req.body)
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new BadRequest('unsupported content type')
  }

  const productId = (req.params as any).id
  const assetId = crypto.randomUUID()
  const key = `products/${productId}/${assetId}/original`

  // Record intent BEFORE the upload
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `PROD#${productId}`, SK: `ASSET#${assetId}`,
      status: 'pending', key, contentType,
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }))

  const uploadUrl = await getSignedUrl(s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 300 })

  return { assetId, uploadUrl }
})
```

**Why presigned:** bytes go browser-to-S3 directly. Your compute is never in the data path, so a 40MB image doesn't consume Lambda duration or hit the 6MB payload limit. This is *the* AWS upload pattern and a very likely interview question.

### Step 2: Derivatives, triggered by S3

```ts
// src/handlers/on-upload.ts
import sharp from 'sharp'

export async function handler(event: S3Event) {
  for (const rec of event.Records) {
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '))
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const buf = Buffer.from(await Body!.transformToByteArray())
    const meta = await sharp(buf).metadata()

    for (const size of [128, 512]) {
      const out = await sharp(buf)
        .resize(size, size, { fit: 'cover' })
        .webp({ quality: 82 })
        .toBuffer()
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key.replace('/original', `/thumb-${size}.webp`),
        Body: out,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }))
    }

    await markReady(key, { width: meta.width!, height: meta.height! })
  }
}
```

**The two sizes exist for the canvas.** At low zoom you render 128px tiles; zoomed in you swap to 512px. **This is the cross-layer decision worth naming in the interview:** a storage-layer choice made to serve a rendering-layer constraint.

`immutable` caching works because the key contains a UUID, so the content at that key never changes.

### Step 3: The consistency problem

You now have two systems that can disagree. Name the failure modes and handle them:

- **Record with no object:** client got a URL and never uploaded. Sweep job deletes `pending` records older than 24h.
- **Object with no record:** shouldn't occur given the write ordering, but an S3 lifecycle rule aborts incomplete multipart uploads.
- **Derivative generation failed:** record stuck at `pending` with an object present. DLQ on the Lambda, alarm on depth.

**Say "two systems, no shared transaction, so you reconcile" out loud.** It's the sentence that signals you've shipped this.

**Checkpoint for Phase 4:** upload an image through a presigned URL to MinIO, see the two derivatives appear, see the DynamoDB record flip to `ready`.

---

## Phase 5: The Angular shell (6–8 hours)

```bash
cd packages && ng new web --style=css --ssr=false --routing
```

### Step 1: The mental model, if you're coming from React

| React | Angular 19+ |
|---|---|
| `useState` | `signal()` |
| `useMemo` | `computed()` |
| `useEffect` | `effect()` |
| props | `input()` |
| callback props | `output()` |
| Context | `inject()` + `providedIn: 'root'` |
| re-render component | fine-grained signal updates |

Signals are closer to Solid or MobX than to React's re-render model: a signal knows who reads it, so a change updates only the specific DOM that depends on it.

### Step 2: A typed API client

```ts
// src/app/core/api.service.ts
import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { BoardView, type Placement } from '@assortment/shared'

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient)

  async getBoard(id: string): Promise<BoardView> {
    const raw = await firstValueFrom(this.http.get(`/api/boards/${id}`))
    return BoardView.parse(raw)      // runtime validation at the boundary
  }

  async movePlacements(boardId: string, moves: MoveInput[]) {
    return firstValueFrom(
      this.http.patch(`/api/boards/${boardId}/placements`, { moves })
    )
  }
}
```

**`BoardView.parse` on the response is the point.** TypeScript types are erased at runtime; the Zod schema is what actually catches a contract violation, and it catches it at the boundary rather than three frames deeper.

### Step 3: The board state service

This is the seam between Angular and the canvas, and getting it right is what makes the canvas simple.

```ts
// src/app/board/board-store.ts
import { Injectable, inject, signal, computed } from '@angular/core'

@Injectable()   // provided per-route, not root: one store per board
export class BoardStore {
  private api = inject(ApiService)

  private _placements = signal<Placement[]>([])
  private _products = signal<Map<string, Product>>(new Map())
  private _selection = signal<ReadonlySet<string>>(new Set())
  private _loading = signal(false)

  readonly placements = this._placements.asReadonly()
  readonly selection = this._selection.asReadonly()
  readonly loading = this._loading.asReadonly()

  readonly selectedCount = computed(() => this._selection().size)

  /** Placements joined with product data — what the canvas actually draws. */
  readonly renderables = computed(() => {
    const products = this._products()
    return this._placements().map(p => ({
      ...p,
      product: products.get(p.productId),
    }))
  })

  async load(boardId: string) {
    this._loading.set(true)
    try {
      const view = await this.api.getBoard(boardId)
      this._placements.set(view.placements)
      this._products.set(new Map(view.products.map(p => [p.id, p])))
    } finally {
      this._loading.set(false)
    }
  }

  /** Optimistic local move. Persistence is separate and debounced. */
  moveBy(ids: ReadonlySet<string>, dx: number, dy: number) {
    this._placements.update(ps => ps.map(p =>
      ids.has(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p
    ))
  }

  select(ids: ReadonlySet<string>) { this._selection.set(ids) }
}
```

**The private-signal-plus-readonly-view pattern** keeps mutation in one place. **`renderables` as a computed** means the canvas never joins data itself; it just draws what it's given.

### Step 4: Routing

```ts
export const routes: Routes = [
  { path: '', redirectTo: 'boards', pathMatch: 'full' },
  {
    path: 'boards',
    loadComponent: () => import('./boards/board-list.component')
      .then(m => m.BoardListComponent),
  },
  {
    path: 'boards/:boardId',
    providers: [BoardStore],           // scoped to this route
    loadComponent: () => import('./board/board-page.component')
      .then(m => m.BoardPageComponent),
  },
]
```

With `withComponentInputBinding()` in your router config, route params bind directly to signal inputs:

```ts
export class BoardPageComponent {
  boardId = input.required<string>()
}
```

**Checkpoint for Phase 5:** the board list loads from the real API, clicking through to a board fetches its data, and the store's `renderables` computed produces joined objects.

---

## Phase 6: The canvas board (12–16 hours)

**The centerpiece.** Take your time here.

### Step 1: Setup done correctly

```ts
// src/app/board/board-canvas.component.ts
import {
  Component, ElementRef, viewChild, inject, effect,
  AfterViewInit, OnDestroy, ChangeDetectionStrategy,
} from '@angular/core'

@Component({
  selector: 'app-board-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <canvas #canvas
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="onPointerUp($event)"
        (wheel)="onWheel($event)"></canvas>

      <!-- Parallel accessible layer. See step 8. -->
      <div class="sr-only" role="list" aria-label="Board items">
        @for (r of store.renderables(); track r.id) {
          <div role="listitem" tabindex="0"
               [attr.aria-selected]="store.selection().has(r.id)"
               (keydown)="onItemKey($event, r)">
            {{ r.product?.name }} at {{ r.x | number:'1.0-0' }},
                                    {{ r.y | number:'1.0-0' }}
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .wrap { position: relative; width: 100%; height: 100%; }
    canvas { display: block; width: 100%; height: 100%; touch-action: none; }
    .sr-only { position: absolute; width: 1px; height: 1px;
               overflow: hidden; clip: rect(0 0 0 0); }
  `],
})
export class BoardCanvasComponent implements AfterViewInit, OnDestroy {
  protected store = inject(BoardStore)
  private canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas')
  private ctx!: CanvasRenderingContext2D
  private ro?: ResizeObserver

  constructor() {
    // Re-render whenever the data or selection changes
    effect(() => {
      this.store.renderables()
      this.store.selection()
      this.requestRender()
    })
  }

  ngAfterViewInit() {
    const canvas = this.canvasRef().nativeElement
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
  }

  private resize() {
    const canvas = this.canvasRef().nativeElement
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width  = Math.round(rect.width  * dpr)
    canvas.height = Math.round(rect.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // draw in CSS pixels
    this.requestRender()
  }

  ngOnDestroy() { this.ro?.disconnect() }
}
```

**The devicePixelRatio handling is what everyone gets wrong first.** A canvas has a CSS size and a backing-store size. Without scaling by `devicePixelRatio`, everything is blurry on a retina display.

**`touch-action: none`** stops the browser hijacking touch gestures for scrolling.

**The `effect()` bridging signals to the render loop** is the Angular-specific piece: reading a signal inside an effect subscribes to it, so any data or selection change schedules a repaint automatically.

### Step 2: The viewport transform

Everything in a pan-and-zoom canvas reduces to this.

```ts
// src/app/board/viewport.ts
export interface Viewport { x: number; y: number; scale: number }

export function worldToScreen(wx: number, wy: number, vp: Viewport) {
  return { x: wx * vp.scale + vp.x, y: wy * vp.scale + vp.y }
}

export function screenToWorld(sx: number, sy: number, vp: Viewport) {
  return { x: (sx - vp.x) / vp.scale, y: (sy - vp.y) / vp.scale }
}
```

**Placements are stored in world coordinates and never change when you pan or zoom. Only the viewport changes.** Getting this separation right makes everything else easy. Getting it wrong produces the classic bug where dragging an item moves at the wrong speed when zoomed.

### Step 3: The render loop

```ts
private vp = signal<Viewport>({ x: 0, y: 0, scale: 1 })
private renderQueued = false

private requestRender() {
  if (this.renderQueued) return
  this.renderQueued = true
  requestAnimationFrame(() => { this.renderQueued = false; this.draw() })
}

private draw() {
  const ctx = this.ctx
  const canvas = this.canvasRef().nativeElement
  const dpr = window.devicePixelRatio || 1
  const w = canvas.width / dpr, h = canvas.height / dpr
  const vp = this.vp()

  ctx.save()
  ctx.fillStyle = '#f6f6f7'
  ctx.fillRect(0, 0, w, h)

  ctx.translate(vp.x, vp.y)
  ctx.scale(vp.scale, vp.scale)

  // Culling: compute the visible world rectangle, skip everything outside it
  const tl = screenToWorld(0, 0, vp)
  const br = screenToWorld(w, h, vp)
  const sel = this.store.selection()

  let drawn = 0
  for (const r of this.store.renderables()) {
    if (r.x + r.w < tl.x || r.x > br.x) continue
    if (r.y + r.h < tl.y || r.y > br.y) continue
    this.drawTile(ctx, r, vp.scale, sel.has(r.id))
    drawn++
  }

  ctx.restore()
  this.drawHud(ctx, w, h, drawn)   // screen space, after restore
}
```

**Two things here are the whole performance story.**

**The dirty flag.** Never run a continuous `requestAnimationFrame` loop. Render only when something changed, coalesced to one frame. An idle board should use zero CPU.

**Culling.** Convert the screen corners to world space to get the visible rectangle. At 300 items you might survive without it; at 5,000 you won't. **Mention culling unprompted in the interview.** It's the first thing anyone who has built a canvas app thinks about.

### Step 4: Drawing a tile with an image cache

```ts
private imageCache = new Map<string, HTMLImageElement>()
private inFlight = new Set<string>()

private getImage(url: string): HTMLImageElement | null {
  const hit = this.imageCache.get(url)
  if (hit) return hit
  if (this.inFlight.has(url)) return null

  this.inFlight.add(url)
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  img.onload = () => {
    this.imageCache.set(url, img)
    this.inFlight.delete(url)
    this.requestRender()
  }
  img.onerror = () => this.inFlight.delete(url)
  img.src = url
  return null
}

private drawTile(ctx: CanvasRenderingContext2D, r: Renderable,
                 scale: number, selected: boolean) {
  ctx.save()

  ctx.fillStyle = '#fff'
  ctx.shadowColor = 'rgba(0,0,0,0.12)'
  ctx.shadowBlur = 8 / scale
  ctx.shadowOffsetY = 2 / scale
  roundRect(ctx, r.x, r.y, r.w, r.h, 6 / scale)
  ctx.fill()
  ctx.shadowColor = 'transparent'

  // Level of detail: this is why Phase 4 generated two sizes
  const asset = r.product?.asset
  const url = asset ? (scale < 0.5 ? asset.thumb128 : asset.thumb512) : null
  const img = url ? this.getImage(url) : null

  if (img) {
    ctx.drawImage(img, r.x + 4, r.y + 4, r.w - 8, r.h - 28)
  } else {
    ctx.fillStyle = '#e5e7eb'
    ctx.fillRect(r.x + 4, r.y + 4, r.w - 8, r.h - 28)
  }

  // Skip text entirely when it would be unreadable
  if (scale > 0.35 && r.product) {
    ctx.fillStyle = '#111'
    ctx.font = `${11 / scale}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(clip(r.product.name, 24), r.x + 6, r.y + r.h - 22)
  }

  if (selected) {
    ctx.strokeStyle = '#2563eb'
    ctx.lineWidth = 2 / scale
    roundRect(ctx, r.x, r.y, r.w, r.h, 6 / scale)
    ctx.stroke()
  }

  ctx.restore()
}
```

**Every `/ scale` is deliberate.** Stroke widths, fonts, and shadow blur are specified in world units, so dividing by scale keeps them a constant *screen* size at any zoom. Without it, your selection outline vanishes zoomed out and becomes enormous zoomed in.

**Two level-of-detail optimizations here:** swapping image resolution by zoom, and skipping labels below a readability threshold. Both are real, both are recognizable to an interviewer.

### Step 5: Zoom to cursor

```ts
onWheel(e: WheelEvent) {
  e.preventDefault()
  const vp = this.vp()
  const rect = this.canvasRef().nativeElement.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top

  const before = screenToWorld(sx, sy, vp)          // world point under cursor
  const scale = clamp(vp.scale * Math.exp(-e.deltaY * 0.001), 0.05, 8)

  this.vp.set({ scale, x: sx - before.x * scale, y: sy - before.y * scale })
  this.requestRender()
}
```

**The principle:** find the world point under the cursor, change the scale, then solve for the pan that keeps that same world point under the cursor. Zooming toward the center instead feels wrong immediately and is the tell of a first attempt.

`Math.exp` gives symmetric zooming: in and out by the same delta returns you exactly where you started.

### Step 6: Pointer interaction

```ts
type Drag =
  | { mode: 'pan'; sx: number; sy: number; vp: Viewport }
  | { mode: 'move'; start: { x: number; y: number }; last: { x: number; y: number } }
  | { mode: 'marquee'; start: { x: number; y: number }; cur: { x: number; y: number } }

private drag: Drag | null = null

onPointerDown(e: PointerEvent) {
  this.canvasRef().nativeElement.setPointerCapture(e.pointerId)
  const world = this.toWorld(e)
  const hit = this.hitTest(world.x, world.y)

  if (e.button === 1 || e.altKey) {
    this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vp: this.vp() }
  } else if (hit) {
    if (!this.store.selection().has(hit.id)) {
      this.store.select(e.shiftKey
        ? new Set([...this.store.selection(), hit.id])
        : new Set([hit.id]))
    }
    this.drag = { mode: 'move', start: world, last: world }
  } else {
    this.drag = { mode: 'marquee', start: world, cur: world }
    if (!e.shiftKey) this.store.select(new Set())
  }
  this.requestRender()
}

onPointerMove(e: PointerEvent) {
  if (!this.drag) return

  if (this.drag.mode === 'pan') {
    this.vp.set({
      ...this.drag.vp,
      x: this.drag.vp.x + (e.clientX - this.drag.sx),
      y: this.drag.vp.y + (e.clientY - this.drag.sy),
    })
  } else if (this.drag.mode === 'move') {
    const world = this.toWorld(e)
    this.store.moveBy(
      this.store.selection(),
      world.x - this.drag.last.x,
      world.y - this.drag.last.y,
    )
    this.drag.last = world
  } else {
    this.drag.cur = this.toWorld(e)
    this.store.select(this.itemsInRect(this.drag.start, this.drag.cur))
  }
  this.requestRender()
}

onPointerUp(e: PointerEvent) {
  if (this.drag?.mode === 'move') this.persist.flush()   // save on release
  this.drag = null
  this.requestRender()
}
```

**Three details worth understanding rather than copying:**

**`setPointerCapture`** keeps the drag alive when the pointer leaves the canvas. Without it, dragging past the edge drops the item.

**Pan deltas are in screen pixels; move deltas are in world units.** Panning changes the viewport, so screen space is right. Moving an item changes world coordinates, so convert first. Mixing these is *the* canvas bug.

**Pointer Events, not mouse events.** One code path covers mouse, touch, and pen.

### Step 7: Hit testing

```ts
private hitTest(wx: number, wy: number): Renderable | null {
  const items = this.store.renderables()
  for (let i = items.length - 1; i >= 0; i--) {    // topmost first
    const r = items[i]!
    if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return r
  }
  return null
}
```

**Backwards iteration is the point.** Items draw in z-order, so the last drawn is on top, so hit testing must run the other way.

Linear scan is fine to a few thousand items. Beyond that you'd want a spatial index, a quadtree or R-tree. **Knowing the ceiling exists and naming the solution is a good answer even without implementing it.**

### Step 8: Accessibility

The parallel DOM layer is already in the template from step 1. Add keyboard movement:

```ts
onItemKey(e: KeyboardEvent, r: Renderable) {
  const step = e.shiftKey ? 50 : 10
  const deltas: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0],
    ArrowUp: [0, -step],   ArrowDown: [0, step],
  }
  const d = deltas[e.key]
  if (!d) return
  e.preventDefault()
  this.store.moveBy(new Set([r.id]), d[0], d[1])
  this.persist.schedule()
}
```

**Canvas is opaque to screen readers**, so `aria-hidden="true"` on the canvas plus a visually hidden list of the same items is the correct approach. **Raising this unprompted would set you apart substantially**, because canvas developers routinely skip it and it connects to accessibility knowledge you already have.

**Checkpoint for Phase 6:** 500 tiles, smooth pan and zoom, drag correct at every zoom level, marquee selection works, keyboard moves a focused item, and nothing renders when idle. Watch the flame chart in DevTools while panning.

---

## Phase 7: Persistence and conflict (4–5 hours)

### Debounced writes

```ts
// src/app/board/persist.service.ts
@Injectable()
export class PersistService {
  private api = inject(ApiService)
  private store = inject(BoardStore)
  private pending = new Set<string>()
  private timer?: number

  schedule() {
    for (const id of this.store.selection()) this.pending.add(id)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 400)
  }

  async flush() {
    clearTimeout(this.timer)
    if (!this.pending.size) return
    const ids = [...this.pending]
    this.pending.clear()

    const moves = this.store.placements()
      .filter(p => ids.includes(p.id))
      .map(p => ({ id: p.id, x: p.x, y: p.y, version: p.version }))

    try {
      await this.api.movePlacements(this.store.boardId(), moves)
      this.store.bumpVersions(ids)
    } catch (e) {
      if (isConflict(e)) await this.store.reload()   // someone else moved it
      else this.pending = new Set([...this.pending, ...ids])   // retry next flush
    }
  }
}
```

**Why debounce at all:** pointermove fires 60+ times a second. Writing on each would be absurd, and DynamoDB would throttle you. Coalescing to one write every 400ms plus one on release is the pattern.

**The conflict path is worth defending out loud.** Reloading on 409 is the simplest correct behavior. The alternatives (merge, or last-write-wins by forcing the version) are defensible too. For tile positions specifically, last-write-wins is usually acceptable and reloading is over-conservative. **Say which you chose and why.**

---
## Phase 8: Event-driven with DynamoDB Streams (6–8 hours)

**The highest-value addition in this guide after the canvas.** In one afternoon you get event-driven architecture, at-least-once delivery, idempotent consumers, the transactional outbox pattern, and eventual consistency — all as working code rather than vocabulary.

### Step 1: Why Streams instead of publishing events yourself

The naive approach:

```ts
await ddb.send(new UpdateCommand({ ... }))     // succeeds
await eventBridge.send(new PutEventsCommand({ ... }))   // fails
// Database and downstream consumers now permanently disagree.
```

That is the **dual write problem**, and reversing the order only changes which side is wrong. There is no transaction spanning both systems.

The **transactional outbox** pattern solves it: write the business record and the event in one atomic operation, then publish from the outbox asynchronously.

**DynamoDB Streams gives you this for free.** The stream *is* the change log, produced atomically with the write. You never explicitly dual-write. Being able to explain that in two sentences is one of the better answers available in a scenario exercise.

Enable it on the table:

```ts
new dynamodb.Table(this, 'Table', {
  // ...
  stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
})
```

`NEW_AND_OLD_IMAGES` because change history needs the before and after.

### Step 2: The consumer, written idempotently

```ts
// packages/api/src/handlers/stream-consumer.ts
import type { DynamoDBStreamEvent, DynamoDBBatchResponse } from 'aws-lambda'
import { unmarshall } from '@aws-sdk/util-dynamodb'

export async function handler(
  event: DynamoDBStreamEvent
): Promise<DynamoDBBatchResponse> {
  const failures: { itemIdentifier: string }[] = []

  for (const record of event.Records) {
    try {
      await processRecord(record)
    } catch (err) {
      console.error({ err, seq: record.dynamodb?.SequenceNumber }, 'record failed')
      failures.push({ itemIdentifier: record.dynamodb!.SequenceNumber! })
    }
  }

  // Partial batch response: only the failed records are retried
  return { batchItemFailures: failures }
}

async function processRecord(record: DynamoDBStreamRecord) {
  const keys = unmarshall(record.dynamodb!.Keys as any)
  if (!String(keys.SK).startsWith('ITEM#')) return    // only placements

  const oldImage = record.dynamodb!.OldImage
    ? unmarshall(record.dynamodb!.OldImage as any) : null
  const newImage = record.dynamodb!.NewImage
    ? unmarshall(record.dynamodb!.NewImage as any) : null

  const boardId = String(keys.PK).replace('BOARD#', '')

  // Deterministic ID derived from the stream position.
  // A replayed record produces the same ID, so the write is a no-op.
  const eventId = record.dynamodb!.SequenceNumber!

  await writeChangeEvent(boardId, eventId, {
    type: record.eventName,      // INSERT | MODIFY | REMOVE
    placementId: String(keys.SK).split('#')[2],
    before: oldImage ? { x: oldImage.x, y: oldImage.y } : null,
    after:  newImage ? { x: newImage.x, y: newImage.y } : null,
    at: new Date().toISOString(),
  })

  await updateBoardSummary(boardId)
}

async function writeChangeEvent(boardId: string, eventId: string, body: unknown) {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `BOARD#${boardId}#EVT`,
        SK: `EVT#${new Date().toISOString()}#${eventId}`,
        eventId,
        ...body,
        ttl: Math.floor(Date.now() / 1000) + 90 * 86400,   // 90 days
      },
      ConditionExpression: 'attribute_not_exists(eventId)',
    }))
  } catch (e: any) {
    if (e.name !== 'ConditionalCheckFailedException') throw e
    // Already processed. This is the idempotency guard doing its job.
  }
}
```

**Four things here are the actual lesson:**

**Delivery is at-least-once.** Lambda retries, and stream records can be redelivered. Duplicates are not a bug, they are the contract. Design the handler so a duplicate is harmless.

**Deterministic IDs.** The sequence number is stable across redeliveries, so the conditional write turns a duplicate into a no-op. This is idempotency by construction rather than by a dedup table.

**`batchItemFailures` (partial batch response).** Without it, one bad record fails the entire batch and everything already processed gets retried. With `ReportBatchItemFailures` enabled on the event source mapping, only the failures come back.

**Events go in their own partition** (`BOARD#<id>#EVT`), not alongside the placements. Change events grow without bound; keeping them in the same item collection as the board data would create a hot partition and eventually a size problem. TTL expires them automatically. **Volunteering this reasoning is worth more than a clean design.**

### Step 3: Configure the event source mapping

```ts
apiFn.addEventSource(new eventsources.DynamoEventSource(table, {
  startingPosition: lambda.StartingPosition.TRIM_HORIZON,
  batchSize: 100,
  maxBatchingWindow: Duration.seconds(2),
  retryAttempts: 3,
  bisectBatchOnError: true,
  reportBatchItemFailures: true,
  maxRecordAge: Duration.hours(6),
  onFailure: new eventsources.SqsDlq(streamDlq),
}))
```

**Every one of those settings prevents a specific failure**, and knowing why is exactly the kind of thing a scenario question tests:

- `bisectBatchOnError` splits a failing batch so one poison record doesn't fail 99 good ones
- `retryAttempts` and `maxRecordAge` prevent a permanently-failing record from blocking the shard forever
- `onFailure` sends what can't be processed to a DLQ instead of dropping it silently
- Without these, **one malformed record halts that shard indefinitely.** That's scenario 2 in the scenario bank, and now you'll have configured the fix.

### Step 4: The projection

`updateBoardSummary` maintains a denormalized summary item: placement count, last modified, contributor list. The board list page reads summaries instead of counting placements.

**This is CQRS**, whether or not anyone calls it that: DynamoDB is the write model, the summary is a read model, and the stream keeps them in sync eventually. Say the word in an interview.

**And it introduces a real problem you should acknowledge:** the summary is eventually consistent. Move a tile and the board list may show a stale count for a second or two. That's acceptable here; the alternative (computing it on read) doesn't scale. Name the tradeoff.

### Step 5: Add an events route

```ts
app.get('/api/boards/:id/events', async (req) => {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `BOARD#${req.params.id}#EVT` },
    ScanIndexForward: false,
    Limit: 50,
  }))
  return { items: Items }
})
```

Then a simple activity panel in Angular. Watching your own drags appear in the history a second later is the moment eventual consistency stops being abstract.

**Checkpoint for Phase 8:** drag a tile, see a change event appear within a couple of seconds. Deliberately throw in the consumer for one record and watch it land in the DLQ while the others process.

---

## Phase 9: EventBridge and asynchronous work (5–7 hours)

Streams gave you change capture. EventBridge gives you routing, fan-out, and a genuine messaging architecture.

### Step 1: Publish domain events

The stream consumer emits *domain* events, distinct from the raw database change:

```ts
await eventBridge.send(new PutEventsCommand({
  Entries: [{
    EventBusName: BUS_NAME,
    Source: 'assortment.board',
    DetailType: 'PlacementMoved',
    Detail: JSON.stringify({
      boardId, placementId, productId, from, to, at, eventId,
    }),
  }],
}))
```

**Why a separate domain event rather than forwarding the stream record.** A stream record is a database row diff, coupled to your table design. A domain event is a statement about the business, and consumers should depend on that instead. This is the difference between an event notification and an implementation detail leaking outward, and it's a real architecture point.

### Step 2: Rules and routing

```ts
new events.Rule(this, 'PriceChangeRule', {
  eventBus: bus,
  eventPattern: {
    source: ['assortment.catalog'],
    detailType: ['ProductPriceChanged'],
  },
  targets: [new targets.SqsQueue(notificationQueue, {
    deadLetterQueue: notificationDlq,
    retryAttempts: 3,
  })],
})
```

**Content-based routing is what EventBridge does that SNS doesn't.** Rules match on the payload, not just the topic. Be ready to explain the difference: SNS for simple fan-out, EventBridge for routing on content or integrating with SaaS partners, SQS when you need a durable work queue with one consumer per message.

**The SNS-to-SQS fan-out pattern** is worth knowing even though EventBridge covers it here: publish once, each consumer gets its own queue, so each gets independent retry and its own DLQ.

### Step 3: The notification consumer, with debouncing

This is where a naive implementation embarrasses itself.

```ts
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = []

  // Group by recipient so a bulk update becomes one digest, not 500 emails
  const byRecipient = new Map<string, Notification[]>()

  for (const record of event.Records) {
    try {
      const detail = JSON.parse(record.body)
      const subscribers = await findSubscribers(detail.productId)
      for (const s of subscribers) {
        const list = byRecipient.get(s.userId) ?? []
        list.push(toNotification(detail))
        byRecipient.set(s.userId, list)
      }
    } catch {
      failures.push({ itemIdentifier: record.messageId })
    }
  }

  for (const [userId, items] of byRecipient) {
    // Idempotency: a deterministic key from the content
    const digestKey = hash(userId, items.map(i => i.eventId).sort().join())
    await sendDigestOnce(userId, items, digestKey)
  }

  return { batchItemFailures: failures }
}
```

**Batching into digests is the part most candidates miss** and the part users actually care about. A bulk price update on 5,000 products should not generate 5,000 emails. Configure the SQS event source with `batchSize` and `maxBatchingWindow` so records accumulate before invoking.

**Dedupe on send**, because at-least-once means the same digest can be attempted twice.

### Step 4: Retries, backoff, and the DLQ

Configure the queue properly and understand each setting:

```ts
const notificationDlq = new sqs.Queue(this, 'NotifyDlq', {
  retentionPeriod: Duration.days(14),
})

const notificationQueue = new sqs.Queue(this, 'NotifyQueue', {
  visibilityTimeout: Duration.seconds(180),   // ≥ 6x the Lambda timeout
  deadLetterQueue: { queue: notificationDlq, maxReceiveCount: 5 },
})
```

**Visibility timeout must exceed the consumer's timeout**, or the message becomes visible again while still being processed and you get guaranteed duplicates. This is a classic production bug and a good thing to be able to name.

**Alarm on DLQ depth.** A DLQ nobody watches is a silent data-loss mechanism. Add it in Phase 11.

**In the SDK client**, configure retry with jitter:

```ts
const client = new EventBridgeClient({
  maxAttempts: 4,
  retryMode: 'adaptive',    // AWS SDK v3: adaptive includes backoff + jitter
})
```

**Why jitter matters:** without it, retries from many clients synchronize into waves and you get a retry storm that keeps the system down after the original trigger clears. That's a **metastable failure**, and naming it is a strong vocabulary signal.

### Step 5: Circuit breaking

Add a simple breaker around the outbound email call:

```ts
class CircuitBreaker {
  private failures = 0
  private openUntil = 0

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() < this.openUntil) throw new Error('circuit open')
    try {
      const result = await fn()
      this.failures = 0
      return result
    } catch (e) {
      if (++this.failures >= 5) this.openUntil = Date.now() + 30_000
      throw e
    }
  }
}
```

Crude (real ones need shared state across instances, and a half-open probe), but it makes the concept concrete. **Say what's missing when you describe it**: in Lambda, each execution environment has its own breaker, so a truly effective one needs shared state in DynamoDB or Redis. Naming that limitation is better than presenting the toy as complete.

**Checkpoint for Phase 9:** change a product price, see one digest notification for a subscriber rather than N. Break the sender deliberately and watch messages reach the DLQ after five attempts.

---

## Phase 10: Splitting a service (5–7 hours)

**The point of this phase is judgment as much as mechanics.** You are going to split exactly one service and write down why you're not splitting the others.

### Step 1: Choose the boundary honestly

Media processing is the right thing to extract, and the reasons are specific:

- **Different scaling profile.** Image processing is bursty and CPU-heavy; the API is steady and IO-bound.
- **Different failure tolerance.** A thumbnail failing to generate should not affect anyone using a board.
- **Different resource needs.** Sharp needs memory and a native binary; the API needs neither.
- **Clean data ownership.** It owns asset records and nothing else touches them.
- **Genuinely asynchronous.** Nothing waits on it synchronously.

**Everything else stays together**, and ADR 012 should say so plainly: boards, placements, products, and the catalog all change together, share a data model, and are queried in the same request. Splitting them would create a distributed monolith — all the cost of services, none of the benefit.

**That restraint is the interview point.** A candidate who proposes twelve services for a small product is demonstrating enthusiasm, not judgment.

### Step 2: The physical split

```
packages/
  shared/         ← contract, used by all
  api/            ← boards, placements, products
  media/          ← NEW: asset processing service
  web/
infra/
  lib/
    core-stack.ts     ← table, API, web hosting, bus
    media-stack.ts    ← NEW: media bucket, processing lambdas, own queue
```

Two stacks means two independent deploys, which is what makes this a real service boundary rather than a folder.

### Step 3: The contract between them

`packages/shared/src/events.ts`:

```ts
import { z } from 'zod'

/** Emitted by api → consumed by media */
export const AssetUploadRequested = z.object({
  version:   z.literal(1),
  assetId:   z.string().uuid(),
  productId: z.string().uuid(),
  key:       z.string(),
  requestedAt: z.string().datetime(),
})

/** Emitted by media → consumed by api */
export const AssetProcessed = z.object({
  version:   z.literal(1),
  assetId:   z.string().uuid(),
  productId: z.string().uuid(),
  derivatives: z.array(z.object({
    size: z.number().int(),
    key: z.string(),
    contentType: z.string(),
  })),
  width:  z.number().int().positive(),
  height: z.number().int().positive(),
})

export const AssetFailed = z.object({
  version:   z.literal(1),
  assetId:   z.string().uuid(),
  productId: z.string().uuid(),
  reason:    z.string(),
})
```

**The `version: z.literal(1)` field is deliberate.** An event schema is a contract with consumers you may not know about. Additive changes are safe; anything else requires a new version published alongside the old during a migration window. Write this in an ADR.

**Consumers must ignore unknown fields.** That has to be a stated convention or every producer change breaks someone. The term is **tolerant reader**.

### Step 4: Data ownership

**Media owns asset records. The API never writes them.** When processing completes, media emits `AssetProcessed`, and a consumer in the API service updates the product's asset reference.

This is the rule that makes a service boundary real: **one writer per piece of data, and everyone else goes through events or an API.** Sharing a table across services is the single most common way microservice architectures collapse into distributed monoliths.

Practically, that means media gets its own table (or at minimum, its own key space with an IAM policy that prevents it from writing anything else). The IAM-scoped version is a reasonable compromise at this scale and worth noting as such.

### Step 5: Failure across the boundary

Now the interesting part: what happens when media is down?

- **Uploads still work.** The presigned URL comes from the API and S3 accepts the bytes.
- **Derivatives don't generate.** Asset records stay `pending`.
- **The board still renders**, showing placeholders where images would be.
- **When media recovers**, queued messages process and images appear.

**That is graceful degradation, and it is the payoff for asynchronous communication.** If the API called media synchronously, media being down would break uploads entirely.

Write this failure analysis into ADR 013. It's the concrete answer to "why async between services," and it's more persuasive than the abstract version.

**Checkpoint for Phase 10:** stop the media service, upload an image, confirm the board still works with a placeholder, restart media, confirm the image appears.

---

## Phase 11: Observability and operations (4–5 hours)

You now have two services, a stream, a bus, two queues, and two DLQs. Debugging by reading logs is over.

### Structured logging with correlation

```ts
import { Logger } from '@aws-lambda-powertools/logger'
import { Tracer } from '@aws-lambda-powertools/tracer'
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics'

const logger = new Logger({ serviceName: 'assortment-api' })
const tracer = new Tracer({ serviceName: 'assortment-api' })
const metrics = new Metrics({ namespace: 'Assortment' })

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger, { correlationIdPath: 'headers.x-correlation-id' }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics))
```

**Lambda Powertools for TypeScript** is close to the default answer for observability in a TypeScript Lambda shop, and naming it signals current familiarity.

**The hard part is correlation across async boundaries.** A trace through a synchronous HTTP chain works automatically. **Lambda → Streams → Lambda → EventBridge → SQS → Lambda drops the context unless you deliberately propagate it.** Put the correlation ID in the event detail and read it back:

```ts
Detail: JSON.stringify({ ...payload, correlationId: logger.getCorrelationId() })
```

**This is the single most common gap in serverless observability**, and being able to say so is a strong signal.

### Metrics via EMF

```ts
metrics.addMetric('PlacementsMoved', MetricUnit.Count, moves.length)
metrics.addMetric('MoveLatency', MetricUnit.Milliseconds, elapsed)
```

**Embedded Metric Format writes a structured log line that CloudWatch parses into metrics**, so there's no synchronous API call in your request path. That matters in Lambda where every millisecond is billed.

### Alarms that matter

- **DLQ depth > 0** on both DLQs. Non-negotiable.
- **Stream iterator age** rising, which means the consumer is falling behind or blocked.
- **API 5xx rate** and **p99 latency**.
- **DynamoDB throttled requests.**

**Alert on symptoms, not causes.** "Board load failing" beats "CPU high." Users don't care about CPU.

### Log retention

Set it to 14 days on every log group. Indefinite retention is a top-three surprise AWS cost and it's a one-line fix in CDK.

---

## Phase 12: Reconciliation (3–4 hours)

**Your signature answer, built once so it becomes yours.**

Every eventually consistent system drifts. Stream records expire, consumers have bugs, DLQ messages get abandoned. The board summary will eventually disagree with reality.

```ts
// packages/api/src/jobs/reconcile.ts
export async function reconcileBoardSummaries() {
  const discrepancies: Discrepancy[] = []

  for await (const boardId of iterateBoardIds()) {
    const [actual, summary] = await Promise.all([
      countPlacements(boardId),
      getBoardSummary(boardId),
    ])

    if (summary?.placementCount !== actual) {
      discrepancies.push({
        boardId,
        expected: actual,
        found: summary?.placementCount ?? null,
      })
      await repairBoardSummary(boardId, actual)
    }
  }

  metrics.addMetric('ReconciliationDiscrepancies',
    MetricUnit.Count, discrepancies.length)

  if (discrepancies.length > 0) {
    logger.warn({ discrepancies }, 'repaired summary drift')
  }
  return discrepancies
}
```

Run it nightly on an EventBridge schedule.

**Three things to understand about this, beyond the code:**

**Emit the discrepancy count as a metric and alarm on it.** A reconciliation job that silently repairs is hiding a bug. If drift is increasing, something upstream is broken and you want to know.

**Repair, don't just report.** But log what you repaired, because the pattern in what drifts tells you where the bug is.

**The same job is your recovery path.** If the stream consumer is broken for a day, reconciliation is how you catch up without replaying a stream that may have expired.

**In an interview:** "any eventually consistent projection drifts eventually, so I'd want a reconciliation job" is a sentence that marks you as someone who has operated one of these systems rather than read about one. Now you'll have written it.

---

## Phase 13: The system design document (3–4 hours, no code)

The last topic on your friend's list, and the only one that isn't code.

Write `docs/DESIGN.md` describing the version of Assortment that serves **500 tenants and 10,000 concurrent users** — a system you are deliberately not building. This is the artifact most directly relevant to a design round.

### What to cover

**Requirements and assumptions.** Functional and non-functional, stated explicitly. Scale numbers, latency budget, availability target, consistency requirements. **State your assumptions out loud**, because that's the first thing a good system design answer does.

**Back-of-envelope estimates.** 500 tenants × 20 boards × 300 placements = 3M placement records. Peak write rate during a line review. Image storage volume. Only estimate what changes a decision.

**The API contract**, since for a platform the interface is the product.

**Architecture**, with the request path for the two or three primary flows.

**Multi-tenancy.** Pooled or siloed? Where is isolation enforced? Tenant in the partition key, tenant from the token never from the request, IAM session policies for defense in depth. **Name BOLA** as the vulnerability class you're preventing.

**The hard problems, each with a decision and a tradeoff:**

- **Real-time collaboration.** WebSockets via API Gateway, connection IDs in DynamoDB with a TTL, fan-out cost per board. What happens on reconnect.
- **Concurrent editing.** Last-write-wins vs optimistic locking vs field-level merge vs CRDTs. Recommend one and say what it costs.
- **Hot tenants.** One customer with 50,000 products. Write sharding, reserved concurrency, separate queues by tier. The bulkhead pattern.
- **Search and filtering.** Twenty filter combinations is not a DynamoDB problem. OpenSearch fed by Streams, with the eventual consistency that implies.
- **Image delivery at scale.** CloudFront, cache keys, the derivative pipeline, cost.

**Failure modes.** What breaks first as load grows. What happens when each dependency fails. Blast radius of a bad deploy.

**Operations.** Deployment strategy, rollback, migration path, monitoring, on-call.

**What you'd defer and why.** The most senior section in any design doc. Multi-region, CRDTs, a service mesh: name them and say why they're not warranted at this stage. **Right-sizing is judgment; proposing global active-active for a fifty-person company is not ambition.**

### Why this is worth four hours

A scenario exercise is essentially this document, written under time pressure, on a topic you haven't chosen. Writing one carefully now means the structure is automatic later: clarify, estimate, interface, architecture, deep dive, failure modes, operations, tradeoffs deferred.

And if the exercise happens to touch any of the areas above, you'll have already thought it through.

---

## Phase 14: Testing (5–6 hours)

**Unit** the pure geometry. `worldToScreen` and `screenToWorld` should round-trip:

```ts
it('round-trips coordinates', () => {
  const vp = { x: 137, y: -42, scale: 2.5 }
  const s = worldToScreen(100, 200, vp)
  const w = screenToWorld(s.x, s.y, vp)
  expect(w.x).toBeCloseTo(100)
  expect(w.y).toBeCloseTo(200)
})
```

**Integration** the API against real DynamoDB Local, not mocks. **Never mock the database**: mocked tests pass while your key conditions are wrong, which is the worst outcome available.

**Write one test for optimistic locking specifically.** Two concurrent moves with the same version; assert one succeeds and one gets a 409. That's the test to point at in an interview.

**Component** tests via Angular TestBed for the store logic. The canvas itself is hard to unit test; test the geometry and interaction state machine instead of pixels.

**One E2E** with Playwright: load a board, drag a tile, reload, confirm it moved.

### Testing the event-driven parts

These need their own approach and they're where most people give up and mock everything.

**Test consumers as pure functions.** Extract the record-processing logic from the Lambda handler so you can call it directly with a synthetic stream record. No AWS involved.

**Test idempotency explicitly.** Call the consumer twice with the same record and assert the second call is a no-op. This is the single most valuable test in the event-driven half of the project:

```ts
it('is idempotent under redelivery', async () => {
  const record = makeStreamRecord({ sequenceNumber: 'SEQ-1' })
  await processRecord(record)
  await processRecord(record)          // redelivery
  const events = await queryEvents(boardId)
  expect(events).toHaveLength(1)
})
```

**Test the poison-record path.** Feed a batch where one record is malformed; assert the good ones still process and only the bad one comes back in `batchItemFailures`.

**Use LocalStack for integration** across services. It emulates DynamoDB Streams, EventBridge, SQS, and S3 well enough to test the whole pipeline end to end, and Testcontainers can start it per test file.

**Test the reconciliation job by deliberately corrupting state**: write a summary with a wrong count, run reconcile, assert it repaired and reported one discrepancy.

---

## Phase 15: Deploy (5–7 hours)

CDK in TypeScript. The pieces:

**Two stacks now**, since Phase 10 split the services.

`core-stack.ts`:
- **DynamoDB table**, on-demand billing, GSI1, **Streams enabled** with `NEW_AND_OLD_IMAGES`
- **Stream consumer Lambda** with the event source mapping settings from Phase 8, plus its DLQ
- **API Lambda** running Fastify behind an HTTP API
- **EventBridge bus** and rules
- **Angular build to an S3 bucket**, served through CloudFront with Origin Access Control
- **CloudFront** routes `/api/*` to the API and everything else to the static bucket, so the app is same-origin
- **404 to index.html** so Angular's client-side routing survives a refresh on a deep link
- **Reconciliation Lambda** on a nightly EventBridge schedule

`media-stack.ts`:
- **Assets bucket**, all public access blocked
- **Processing Lambda** with more memory and the Sharp layer
- **Its own queue and DLQ**
- **A rule subscribing to `AssetUploadRequested`** on the shared bus

**Cross-stack references** are the thing to get right: export the bus name and table ARN from core, import them in media. CDK handles this, but be aware it creates a deployment ordering dependency, and that removing an exported value while another stack still references it will fail. That's worth an ADR note.

**Things worth understanding rather than pasting:**

Serving the API under the same CloudFront domain avoids CORS and keeps any cookies first-party. If you split domains you'll fight SameSite.

Set a `CacheControl` header on the Angular build: hashed assets get `immutable`, `index.html` gets `no-cache`. Otherwise a deploy leaves users on a stale shell pointing at missing chunks.

Lambda memory is the performance dial, since CPU scales with it. Try 512 and 1024 and measure; the larger is often cheaper because it finishes more than twice as fast.

**CI gates** worth adding: typecheck, tests, an Angular bundle budget that *fails* the build, and axe accessibility checks.

---

## Appendix A: The short path

If you have two or three days rather than two weeks:

1. `ng new board-demo`
2. Hardcode 400 placements with placeholder image URLs
3. Build Phase 6 in full: setup, transform, render loop, tiles, zoom-to-cursor, pointer interaction, hit testing, accessibility layer
4. Write ADR 003 (canvas vs DOM) and ADR 012 (why split one service and not the rest) properly
5. Write Phase 13, the system design document

That gets you the two things you can't fake: the canvas mechanics, and written evidence of architectural reasoning. The backend concepts you can already discuss from the DynamoDB, distributed systems, and AWS documents; the canvas you cannot discuss credibly without having built it.

**If you get one more day after that, add Phase 8.** DynamoDB Streams alone converts event-driven architecture, at-least-once delivery, idempotency, and the transactional outbox from vocabulary into code you wrote.

---

## What to say in the interview

**On canvas**, the five things that signal experience: world and screen coordinate spaces kept strictly separate, culling offscreen items, the dirty-flag render loop instead of a continuous one, dividing stroke widths and fonts by scale, and level-of-detail image swapping.

**On DynamoDB**, that you enumerate access patterns before designing keys, and that the item collection is a pre-computed join. The zero-padded z-order sort key is a nice concrete detail.

**On S3**, presigned uploads keeping bytes out of your compute, and the two-system consistency problem that requires reconciliation.

**On Angular**, signals plus OnPush as the current model, and `effect()` as the bridge from signals to an imperative render loop.

**On event-driven systems**, that DynamoDB Streams *is* a transactional outbox, which is why the dual-write problem never arises. That delivery is at-least-once, so duplicates are the contract rather than a bug, and deterministic IDs plus conditional writes make handlers idempotent by construction. That `bisectBatchOnError` and a failure destination are what stop one poison record from halting a shard.

**On microservices**, that you split media processing for specific reasons (different scaling profile, different failure tolerance, clean data ownership) and deliberately did not split anything else. **The restraint is the signal.** One writer per piece of data; sharing a table across services is how architectures collapse into distributed monoliths.

**On distributed systems**, that retries need jitter or they synchronize into a metastable failure, that visibility timeout must exceed the consumer timeout or you guarantee duplicates, and that any eventually consistent projection drifts, so you need a reconciliation job. That last one is the sentence that marks someone who has operated one of these.

**On system design**, the structure: clarify requirements and state assumptions, estimate only what changes a decision, design the interface before the internals, name a tradeoff for every significant choice, reach failure modes and operations before time runs out, and say explicitly what you'd defer and why.

**And the connection between layers, which is the thing most candidates won't articulate:** you generate 128px derivatives in S3 specifically so the canvas can render 500 tiles at low zoom without fetching 500 full-size images. A storage decision made to serve a rendering constraint.

That observation is what twenty years actually buys you, and it's the one nobody can prepare for you.
