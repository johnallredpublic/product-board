import { Component, inject, input, effect } from '@angular/core'
import { RouterLink } from '@angular/router'
import { BoardStore } from './board-store'
import { BoardCanvasComponent } from './board-canvas.component'

@Component({
  selector: 'app-board-page',
  imports: [RouterLink, BoardCanvasComponent],
  template: `
    @if (store.loading()) {
      <p class="status">Loading…</p>
    } @else if (store.board(); as board) {
      <header class="bar">
        <a routerLink="/boards">← Boards</a>
        <strong>{{ board.name }}</strong>
        <span class="muted">({{ board.season }})</span>
        <span class="spacer"></span>
        <span class="muted">
          {{ store.renderables().length }} items · {{ store.selectedCount() }} selected
        </span>
      </header>
      <app-board-canvas class="canvas" />
    } @else {
      <p class="status">Board not found.</p>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; }
    .bar {
      display: flex; align-items: center; gap: .6rem;
      padding: .5rem .8rem; border-bottom: 1px solid #e5e7eb;
      font: 14px system-ui, sans-serif;
    }
    .bar a { text-decoration: none; }
    .bar .spacer { flex: 1; }
    .muted { color: #6b7280; }
    .canvas { flex: 1; min-height: 0; }
    .status { padding: 1rem; font: 14px system-ui, sans-serif; }
  `],
})
export class BoardPageComponent {
  protected store = inject(BoardStore)

  // Bound from the :boardId route param via withComponentInputBinding().
  boardId = input.required<string>()

  constructor() {
    effect(() => {
      const id = this.boardId()
      if (id) void this.store.load(id)
    })
  }
}
