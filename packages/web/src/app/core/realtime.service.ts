import { Injectable, inject } from '@angular/core'
import { BoardStore } from '../board/board-store'

/**
 * Live board updates over a WebSocket. Subscribes to a board, applies peers' moves
 * to the store (the canvas re-renders via its signal effect), and on a dropped
 * connection reconnects and re-fetches to resync — the socket carries deltas, not
 * truth. Provided per-board route (needs the route-scoped BoardStore).
 */
@Injectable()
export class RealtimeService {
  private store = inject(BoardStore)
  private ws?: WebSocket
  private boardId = ''
  private closed = false
  private reconnected = false
  private static readonly BASE_BACKOFF = 1000
  private static readonly MAX_BACKOFF = 30_000
  private backoff = RealtimeService.BASE_BACKOFF

  connect(boardId: string) {
    this.boardId = boardId
    this.closed = false
    this.open()
  }

  disconnect() {
    this.closed = true
    this.ws?.close()
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/realtime`)
    this.ws = ws

    ws.onopen = () => {
      this.backoff = RealtimeService.BASE_BACKOFF // connected — reset the retry delay
      ws.send(JSON.stringify({ type: 'subscribe', boardId: this.boardId }))
      if (this.reconnected) {
        this.reconnected = false
        void this.store.reload() // catch up on anything missed while disconnected
      }
    }
    ws.onmessage = (e) => {
      let msg: any
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.type === 'placements.moved' && Array.isArray(msg.moves)) {
        this.store.applyRemoteMoves(msg.moves)
      } else if (msg.type === 'placements.added' && msg.placement) {
        this.store.applyRemoteAdd(msg.placement, msg.product)
      } else if (msg.type === 'placements.removed' && msg.placementId) {
        this.store.applyRemoteRemove(msg.placementId)
      }
    }
    ws.onclose = () => {
      if (this.closed) return
      this.reconnected = true
      // Exponential backoff (capped) so an unavailable server — e.g. before the prod
      // WebSocket API exists — doesn't retry every second forever.
      const delay = this.backoff
      this.backoff = Math.min(this.backoff * 2, RealtimeService.MAX_BACKOFF)
      setTimeout(() => this.open(), delay)
    }
    ws.onerror = () => ws.close()
  }
}
