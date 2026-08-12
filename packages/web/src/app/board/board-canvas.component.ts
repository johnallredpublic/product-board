import {
  Component, ElementRef, viewChild, inject, effect,
  AfterViewInit, OnDestroy, ChangeDetectionStrategy, signal,
} from '@angular/core'
import { DecimalPipe } from '@angular/common'
import { BoardStore, type Renderable } from './board-store'
import { type Viewport, worldToScreen, screenToWorld, clamp } from './viewport'
import { roundRect, clip } from './render-utils'

type Drag =
  | { mode: 'pan'; sx: number; sy: number; vp: Viewport }
  | { mode: 'move'; last: { x: number; y: number } }
  | { mode: 'marquee'; start: { x: number; y: number }; cur: { x: number; y: number } }

@Component({
  selector: 'app-board-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <div class="wrap">
      <canvas #canvas
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="onPointerUp($event)"
        (wheel)="onWheel($event)"></canvas>

      <!-- Parallel accessible layer: canvas is opaque to screen readers, so we
           mirror the items as a focusable list with keyboard movement. -->
      <div class="sr-only" role="list" aria-label="Board items">
        @for (r of store.renderables(); track r.id) {
          <div role="listitem" tabindex="0"
               [attr.aria-selected]="store.selection().has(r.id)"
               (keydown)="onItemKey($event, r)">
            {{ r.product?.name ?? 'Item' }} at
            {{ r.x | number: '1.0-0' }}, {{ r.y | number: '1.0-0' }}
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .wrap { position: relative; width: 100%; height: 100%; }
    canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: default; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `],
})
export class BoardCanvasComponent implements AfterViewInit, OnDestroy {
  protected store = inject(BoardStore)
  private canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas')
  private ctx!: CanvasRenderingContext2D
  private ro?: ResizeObserver

  private vp = signal<Viewport>({ x: 40, y: 40, scale: 1 })
  private renderQueued = false
  private drag: Drag | null = null

  private imageCache = new Map<string, HTMLImageElement>()
  private inFlight = new Set<string>()

  constructor() {
    // Reading signals inside an effect subscribes to them, so any data or
    // selection change schedules a repaint automatically.
    effect(() => {
      this.store.renderables()
      this.store.selection()
      this.vp()
      this.requestRender()
    })
  }

  ngAfterViewInit() {
    const canvas = this.canvasRef().nativeElement
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
  }

  ngOnDestroy() {
    this.ro?.disconnect()
  }

  // ─── Sizing: a canvas has a CSS size and a backing-store size. Scale by DPR or
  //     everything is blurry on a retina display. ────────────────────────────
  private resize() {
    const canvas = this.canvasRef().nativeElement
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // draw in CSS pixels
    this.requestRender()
  }

  // ─── Render loop: dirty-flag, coalesced to one frame. Never a continuous rAF
  //     loop — an idle board must use zero CPU. ─────────────────────────────
  private requestRender() {
    if (this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.draw()
    })
  }

  private draw() {
    const ctx = this.ctx
    if (!ctx) return
    const canvas = this.canvasRef().nativeElement
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    const vp = this.vp()

    ctx.save()
    ctx.fillStyle = '#f6f6f7'
    ctx.fillRect(0, 0, w, h)

    ctx.translate(vp.x, vp.y)
    ctx.scale(vp.scale, vp.scale)

    // Culling: convert screen corners to world space; skip anything outside.
    const tl = screenToWorld(0, 0, vp)
    const br = screenToWorld(w, h, vp)
    const sel = this.store.selection()

    let drawn = 0
    for (const r of this.store.renderables()) {
      if (r.x + r.w < tl.x || r.x > br.x) continue
      if (r.y + r.h < tl.y || r.y > br.y) continue
      this.drawTile(ctx, r, vp.scale, sel.has(r.id))
      drawn++
    }

    ctx.restore()

    // Marquee rectangle, drawn in screen space after restore.
    if (this.drag?.mode === 'marquee') {
      const a = worldToScreen(this.drag.start.x, this.drag.start.y, vp)
      const b = worldToScreen(this.drag.cur.x, this.drag.cur.y, vp)
      ctx.save()
      ctx.strokeStyle = '#2563eb'
      ctx.fillStyle = 'rgba(37,99,235,0.08)'
      ctx.lineWidth = 1
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
      ctx.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      ctx.strokeRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      ctx.restore()
    }

    this.drawHud(ctx, w, h, drawn)
  }

  private drawHud(ctx: CanvasRenderingContext2D, w: number, _h: number, drawn: number) {
    const vp = this.vp()
    ctx.save()
    ctx.fillStyle = 'rgba(17,17,17,0.6)'
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(`${drawn} drawn · ${Math.round(vp.scale * 100)}%`, w - 8, 8)
    ctx.restore()
  }

  // ─── A tile. Every `/ scale` keeps strokes, fonts, and shadows a constant
  //     SCREEN size at any zoom (they're specified in world units). ─────────
  private drawTile(ctx: CanvasRenderingContext2D, r: Renderable, scale: number, selected: boolean) {
    ctx.save()

    ctx.fillStyle = '#fff'
    ctx.shadowColor = 'rgba(0,0,0,0.12)'
    ctx.shadowBlur = 8 / scale
    ctx.shadowOffsetY = 2 / scale
    roundRect(ctx, r.x, r.y, r.w, r.h, 6 / scale)
    ctx.fill()
    ctx.shadowColor = 'transparent'

    // Level of detail: 128px tiles at low zoom, 512px zoomed in (Phase 4).
    const asset = r.product?.asset
    const url = asset ? (scale < 0.5 ? asset.thumb128 : asset.thumb512) : null
    const img = url ? this.getImage(url) : null

    if (img) {
      ctx.drawImage(img, r.x + 4, r.y + 4, r.w - 8, r.h - 28)
    } else {
      ctx.fillStyle = '#e5e7eb'
      ctx.fillRect(r.x + 4, r.y + 4, r.w - 8, r.h - 28)
    }

    // Skip text entirely when it would be unreadable.
    if (scale > 0.35 && r.product) {
      ctx.fillStyle = '#111'
      ctx.font = `${11 / scale}px system-ui, sans-serif`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(clip(r.product.name, 24), r.x + 6, r.y + r.h - 22)
    }

    if (selected) {
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 2 / scale
      roundRect(ctx, r.x, r.y, r.w, r.h, 6 / scale)
      ctx.stroke()
    }

    ctx.restore()
  }

  private getImage(url: string): HTMLImageElement | null {
    const hit = this.imageCache.get(url)
    if (hit) return hit
    if (this.inFlight.has(url)) return null

    this.inFlight.add(url)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      this.imageCache.set(url, img)
      this.inFlight.delete(url)
      this.requestRender()
    }
    img.onerror = () => this.inFlight.delete(url)
    img.src = url
    return null
  }

  // ─── Zoom to cursor: find the world point under the cursor, change scale, then
  //     solve for the pan that keeps that same world point under the cursor. ──
  onWheel(e: WheelEvent) {
    e.preventDefault()
    const vp = this.vp()
    const rect = this.canvasRef().nativeElement.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    const before = screenToWorld(sx, sy, vp)
    const scale = clamp(vp.scale * Math.exp(-e.deltaY * 0.001), 0.05, 8)
    this.vp.set({ scale, x: sx - before.x * scale, y: sy - before.y * scale })
  }

  // ─── Pointer interaction. Pan deltas are SCREEN pixels; move deltas are WORLD
  //     units. Mixing these is the classic bug. ───────────────────────────────
  onPointerDown(e: PointerEvent) {
    this.canvasRef().nativeElement.setPointerCapture(e.pointerId)
    const world = this.toWorld(e)
    const hit = this.hitTest(world.x, world.y)

    if (e.button === 1 || e.altKey) {
      this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vp: this.vp() }
    } else if (hit) {
      if (!this.store.selection().has(hit.id)) {
        this.store.select(
          e.shiftKey ? new Set([...this.store.selection(), hit.id]) : new Set([hit.id]),
        )
      }
      this.drag = { mode: 'move', last: world }
    } else {
      this.drag = { mode: 'marquee', start: world, cur: world }
      if (!e.shiftKey) this.store.select(new Set())
    }
    this.requestRender()
  }

  onPointerMove(e: PointerEvent) {
    if (!this.drag) return

    if (this.drag.mode === 'pan') {
      this.vp.set({
        ...this.drag.vp,
        x: this.drag.vp.x + (e.clientX - this.drag.sx),
        y: this.drag.vp.y + (e.clientY - this.drag.sy),
      })
    } else if (this.drag.mode === 'move') {
      const world = this.toWorld(e)
      this.store.moveBy(this.store.selection(), world.x - this.drag.last.x, world.y - this.drag.last.y)
      this.drag.last = world
    } else {
      this.drag.cur = this.toWorld(e)
      this.store.select(this.itemsInRect(this.drag.start, this.drag.cur))
      this.requestRender()
    }
  }

  onPointerUp(_e: PointerEvent) {
    // Persistence (debounced save on release) is wired in Phase 7.
    this.drag = null
    this.requestRender()
  }

  // ─── Hit testing: iterate backwards so the topmost (last-drawn) tile wins. ──
  private hitTest(wx: number, wy: number): Renderable | null {
    const items = this.store.renderables()
    for (let i = items.length - 1; i >= 0; i--) {
      const r = items[i]!
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return r
    }
    return null
  }

  private itemsInRect(a: { x: number; y: number }, b: { x: number; y: number }): Set<string> {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
    const ids = new Set<string>()
    for (const r of this.store.renderables()) {
      if (r.x + r.w >= x0 && r.x <= x1 && r.y + r.h >= y0 && r.y <= y1) ids.add(r.id)
    }
    return ids
  }

  private toWorld(e: PointerEvent) {
    const rect = this.canvasRef().nativeElement.getBoundingClientRect()
    return screenToWorld(e.clientX - rect.left, e.clientY - rect.top, this.vp())
  }

  // ─── Keyboard movement for the accessible list items. ──────────────────────
  onItemKey(e: KeyboardEvent, r: Renderable) {
    const step = e.shiftKey ? 50 : 10
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    }
    const d = deltas[e.key]
    if (!d) return
    e.preventDefault()
    this.store.moveBy(new Set([r.id]), d[0], d[1])
    // Persistence is wired in Phase 7.
  }
}
