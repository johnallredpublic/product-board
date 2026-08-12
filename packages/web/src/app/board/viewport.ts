/**
 * The viewport transform. Everything in a pan-and-zoom canvas reduces to this.
 *
 * Placements are stored in WORLD coordinates and never change when you pan or
 * zoom — only the viewport changes. Keeping world and screen space strictly
 * separate is what makes dragging correct at every zoom level; mixing them is
 * THE canvas bug.
 */
export interface Viewport {
  x: number
  y: number
  scale: number
}

export function worldToScreen(wx: number, wy: number, vp: Viewport) {
  return { x: wx * vp.scale + vp.x, y: wy * vp.scale + vp.y }
}

export function screenToWorld(sx: number, sy: number, vp: Viewport) {
  return { x: (sx - vp.x) / vp.scale, y: (sy - vp.y) / vp.scale }
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}
