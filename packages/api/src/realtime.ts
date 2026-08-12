// In-process connection registry for local/dev real-time: board id -> live sockets.
// In AWS the equivalent is an API Gateway WebSocket API with the connection registry
// in DynamoDB and a fan-out Lambda on PlacementMoved (see ADR 0016 / DESIGN.md §6.1).

import type { Placement, Product } from '@assortment/shared'

// Structural socket type — avoids depending on `ws`'s types directly.
export interface Socket {
  readyState: number
  send(data: string): void
}

const boards = new Map<string, Set<Socket>>()

export function subscribe(conn: Socket, boardId: string): void {
  let set = boards.get(boardId)
  if (!set) {
    set = new Set()
    boards.set(boardId, set)
  }
  set.add(conn)
}

export function unsubscribeAll(conn: Socket): void {
  for (const set of boards.values()) set.delete(conn)
}

export interface MovedDelta {
  boardId: string
  actorUserId: string
  moves: { id: string; x: number; y: number; version: number }[]
}

export interface AddedDelta {
  boardId: string
  actorUserId: string
  placement: Placement
  // The peer may not have this product loaded, so ship it alongside the placement.
  product?: Product
}

export interface RemovedDelta {
  boardId: string
  actorUserId: string
  placementId: string
}

/** Push a message to every open socket subscribed to a board. */
function broadcast(boardId: string, msg: object): void {
  const set = boards.get(boardId)
  if (!set || set.size === 0) return
  const data = JSON.stringify(msg)
  for (const conn of set) {
    if (conn.readyState === 1 /* OPEN */) conn.send(data)
  }
}

/** Push a move to every socket subscribed to the board. */
export function broadcastMoved(delta: MovedDelta): void {
  broadcast(delta.boardId, { type: 'placements.moved', ...delta })
}

/** Push a newly-added placement (with its product) to a board's subscribers. */
export function broadcastAdded(delta: AddedDelta): void {
  broadcast(delta.boardId, { type: 'placements.added', ...delta })
}

/** Push a removed placement id to a board's subscribers. */
export function broadcastRemoved(delta: RemovedDelta): void {
  broadcast(delta.boardId, { type: 'placements.removed', ...delta })
}
