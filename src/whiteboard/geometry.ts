import {
  BOARD_GRID_SIZE,
  clampZoom,
  isVectorShape,
  vectorEndpoints,
  type BoardElement,
  type BoardPoint,
  type BoardRect,
  type BoardSurface,
  type BoardViewport,
} from "./boardTypes";

/** The single source of truth for the board's world <-> screen mapping.
 *
 * `viewport.x`/`viewport.y` are the world coordinate sitting at the canvas's top-left corner and
 * `viewport.zoom` is the scale factor, so:
 *
 *     screen = (world - viewport.xy) * zoom
 *     world  = screen / zoom + viewport.xy
 *
 * Everything on the board is rendered inside a single `transform: translate(...) scale(zoom)`
 * layer built from exactly this pair of functions (see WhiteboardView's `worldTransform`), which
 * is what makes zooming free: no element's stored geometry ever changes, and no per-element
 * re-layout happens on pan/zoom - the browser just recomposites one transformed layer.
 *
 * Screen coordinates here are always *canvas-relative* (i.e. already have the canvas element's
 * bounding rect subtracted), never raw clientX/clientY - see `screenPointFromEvent`. */
export function worldToScreen(world: BoardPoint, viewport: BoardViewport): BoardPoint {
  return {
    x: (world.x - viewport.x) * viewport.zoom,
    y: (world.y - viewport.y) * viewport.zoom,
  };
}

export function screenToWorld(screen: BoardPoint, viewport: BoardViewport): BoardPoint {
  return {
    x: screen.x / viewport.zoom + viewport.x,
    y: screen.y / viewport.zoom + viewport.y,
  };
}

