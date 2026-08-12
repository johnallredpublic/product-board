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
      setTimeout(() => this.open(), 1000)
    }
    ws.onerror = () => ws.close()
  }
}
