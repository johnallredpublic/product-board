import { Component, OnDestroy, HostListener, inject, input, effect } from '@angular/core'
import { RouterLink } from '@angular/router'
import { BoardStore } from './board-store'
import { BoardCanvasComponent } from './board-canvas.component'
import { CatalogPanelComponent } from './catalog-panel.component'
import { RealtimeService } from '../core/realtime.service'

@Component({
  selector: 'app-board-page',
  imports: [RouterLink, BoardCanvasComponent, CatalogPanelComponent],
  template: `
    @if (store.loading()) {
      <p class="status">Loading…</p>
    } @else if (store.board(); as board) {
      <header class="bar">
        <a routerLink="/boards">← Boards</a>
        <strong>{{ board.name }}</strong>
        <span class="muted">({{ board.season }})</span>
        <span class="spacer"></span>
        @if (store.selectedCount() > 0) {
          <button type="button" class="remove" (click)="removeSelected()">
            Remove {{ store.selectedCount() }}
          </button>
        }
        <span class="muted">
          {{ store.renderables().length }} items · {{ store.selectedCount() }} selected
        </span>
      </header>
      <div class="body">
        <app-board-canvas class="canvas" />
        <app-catalog-panel class="catalog" />
      </div>
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
    .remove {
      font: 13px system-ui, sans-serif; padding: .25rem .6rem; cursor: pointer;
      border: 1px solid #dc2626; color: #dc2626; background: #fff; border-radius: 6px;
    }
    .remove:hover { background: #fef2f2; }
    .body { flex: 1; min-height: 0; display: flex; }
    .canvas { flex: 1; min-height: 0; min-width: 0; }
    .catalog { width: 260px; border-left: 1px solid #e5e7eb; }
    .status { padding: 1rem; font: 14px system-ui, sans-serif; }
  `],
})
export class BoardPageComponent implements OnDestroy {
  protected store = inject(BoardStore)
  private realtime = inject(RealtimeService)

  // Bound from the :boardId route param via withComponentInputBinding().
  boardId = input.required<string>()

  constructor() {
    effect(() => {
      const id = this.boardId()
      if (id) {
        void this.store.load(id)
        this.realtime.connect(id) // live updates from other editors
      }
    })
  }

  // Delete/Backspace removes the selection — unless the user is typing in a field
  // (e.g. the catalog search box), where Backspace must edit text.
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    if (this.store.selectedCount() === 0) return
    e.preventDefault()
    void this.store.removeSelected()
  }

  protected removeSelected() {
    void this.store.removeSelected()
  }

  ngOnDestroy() {
    this.realtime.disconnect()
  }
}
