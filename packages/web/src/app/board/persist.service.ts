import { Injectable, inject } from '@angular/core'
import { HttpErrorResponse } from '@angular/common/http'
import { ApiService } from '../core/api.service'
import { BoardStore } from './board-store'

const isConflict = (e: unknown) => e instanceof HttpErrorResponse && e.status === 409

/**
 * Debounced persistence for placement moves. Provided per-route alongside
 * BoardStore so it shares the same store instance.
 *
 * pointermove fires 60+ times a second; writing on each would be absurd and would
 * throttle DynamoDB. Coalesce to one write every 400ms (schedule) plus one
 * immediate write on pointer-up (flush).
 */
@Injectable()
export class PersistService {
  private api = inject(ApiService)
  private store = inject(BoardStore)
  private pending = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>

  /** Queue a debounced save. Defaults to the current selection. */
  schedule(ids?: Iterable<string>) {
    for (const id of ids ?? this.store.selection()) this.pending.add(id)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  /** Save now. Optionally queue `ids` first (e.g. the selection on drag release). */
  async flush(ids?: Iterable<string>) {
    if (ids) for (const id of ids) this.pending.add(id)
    clearTimeout(this.timer)
    if (!this.pending.size) return

    const toSave = [...this.pending]
    this.pending.clear()

    const moves = this.store
      .placements()
      .filter(p => toSave.includes(p.id))
      .map(p => ({ id: p.id, x: p.x, y: p.y, version: p.version }))
    if (!moves.length) return

    try {
      await this.api.movePlacements(this.store.boardId(), moves)
      this.store.bumpVersions(toSave) // keep local versions in step with the server
    } catch (e) {
      if (isConflict(e)) {
        // Someone else moved it. Reloading is the simplest correct behavior;
        // last-write-wins or a merge are defensible alternatives (see ADR 0009).
        await this.store.reload()
      } else {
        // Transient failure — retry these ids on the next flush.
        for (const id of toSave) this.pending.add(id)
      }
    }
  }
}
