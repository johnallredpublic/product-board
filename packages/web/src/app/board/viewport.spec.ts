import { worldToScreen, screenToWorld, clamp } from './viewport'

describe('viewport transform', () => {
  it('round-trips world -> screen -> world', () => {
    const vp = { x: 137, y: -42, scale: 2.5 }
    const s = worldToScreen(100, 200, vp)
    const w = screenToWorld(s.x, s.y, vp)
    expect(w.x).toBeCloseTo(100)
    expect(w.y).toBeCloseTo(200)
  })

  it('maps the viewport origin to its screen offset', () => {
    const vp = { x: 40, y: 40, scale: 1 }
    expect(worldToScreen(0, 0, vp)).toEqual({ x: 40, y: 40 })
  })

  it('scales distances by the zoom factor', () => {
    const vp = { x: 0, y: 0, scale: 2 }
    expect(worldToScreen(10, 10, vp)).toEqual({ x: 20, y: 20 })
  })

  it('clamps to the given range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
})
