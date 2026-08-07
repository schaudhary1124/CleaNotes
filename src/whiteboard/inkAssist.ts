import { BOARD_GRID_SIZE, type BoardPoint, type BoardSurface } from "./boardTypes";
import { ISO_COL, ISO_ROW_HEIGHT, distanceToSegment, snapToSurface } from "./geometry";

/** Draw-mode "smart assist": the post-processing pass a freehand stroke runs through the moment
 * the pointer lifts, before it becomes an InkElement.
 *
 * The rule the whole module follows is *never silently reshape something the user drew
 * deliberately*. Every correction below is gated on the raw stroke already being within a tight
 * tolerance of the ideal form - a wobbly-but-clearly-intended-straight line gets cleaned up, a
 * genuine curve is left completely untouched. That's why the thresholds are strict (0.985
 * straightness, ~7deg of angular slack): a looser assist that "helps" on ambiguous input is worse
 * than no assist, because the user can't predict it.
 *
 * Assists are surface-driven (see BoardSurface):
 *   plain     - nothing at all; pure freehand.
 *   graph     - straight strokes snap to the horizontal/vertical/45deg axes and their endpoints
 *               land on grid intersections; closed strokes become clean rectangles/ellipses.
 *   isometric - straight strokes snap to the three isometric axes (+/-30deg and vertical), which is
 *               what makes drawing on 3D triangle paper actually produce coherent boxes; endpoints
 *               land on the staggered triangular lattice.
 */

export interface AssistResult {
  /** The stroke to commit, in the same coordinate space as the input. */
  points: BoardPoint[];
  /** Set when the assist recognized a closed shape and the caller should commit a ShapeElement
   * instead of ink - see WhiteboardView's stroke commit. */
  shape?: { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number };
}

/** Direction vectors (unit) a straight stroke may snap to, per surface.
 *
 * Graph gets 8 directions (the 4 axes plus the 4 diagonals) because a 45deg diagonal across a
 * square cell is itself a lattice-aligned line. Isometric gets 6: the two 30deg axes that define
 * the paper plus vertical, which together are the only directions along which the triangular
 * lattice has continuous lines. Note that isometric deliberately has *no* horizontal axis - a
 * horizontal line on isometric paper crosses the grid rather than following it, and forcing
 * near-horizontal strokes onto 30deg is exactly the assist that makes drawn boxes look right. */
function axesFor(surface: BoardSurface): BoardPoint[] | null {
  if (surface === "graph") {
    const d = Math.SQRT1_2;
    return [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: d, y: d },
      { x: d, y: -d },
    ];
  }
  if (surface === "isometric") {
    // The isometric axis rise/run comes from the same lattice constants the drawn grid and
    // snapToSurface use, so a snapped line lies exactly along a printed grid line rather than
    // drifting off it over a long span.
    const run = ISO_COL;
    const rise = ISO_ROW_HEIGHT;
    const len = Math.hypot(run, rise);
    return [
      { x: run / len, y: rise / len },
      { x: run / len, y: -rise / len },
      { x: 0, y: 1 },
    ];
  }
  return null;
}

/** How close (in radians) a stroke's direction must already be to an axis before it gets snapped
 * onto it. ~7deg: wide enough to absorb normal hand wobble, narrow enough that a line drawn at a
 * deliberate intermediate angle is left alone. */
const AXIS_TOLERANCE = (7 * Math.PI) / 180;

/** Ratio of straight-line chord length to total path length above which a stroke counts as
 * "meant to be straight". 0.985 is roughly a 1.5% detour budget over the whole stroke. */
const STRAIGHTNESS_THRESHOLD = 0.985;

/** Strokes shorter than this (world px) are treated as dots/taps and left entirely alone - the
 * straightness ratio is meaningless at that scale and would snap every tick mark to an axis. */
const MIN_ASSIST_LENGTH = 18;

/** How close a stroke's start and end must be (relative to its own size) to count as closed. */
const CLOSE_RATIO = 0.22;