/** Canvas-relative screen point for a pointer/wheel event, given the canvas element. */
export function screenPointFromEvent(
  e: { clientX: number; clientY: number },
  canvas: HTMLElement,
): BoardPoint {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** Zooms toward `anchor` (a canvas-relative screen point, normally the cursor) rather than toward
 * the viewport's origin - the difference between "the thing under my cursor stays under my cursor"
 * and the board sliding out from under it. Derived by solving for the viewport offset that keeps
 * `screenToWorld(anchor)` invariant across the zoom change. */
export function zoomAt(viewport: BoardViewport, nextZoom: number, anchor: BoardPoint): BoardViewport {
  const zoom = clampZoom(nextZoom);
  const worldAnchor = screenToWorld(anchor, viewport);
  return {
    zoom,
    x: worldAnchor.x - anchor.x / zoom,
    y: worldAnchor.y - anchor.y / zoom,
  };
}

/** Viewport that fits `bounds` inside a `viewWidth` x `viewHeight` canvas with a little breathing
 * room, centered. Used by "Zoom to fit" and by the initial camera when a board is opened with
 * content but no saved viewport. */
export function fitViewport(
  bounds: BoardRect,
  viewWidth: number,
  viewHeight: number,
  padding = 80,
): BoardViewport {
  const usableW = Math.max(1, viewWidth - padding * 2);
  const usableH = Math.max(1, viewHeight - padding * 2);
  const zoom = clampZoom(Math.min(usableW / Math.max(1, bounds.w), usableH / Math.max(1, bounds.h), 1));
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  return {
    zoom,
    x: centerX - viewWidth / 2 / zoom,
    y: centerY - viewHeight / 2 / zoom,
  };
}

/** World rect currently visible in a `viewWidth` x `viewHeight` canvas - the culling window
 * WhiteboardView uses so a board with thousands of elements only mounts the on-screen ones. */
export function visibleWorldRect(
  viewport: BoardViewport,
  viewWidth: number,
  viewHeight: number,
): BoardRect {
  return {
    x: viewport.x,
    y: viewport.y,
    w: viewWidth / viewport.zoom,
    h: viewHeight / viewport.zoom,
  };
}

export function rectsIntersect(a: BoardRect, b: BoardRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectContainsPoint(rect: BoardRect, point: BoardPoint): boolean {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
  );
}

/** Normalizes a drag rectangle (which may have been dragged up and/or left, giving negative
 * width/height) into a positive-extent rect. */
export function normalizeRect(a: BoardPoint, b: BoardPoint): BoardRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Union bounding box of `elements`, or null when there are none. */
export function boundsOf(elements: readonly BoardElement[]): BoardRect | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Horizontal spacing between the isometric surface's vertical grid lines, in world px. */
export const ISO_COL = BOARD_GRID_SIZE / 2;

/** Vertical spacing between isometric lattice rows, in world px.
 *
 * Isometric paper is three line families - vertical, +30deg and -30deg. A 30deg line crossing one
 * column (ISO_COL wide) rises exactly ISO_COL * tan(30deg), so that *is* the row pitch. Deriving it
 * rather than hardcoding a number keeps the drawn grid (BoardBackground), the snapping lattice
 * (snapToSurface below), and the axis vectors ink snaps to (inkAssist.ts) all describing one grid
 * - the property that makes a snapped stroke land on a line the user can actually see. */
export const ISO_ROW_HEIGHT = ISO_COL * Math.tan(Math.PI / 6);

/** The grid step for a surface, in world pixels, as `{ x, y }` where odd rows are offset by `x / 2`
 * (see snapToSurface). Plain has no lattice at all.
 *
 * Isometric's `x` is *two* columns wide because its lattice is staggered: the two 30deg families
 * intersect a given vertical line only at rows matching that column's parity, so within one row the
 * usable columns are every other one. Halving that back for odd rows is what recovers the
 * triangular (rather than rectangular) lattice. */
export function gridStep(surface: BoardSurface): { x: number; y: number } | null {
  switch (surface) {
    case "graph":
      return { x: BOARD_GRID_SIZE, y: BOARD_GRID_SIZE };
    case "isometric":
      return { x: ISO_COL * 2, y: ISO_ROW_HEIGHT };
    case "plain":
      return null;
  }
}

/** Snaps a world point onto the surface's lattice. Returns `point` unchanged on a plain surface,
 * so callers never need to branch on surface themselves. */
export function snapToSurface(point: BoardPoint, surface: BoardSurface): BoardPoint {
  const step = gridStep(surface);
  if (!step) return point;
  if (surface === "isometric") {
    // Isometric rows are staggered: odd rows sit half a horizontal pitch to the right, which is
    // what turns a plain rectangular lattice into a triangular one. Snap the row first, then
    // offset the column lattice for that row's parity before snapping x.
    const row = Math.round(point.y / step.y);
    const offset = (row % 2 === 0 ? 0 : step.x / 2);
    return {
      x: Math.round((point.x - offset) / step.x) * step.x + offset,
      y: row * step.y,
    };
  }
  return {
    x: Math.round(point.x / step.x) * step.x,
    y: Math.round(point.y / step.y) * step.y,
  };
}

/** Snaps a rect's top-left corner to the lattice while preserving its size - used when dragging or
 * placing an element with snapping enabled. */
export function snapRect(rect: BoardRect, surface: BoardSurface): BoardRect {
  const origin = snapToSurface({ x: rect.x, y: rect.y }, surface);
  return { ...rect, x: origin.x, y: origin.y };
}

/** Distance from `p` to segment `a`-`b`. Shared by ink hit-testing (eraser, click-to-select on a
 * stroke) and by inkAssist's straightness test. */
export function distanceToSegment(p: BoardPoint, a: BoardPoint, b: BoardPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a world point is close enough to an element to count as clicking "on" it.
 *
 * Ink gets true per-segment hit-testing rather than bounding-box hit-testing: a long diagonal
 * stroke's box covers a huge empty area, and treating that as clickable would make it impossible
 * to select anything drawn "inside" the diagonal. Every other element is a real filled box, so its
 * bounds are the right target. */
export function hitTestElement(el: BoardElement, point: BoardPoint, tolerance: number): boolean {
  if (el.kind === "ink") {
    const pad = tolerance + el.width / 2;
    if (!rectContainsPoint({ x: el.x - pad, y: el.y - pad, w: el.w + pad * 2, h: el.h + pad * 2 }, point)) {
      return false;
    }
    const local = { x: point.x - el.x, y: point.y - el.y };
    const pts = el.points;
    if (pts.length === 1) return Math.hypot(local.x - pts[0].x, local.y - pts[0].y) <= pad;
    for (let i = 0; i < pts.length - 1; i++) {
      if (distanceToSegment(local, pts[i], pts[i + 1]) <= pad) return true;
    }
    return false;
  }
  if (el.kind === "shape" && isVectorShape(el.shape)) {
    // Same reasoning as ink: a diagonal line's bounding box is mostly empty space.
    const pad = tolerance + el.strokeWidth / 2;
    const { a, b } = vectorEndpoints(el);
    return distanceToSegment(point, a, b) <= pad;
  }
  return rectContainsPoint(
    { x: el.x - tolerance, y: el.y - tolerance, w: el.w + tolerance * 2, h: el.h + tolerance * 2 },
    point,
  );
}

/** The topmost (last-painted) element at `point`, or null. Elements are stored back-to-front, so
 * this walks backwards - the same order the user sees them stacked. */
export function topmostAt(
  elements: readonly BoardElement[],
  point: BoardPoint,
  tolerance: number,
): BoardElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.locked) continue;
    if (hitTestElement(el, point, tolerance)) return el;
  }
  return null;
}
