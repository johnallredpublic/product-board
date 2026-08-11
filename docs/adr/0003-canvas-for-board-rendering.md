# ADR 0003: Canvas 2D for board rendering

## Status

Accepted (2026-08-11)

## Context

The board is an infinite pan-and-zoom surface displaying product tiles. Each
tile is an image with a label and a selection state. Users pan, zoom, marquee
select, and drag multiple items at once.

Expected scale is several hundred tiles per board, with a target of remaining
smooth at a few thousand.

There are four plausible approaches:

**DOM elements.** One absolutely positioned element per tile, moved with CSS
transforms. Free accessibility, free text selection, free hit testing, and
styling by CSS.

**SVG.** A middle ground: a retained scene graph with DOM nodes, so events and
accessibility work, but with vector rendering.

**Canvas 2D.** One element, an imperative draw loop, full control over what gets
drawn and when.

**WebGL.** GPU-accelerated, far higher ceiling, substantially more complexity.

The deciding constraint is that pan and zoom transform every item
simultaneously. With DOM or SVG, that means the browser recalculating layout and
compositing for every node on every frame of a drag. At a few hundred nodes this
degrades; at a few thousand it is unusable. Canvas replaces N nodes with one
element and a loop we control, which lets us cull offscreen items and skip
detail at low zoom.

WebGL would raise the ceiling further but is not warranted at the target scale
and would substantially increase the cost of text rendering and hit testing.

## Decision

Canvas 2D, with:

- A viewport transform maintaining strict separation between world coordinates
  (where items live) and screen coordinates (where pixels are drawn)
- A dirty-flag render loop coalesced through `requestAnimationFrame`, so an idle
  board consumes no CPU
- Frustum culling: items outside the visible world rectangle are skipped
- Level of detail: smaller image derivatives below a zoom threshold, and labels
  omitted when too small to read
- A parallel accessible DOM layer, since canvas content is invisible to assistive
  technology

## Consequences

- Performance scales with what is *visible* rather than with what exists.
- Full control over rendering, so level-of-detail and culling optimizations are
  available.
- **Accessibility must be rebuilt.** Canvas is opaque to screen readers. This
  requires a parallel `role="list"` DOM structure, keyboard navigation, and focus
  management. This is real work and is the largest single cost of this decision.
- **Hit testing must be rebuilt.** The browser cannot tell us what was clicked.
  A linear reverse scan is adequate to a few thousand items; beyond that a
  spatial index (quadtree or R-tree) would be needed.
- No text selection, no native drag-and-drop, no CSS styling, no browser find.
- Debugging is harder: there is no inspectable element per tile.
- Testing is harder. Mitigated by extracting geometry and interaction state into
  pure functions that can be unit tested without a canvas.
- If per-item interactivity grows substantially (inline editing, rich hover
  cards), a hybrid approach (canvas for the bulk, DOM overlays for the active
  item) becomes worth revisiting.
