import { Injectable, inject, signal, computed } from '@angular/core'
import type { Board, Placement, Product } from '@assortment/shared'
import { ApiService } from '../core/api.service'

/** A placement joined with its product — what the canvas actually draws. */
export type Renderable = Placement & { readonly product: Product | undefined }

/**
 * The seam between Angular and the canvas. Getting this right is what makes the
 * canvas simple: the canvas never joins data itself, it just draws `renderables`.
 *
 * Provided per-route (not root), so there is exactly one store per board.
 */
@Injectable()
export class BoardStore {
  private api = inject(ApiService)

  private _board = signal<Board | null>(null)
  private _placements = signal<Placement[]>([])
  private _products = signal<Map<string, Product>>(new Map())
  private _selection = signal<ReadonlySet<string>>(new Set())
  private _loading = signal(false)

  // Private-signal-plus-readonly-view keeps mutation in one place.
  readonly board = this._board.asReadonly()
  readonly placements = this._placements.asReadonly()
  readonly selection = this._selection.asReadonly()
  readonly loading = this._loading.asReadonly()

  readonly boardId = computed(() => this._board()?.id ?? '')
  readonly selectedCount = computed(() => this._selection().size)

  /** Placements joined with product data — a computed, so the canvas never joins. */
  readonly renderables = computed<Renderable[]>(() => {
    const products = this._products()
    return this._placements().map(p => ({ ...p, product: products.get(p.productId) }))
  })

  async load(boardId: string) {
    this._loading.set(true)
    try {
      const view = await this.api.getBoard(boardId)
      this._board.set(view.board)
      this._placements.set(view.placements)
      this._products.set(new Map(view.products.map(p => [p.id, p])))
    } finally {
      this._loading.set(false)
    }
  }

  /** Optimistic local move. Persistence is separate and debounced (Phase 7). */
  moveBy(ids: ReadonlySet<string>, dx: number, dy: number) {
    this._placements.update(ps =>
      ps.map(p => (ids.has(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p)),
    )
  }

  select(ids: ReadonlySet<string>) {
    this._selection.set(ids)
  }
}
