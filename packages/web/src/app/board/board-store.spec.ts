import { TestBed } from '@angular/core/testing'
import type { BoardView } from '@assortment/shared'
import { BoardStore } from './board-store'
import { ApiService } from '../core/api.service'

const view: BoardView = {
  board: { id: 'b', name: 'B', season: 'FA26', createdAt: '2026-01-01T00:00:00.000Z' },
  placements: [
    { id: 'p1', productId: 'prod1', x: 100, y: 120, w: 140, h: 170, z: 0, version: 0 },
    { id: 'p2', productId: 'prod2', x: 260, y: 120, w: 140, h: 170, z: 1, version: 0 },
  ],
  products: [
    { id: 'prod1', style: 'S1', name: 'Runner', colorway: 'Black', priceCents: 100, season: 'FA26', asset: null },
    { id: 'prod2', style: 'S2', name: 'Trainer', colorway: 'Black', priceCents: 100, season: 'FA26', asset: null },
  ],
}

describe('BoardStore', () => {
  let store: BoardStore

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [BoardStore, { provide: ApiService, useValue: { getBoard: async () => view } }],
    })
    store = TestBed.inject(BoardStore)
    await store.load('b')
  })

  it('joins placements with their products in renderables', () => {
    const r = store.renderables()
    expect(r.length).toBe(2)
    expect(r[0].product?.name).toBe('Runner')
    expect(r[1].product?.name).toBe('Trainer')
  })

  it('moves only the selected placements', () => {
    store.moveBy(new Set(['p1']), 10, 5)
    const [p1, p2] = store.placements()
    expect(p1.x).toBe(110)
    expect(p1.y).toBe(125)
    expect(p2.x).toBe(260) // untouched
  })

  it('tracks selection count', () => {
    store.select(new Set(['p1', 'p2']))
    expect(store.selectedCount()).toBe(2)
  })

  it('bumps versions only for the given ids', () => {
    store.bumpVersions(['p1'])
    const byId = new Map(store.placements().map((p) => [p.id, p]))
    expect(byId.get('p1')?.version).toBe(1)
    expect(byId.get('p2')?.version).toBe(0)
  })
})
