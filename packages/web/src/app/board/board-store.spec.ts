import { TestBed } from '@angular/core/testing'
import type { BoardView, Placement, Product } from '@assortment/shared'
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

  it('applies a remote add (with its product) and is idempotent', () => {
    const p: Placement = { id: 'p3', productId: 'prod3', x: 0, y: 0, w: 140, h: 170, z: 2, version: 0 }
    const prod: Product = { id: 'prod3', style: 'S3', name: 'Sandal', colorway: 'Tan', priceCents: 100, season: 'FA26', asset: null }
    store.applyRemoteAdd(p, prod)
    expect(store.placements().length).toBe(3)
    expect(store.renderables().find(r => r.id === 'p3')?.product?.name).toBe('Sandal')
    store.applyRemoteAdd(p, prod) // duplicate delivery must not double-add
    expect(store.placements().length).toBe(3)
  })

  it('applies a remote remove', () => {
    store.applyRemoteRemove('p1')
    expect(store.placements().map(p => p.id)).toEqual(['p2'])
  })
})

describe('BoardStore add/remove via API', () => {
  it('addProduct persists then inserts the returned placement', async () => {
    const created: Placement = { id: 'new1', productId: 'prodX', x: 120, y: 120, w: 140, h: 170, z: 5, version: 0 }
    const api = { getBoard: async () => view, addPlacement: async () => created }
    TestBed.configureTestingModule({ providers: [BoardStore, { provide: ApiService, useValue: api }] })
    const store = TestBed.inject(BoardStore)
    await store.load('b')

    const prod: Product = { id: 'prodX', style: 'SX', name: 'Boot', colorway: 'Brown', priceCents: 200, season: 'FA26', asset: null }
    await store.addProduct(prod, 120, 120)
    expect(store.placements().map(p => p.id)).toContain('new1')
    expect(store.renderables().find(r => r.id === 'new1')?.product?.name).toBe('Boot')
  })

  it('removeSelected deletes each selected id and clears the selection', async () => {
    const removed: string[] = []
    const api = { getBoard: async () => view, removePlacement: async (_b: string, id: string) => { removed.push(id) } }
    TestBed.configureTestingModule({ providers: [BoardStore, { provide: ApiService, useValue: api }] })
    const store = TestBed.inject(BoardStore)
    await store.load('b')

    store.select(new Set(['p1']))
    await store.removeSelected()
    expect(removed).toEqual(['p1'])
    expect(store.placements().map(p => p.id)).toEqual(['p2'])
    expect(store.selectedCount()).toBe(0)
  })
})
