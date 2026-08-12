import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { DecimalPipe } from '@angular/common'
import type { CatalogItem, Product } from '@assortment/shared'
import { ApiService } from '../core/api.service'
import { BoardStore } from './board-store'

/**
 * The catalog side panel: search a tenant's products and click one to drop it onto
 * the board. Backed by GET /api/catalog (OpenSearch, or the DynamoDB fallback when
 * search is off). Adding persists via the store, which assigns the real placement id.
 */
@Component({
  selector: 'app-catalog-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DecimalPipe],
  template: `
    <div class="panel">
      <input
        class="search"
        type="search"
        placeholder="Search catalog…"
        [(ngModel)]="query"
        (input)="load()"
        aria-label="Search catalog" />

      @if (loading()) {
        <p class="muted">Searching…</p>
      } @else if (items().length === 0) {
        <p class="muted">No products.</p>
      } @else {
        <ul class="list" role="list">
          @for (it of items(); track it.id) {
            <li>
              <button type="button" class="item" (click)="add(it)" [disabled]="adding() === it.id">
                <span class="name">{{ it.name }}</span>
                <span class="meta">{{ it.colorway }} · {{ '$' }}{{ it.priceCents / 100 | number: '1.2-2' }}</span>
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .panel { display: flex; flex-direction: column; gap: .5rem; height: 100%; padding: .6rem; box-sizing: border-box; }
    .search { padding: .4rem .5rem; font: 13px system-ui, sans-serif; border: 1px solid #d1d5db; border-radius: 6px; }
    .list { list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex; flex-direction: column; gap: .3rem; }
    .item { display: flex; flex-direction: column; align-items: flex-start; gap: .1rem;
      width: 100%; text-align: left; padding: .4rem .5rem; border: 1px solid #e5e7eb;
      border-radius: 6px; background: #fff; cursor: pointer; font: 13px system-ui, sans-serif; }
    .item:hover:not(:disabled) { border-color: #2563eb; }
    .item:disabled { opacity: .5; cursor: default; }
    .name { font-weight: 600; }
    .meta, .muted { color: #6b7280; font: 12px system-ui, sans-serif; }
  `],
})
export class CatalogPanelComponent {
  private api = inject(ApiService)
  private store = inject(BoardStore)

  protected query = ''
  protected items = signal<CatalogItem[]>([])
  protected loading = signal(false)
  protected adding = signal<string | null>(null)

  constructor() {
    void this.load()
  }

  async load() {
    this.loading.set(true)
    try {
      this.items.set(await this.api.searchCatalog({ q: this.query.trim() || undefined }))
    } finally {
      this.loading.set(false)
    }
  }

  async add(item: CatalogItem) {
    this.adding.set(item.id)
    try {
      // CatalogItem carries no image; the board renders a placeholder until one lands.
      const product: Product = { ...item, asset: null }
      // Stagger new tiles so they don't stack exactly on top of each other.
      const n = this.store.placements().length
      await this.store.addProduct(product, 120 + (n % 6) * 40, 120 + Math.floor(n / 6) * 40)
    } finally {
      this.adding.set(null)
    }
  }
}
