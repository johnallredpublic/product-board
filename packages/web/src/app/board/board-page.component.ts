import { Component, inject, input, effect } from '@angular/core'
import { DecimalPipe } from '@angular/common'
import { BoardStore } from './board-store'

/**
 * Temporary text view proving the store loads real data and `renderables` joins
 * placements with products. Phase 6 replaces the <ul> with the canvas.
 */
@Component({
  selector: 'app-board-page',
  imports: [DecimalPipe],
  template: `
    @if (store.loading()) {
      <p>Loading…</p>
    } @else if (store.board(); as board) {
      <h1>{{ board.name }} <small>({{ board.season }})</small></h1>
      <p>{{ store.renderables().length }} placements · {{ store.selectedCount() }} selected</p>
      <ul>
        @for (r of store.renderables(); track r.id) {
          <li>
            {{ r.product?.name ?? '(unknown product)' }}
            — ({{ r.x | number: '1.0-0' }}, {{ r.y | number: '1.0-0' }})
          </li>
        }
      </ul>
      <p><em>Canvas rendering arrives in Phase 6.</em></p>
    } @else {
      <p>Board not found.</p>
    }
  `,
})
export class BoardPageComponent {
  protected store = inject(BoardStore)

  // Bound from the :boardId route param via withComponentInputBinding().
  boardId = input.required<string>()

  constructor() {
    // Reading the input signal inside an effect re-loads whenever it changes.
    effect(() => {
      const id = this.boardId()
      if (id) void this.store.load(id)
    })
  }
}
