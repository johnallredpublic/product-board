import { Component, OnInit, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { DatePipe } from '@angular/common'
import type { Board } from '@assortment/shared'
import { ApiService } from '../core/api.service'

/** Lists boards in the (single, default) workspace and creates new ones. */
@Component({
  selector: 'app-board-list',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    <h1>Boards</h1>

    <form (submit)="create($event)">
      <input [(ngModel)]="name" name="name" placeholder="Board name" required />
      <select [(ngModel)]="season" name="season">
        @for (s of seasons; track s) {
          <option [value]="s">{{ s }}</option>
        }
      </select>
      <button type="submit">Create board</button>
    </form>

    @if (boards().length === 0) {
      <p>No boards yet — create one above.</p>
    } @else {
      <ul>
        @for (b of boards(); track b.id) {
          <li>
            <a [routerLink]="['/boards', b.id]">{{ b.name }}</a>
            <small> — {{ b.season }} · {{ b.createdAt | date: 'short' }}</small>
          </li>
        }
      </ul>
    }
  `,
})
export class BoardListComponent implements OnInit {
  private api = inject(ApiService)

  protected boards = signal<Board[]>([])
  protected name = ''
  protected season: Board['season'] = 'SP26'
  protected readonly seasons: Board['season'][] = ['SP26', 'FA26', 'SP27']

  ngOnInit() {
    void this.refresh()
  }

  private async refresh() {
    this.boards.set(await this.api.listBoards())
  }

  protected async create(e: Event) {
    e.preventDefault()
    if (!this.name.trim()) return
    await this.api.createBoard({ name: this.name, season: this.season })
    this.name = ''
    await this.refresh()
  }
}
