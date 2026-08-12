import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { BoardView, Board, BoardList } from '@assortment/shared'

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
}