function pathLength(points: readonly BoardPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

function bbox(points: readonly BoardPoint[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Projects `end` onto the axis through `start` that its direction is closest to, but only if that
 * axis is already within AXIS_TOLERANCE. Returns null when no axis is close enough, which is the
 * signal to leave the stroke as freehand. */
function snapDirection(start: BoardPoint, end: BoardPoint, axes: BoardPoint[]): BoardPoint | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;

  let best: { point: BoardPoint; delta: number } | null = null;
  for (const axis of axes) {
    // Both orientations of each axis: an axis is a line, not a ray, so a stroke drawn right-to-left
    // along the horizontal is just as aligned as one drawn left-to-right.
    for (const sign of [1, -1]) {
      const ax = axis.x * sign;
      const ay = axis.y * sign;
      const cos = (dx * ax + dy * ay) / len;
      if (cos <= 0) continue;
      const delta = Math.acos(Math.min(1, cos));
      if (delta > AXIS_TOLERANCE) continue;
      if (best && delta >= best.delta) continue;
      // Project the raw endpoint onto the axis rather than reusing `len`: projection preserves how
      // far along the axis the user actually reached, so a slightly-off 100px stroke stays ~100px
      // rather than growing to its own (longer) hypotenuse.
      const projected = dx * ax + dy * ay;
      best = { point: { x: start.x + ax * projected, y: start.y + ay * projected }, delta };
    }
  }
  return best?.point ?? null;
}

/** Whether every point of a closed stroke hugs its own bounding box - i.e. it's a rectangle rather
 * than a circle or a blob. Tested by distance to the nearest box edge, tolerant to `tolerance`. */
function hugsBox(points: readonly BoardPoint[], box: ReturnType<typeof bbox>, tolerance: number): boolean {
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  for (const p of points) {
    let nearest = Infinity;
    for (let i = 0; i < 4; i++) {
      nearest = Math.min(nearest, distanceToSegment(p, corners[i], corners[(i + 1) % 4]));
    }
    if (nearest > tolerance) return false;
  }
  return true;
}

/** Whether every point of a closed stroke sits on the ellipse inscribed in its bounding box. */
function hugsEllipse(points: readonly BoardPoint[], box: ReturnType<typeof bbox>, tolerance: number): boolean {
  const rx = box.w / 2;
  const ry = box.h / 2;
  if (rx < 1 || ry < 1) return false;
  const cx = box.minX + rx;
  const cy = box.minY + ry;
  for (const p of points) {
    const nx = (p.x - cx) / rx;
    const ny = (p.y - cy) / ry;
    // Radial deviation from the unit circle, scaled back into world px by the smaller radius so
    // the tolerance means roughly the same thing on squashed ellipses as on round ones.
    if (Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry) > tolerance) return false;
  }
  return true;
}

/**
 * Runs the assist pass over a finished stroke.
 *
 * `points` are world-space and are returned world-space; the caller re-bases them onto the
 * element's own origin afterwards (see boardOps.ts's `inkFromPoints`).
 */
export function assistStroke(points: BoardPoint[], surface: BoardSurface): AssistResult {
  const axes = axesFor(surface);
  if (!axes || points.length < 2) return { points };

  const start = points[0];
  const end = points[points.length - 1];
  const total = pathLength(points);
  if (total < MIN_ASSIST_LENGTH) return { points };

  const box = bbox(points);
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const size = Math.max(box.w, box.h);

  // Closed-shape recognition comes first: a closed stroke has a near-zero chord, which would read
  // as "not straight" below and never reach here otherwise.
  if (size >= BOARD_GRID_SIZE && gap < size * CLOSE_RATIO) {
    const tolerance = Math.max(6, size * 0.12);
    const snappedTopLeft = snapToSurface({ x: box.minX, y: box.minY }, surface);
    const snappedBottomRight = snapToSurface({ x: box.maxX, y: box.maxY }, surface);
    const rect = {
      x: snappedTopLeft.x,
      y: snappedTopLeft.y,
      w: Math.max(BOARD_GRID_SIZE, snappedBottomRight.x - snappedTopLeft.x),
      h: Math.max(BOARD_GRID_SIZE, snappedBottomRight.y - snappedTopLeft.y),
    };
    // Ellipse is tested first: a circle drawn inside a square bounding box can incidentally pass a
    // loose box-hug test near its four extremes, but a real rectangle never passes the ellipse
    // test, so checking ellipse-then-box is the ordering that can't misclassify either one.
    if (hugsEllipse(points, box, tolerance)) return { points, shape: { kind: "ellipse", ...rect } };
    if (hugsBox(points, box, tolerance)) return { points, shape: { kind: "rect", ...rect } };
    return { points };
  }

  if (gap / total < STRAIGHTNESS_THRESHOLD) return { points };

  const snappedEnd = snapDirection(start, end, axes);
  if (!snappedEnd) return { points };

  // Both endpoints land on the lattice so consecutive snapped strokes actually meet at shared
  // vertices - the property that makes drawing a closed isometric box out of three separate
  // strokes produce a box with no gaps at the corners.
  const a = snapToSurface(start, surface);
  const b = snapToSurface(snappedEnd, surface);
  // Lattice snapping can nudge both ends onto the same point for a very short stroke; keep the
  // un-snapped direction result in that case rather than emitting a zero-length line.
  if (a.x === b.x && a.y === b.y) return { points: [start, snappedEnd] };
  return { points: [a, b] };
}
