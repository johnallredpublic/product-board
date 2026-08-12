import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpParams } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { BoardView, Board, BoardList, Placement, CatalogResults, CatalogItem, Product, UpdateProduct } from '@assortment/shared'

/** One placement move the client sends (matches the MovePlacements contract). */
export interface MoveInput {
  id: string
  x: number
  y: number
  version: number
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient)

  async getBoard(id: string): Promise<BoardView> {
    const raw = await firstValueFrom(this.http.get(`/api/boards/${id}`))
    // Runtime validation at the boundary. TS types are erased at runtime; the Zod
    // schema is what actually catches a contract violation, and it catches it here
    // rather than three frames deeper in the canvas.
    return BoardView.parse(raw)
  }

  async movePlacements(boardId: string, moves: MoveInput[]): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.patch<{ ok: boolean }>(`/api/boards/${boardId}/placements`, { moves }),
    )
  }

  async listBoards(): Promise<Board[]> {
    const raw = await firstValueFrom(this.http.get('/api/boards'))
    return BoardList.parse(raw).boards
  }

  async createBoard(input: { name: string; season: Board['season'] }): Promise<Board> {
    const raw = await firstValueFrom(this.http.post('/api/boards', input))
    return Board.parse(raw)
  }

  /** Add a product to a board; the server assigns id, z-order, and version. */
  async addPlacement(boardId: string, input: { productId: string; x: number; y: number }): Promise<Placement> {
    const raw = await firstValueFrom(this.http.post(`/api/boards/${boardId}/placements`, input))
    return Placement.parse(raw)
  }

  /** Remove a placement from a board. */
  async removePlacement(boardId: string, placementId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/boards/${boardId}/placements/${placementId}`))
  }

  /** Catalog search — the products a user can drop onto a board. */
  async searchCatalog(query: { q?: string; season?: string } = {}): Promise<CatalogItem[]> {
    let params = new HttpParams()
    if (query.q) params = params.set('q', query.q)
    if (query.season) params = params.set('season', query.season)
    const raw = await firstValueFrom(this.http.get('/api/catalog', { params }))
    return CatalogResults.parse(raw).items
  }

  /** Edit a product (field-level merge). Returns the updated product. */
  async updateProduct(id: string, patch: UpdateProduct): Promise<Product> {
    const raw = await firstValueFrom(this.http.patch(`/api/products/${id}`, patch))
    return Product.parse(raw)
  }
}
