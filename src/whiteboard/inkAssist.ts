import { BOARD_GRID_SIZE, type BoardPoint, type BoardSurface } from "./boardTypes";
import { ISO_COL, ISO_ROW_HEIGHT, distanceToSegment, snapToSurface } from "./geometry";

/** Draw-mode "smart assist": the geometry that turns freehand ink into clean lines and shapes.
 *
 * The rule the whole module follows is *never silently reshape something the user drew
 * deliberately*. Straightening is therefore never inferred from the path's shape alone - it happens
 * only where the user asked for it, in one of two ways:
 *
 *   Following a printed line - the stroke starts on a line that is actually drawn on the paper (see
 *     GuideLine) and heads along it. Locking on is immediate, because starting on a line and then
 *     tracking it is not something that happens by accident.
 *   Holding still - the pointer parks for HOLD_STRAIGHTEN_MS part-way through a stroke that already
 *     closely resembles a line. The pause is the request.
 *
 * Both are *sticky*: once a stroke has become a line, the raw path stops being consulted at all and
 * only the pointer's current position decides what gets drawn. That stickiness is the entire point.
 * A per-sample straightness test - which is what this module used to do - falls apart the moment the
 * user draws back along their own line to shorten it: the doubled-back path stops scoring as
 * straight, and the line vanishes out from under a pointer that is still down.
 *
 * Nothing turns a line back into a scribble mid-stroke. Pulling clear of a followed line
 * (GUIDE_DETACH_PX) releases the *attachment* only - the line keeps its straightness and starts
 * following the pointer freely, which is what "I want this line to go somewhere else now" should
 * do. Going back to freehand takes lifting the pen.
 *
 * The release-time pass (assistStroke) is left with closed-shape recognition alone. That one can
 * stay automatic because a stroke whose two ends meet is unambiguous in a way a straight-ish one
 * never is.
 *
 * Assists are surface-driven (see BoardSurface):
 *   plain     - nothing at all; pure freehand. No printed lines to follow, no lattice to land on.
 *   graph     - lines lock to the printed horizontals and verticals; held lines snap to those plus
 *               the 45deg diagonals, with endpoints on grid intersections; closed strokes become
 *               clean rectangles/ellipses.
 *   isometric - lines lock to the three printed families (+/-30deg and vertical), which is what
 *               makes drawing on 3D triangle paper produce coherent boxes; endpoints land on the
 *               staggered triangular lattice. Note there is deliberately no horizontal axis - a
 *               horizontal line on isometric paper crosses the grid rather than following it.
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

/** `start`->`end` as a straight line: snapped onto the surface's axes and lattice when the angle is
 * already close to one, left at its own angle when it isn't.
 *
 * This is what the hold gesture produces, so it deliberately stays permissive about direction - the
 * user has asked for *a line*, not necessarily a grid-aligned one, and refusing to draw one at an
 * intermediate angle would make the gesture feel broken rather than principled. */
function straightenTo(start: BoardPoint, end: BoardPoint, surface: BoardSurface): BoardPoint[] {
  const axes = axesFor(surface);
  const snapped = axes ? snapDirection(start, end, axes) : null;
  if (!snapped) return [start, end];
  // Both endpoints land on the lattice so consecutive snapped strokes actually meet at shared
  // vertices - the property that makes drawing a closed isometric box out of three separate
  // strokes produce a box with no gaps at the corners.
  const a = snapToSurface(start, surface);
  const b = snapToSurface(snapped, surface);
  // Lattice snapping can nudge both ends onto the same point for a very short stroke; keep the
  // un-snapped direction result in that case rather than emitting a zero-length line.
  if (a.x === b.x && a.y === b.y) return [start, snapped];
  return [a, b];
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
 * Runs the release-time assist pass over a finished stroke - closed-shape recognition only.
 *
 * Straightening is *not* done here. A stroke only becomes a line while it is still being drawn, by
 * locking onto a printed guide or by the hold gesture (see LiveAssist), both of which the user can
 * see happen and back out of. Straightening a stroke the instant it is released instead makes the
 * result unpredictable in exactly the case it matters most: the user has already lifted, so there
 * is nothing left to do about it but undo.
 *
 * `points` are world-space and are returned world-space; the caller re-bases them onto the
 * element's own origin afterwards (see boardOps.ts's `inkFromPoints`).
 */
export function assistStroke(points: BoardPoint[], surface: BoardSurface): AssistResult {
  // axesFor doubles as the surface gate: a plain surface has no axes and gets no assists at all.
  if (!axesFor(surface) || points.length < 2) return { points };

  const start = points[0];
  const end = points[points.length - 1];
  if (pathLength(points) < MIN_ASSIST_LENGTH) return { points };

  const box = bbox(points);
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const size = Math.max(box.w, box.h);
  if (size < BOARD_GRID_SIZE || gap >= size * CLOSE_RATIO) return { points };

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

/* -------------------------------------------------------------------------------------------- */
/* Guide lines - the printed lines a stroke can lock onto                                         */
/* -------------------------------------------------------------------------------------------- */

/** One concrete line of one of the surface's *drawn* line families, resolved to the nearest line of
 * that family.
 *
 * Deliberately built from lines the user can see rather than from the lattice's abstract axes:
 * graph paper's 45deg diagonal is a fine snapping *direction* (see axesFor) but nothing draws it on
 * the page, so "start on the line and follow it" would have nothing to refer to there. Every family
 * here is one BoardBackground actually paints, derived from the same constants, so a locked stroke
 * always ends up sitting on a line the user is looking at. */
export interface GuideLine {
  /** A point that is both on the line and on the lattice - the origin distances are measured from,
   * which is what lets `snapAlongGuide` land on real lattice intersections without ever leaving the
   * line. */
  base: BoardPoint;
  /** Unit vector along the line. */
  dir: BoardPoint;
  /** Unit vector across it; perpendicular offsets are measured with this. */
  normal: BoardPoint;
  /** Distance along `dir` between consecutive lattice points on this line. */
  period: number;
  /** Perpendicular distance to the neighbouring line of the same family. Used only to stop the
   * lock-on tolerance from reaching into that neighbour. */
  pitch: number;
}

/** Ceiling on the lock-on tolerance, as a fraction of the family's own pitch. Without it a
 * zoomed-out board would put every point "on" every line at once; a third keeps the bands around
 * neighbouring lines from touching. */
const GUIDE_PITCH_CAP = 0.34;

/** How close the stroke's first point must be to a printed line for that line to be a candidate, in
 * *screen* px. Screen rather than world because it is a statement about how accurately a hand can
 * put a pen down, which doesn't change when the board is zoomed. */
const GUIDE_START_PX = 8;

/** Screen-px corridor a not-yet-locked stroke has to stay inside to keep a candidate alive. Doubles
 * as the direction test: staying within a few px of a line while travelling a whole grid step means
 * travelling *along* it. */
const GUIDE_CORRIDOR_PX = 7;

/** Screen-px distance from a locked guide at which the stroke comes off it and carries on as a free
 * straight line. Several times the corridor, so locking can't flicker - and because it is measured
 * across the line rather than along it, going backwards to shorten a locked line moves this number
 * not at all. */
const GUIDE_DETACH_PX = 20;

/** World-px of travel before a candidate guide is locked onto.
 *
 * Two grid steps rather than one, and the difference matters more than it looks: what has to be
 * ruled out is a *curve* that happens to start tangent to a printed line, since over a short enough
 * run any curve hugs its tangent. A stroke staying inside the corridor for a distance `d` has
 * curvature no tighter than `d^2 / 2 * corridor`, so doubling the distance quadruples the smallest
 * circle that can sneak through - at two grid steps only an arc wider than the screen qualifies.
 *
 * That bound carries real weight now that letting go of a guide promotes to a straight line rather
 * than restoring the raw path: a curve that locks by mistake stays a line for the rest of the
 * gesture. The remaining exposure is a circle several hundred px across begun exactly tangent to a
 * printed line, which is visible the instant it happens and one undo away. */
const GUIDE_LOCK_TRAVEL = BOARD_GRID_SIZE * 2;

function makeGuide(base: BoardPoint, dx: number, dy: number, period: number, pitch: number): GuideLine {
  const len = Math.hypot(dx, dy);
  const dir = { x: dx / len, y: dy / len };
  return { base, dir, normal: { x: -dir.y, y: dir.x }, period, pitch };
}

/** Signed perpendicular distance from `p` to the line. */
function guideOffset(line: GuideLine, p: BoardPoint): number {
  return (p.x - line.base.x) * line.normal.x + (p.y - line.base.y) * line.normal.y;
}

/** How far along the line `p` projects, measured from `base`. */
function guideParam(line: GuideLine, p: BoardPoint): number {
  return (p.x - line.base.x) * line.dir.x + (p.y - line.base.y) * line.dir.y;
}

function guidePointAt(line: GuideLine, t: number): BoardPoint {
  return { x: line.base.x + line.dir.x * t, y: line.base.y + line.dir.y * t };
}

/** `p` projected onto the line, then snapped to the nearest lattice point *on* it.
 *
 * Snapping along the line rather than with the generic `snapToSurface` is what keeps a locked
 * stroke exactly collinear: the generic lattice snap is free to pull an endpoint onto the nearest
 * intersection off to one side, which on an isometric surface would leave the committed line
 * visibly off the guide it was drawn against. */
function snapAlongGuide(line: GuideLine, p: BoardPoint): BoardPoint {
  return guidePointAt(line, Math.round(guideParam(line, p) / line.period) * line.period);
}

/** The stretch of `line` reaching `reach` world-px either side of where `near` projects onto it -
 * what the view layer paints to show which printed line a stroke is currently held to. */
export function guideSpan(line: GuideLine, near: BoardPoint, reach: number): [BoardPoint, BoardPoint] {
  const t = guideParam(line, near);
  return [guidePointAt(line, t - reach), guidePointAt(line, t + reach)];
}

/** Every drawn line passing within `tolerance` (world px) of `point` - at most one per family,
 * since the lines within a family are parallel. Empty on a plain surface: nothing is printed there,
 * so there is nothing to follow. */
export function guidesNear(point: BoardPoint, surface: BoardSurface, tolerance: number): GuideLine[] {
  const families: GuideLine[] = [];
  if (surface === "graph") {
    const g = BOARD_GRID_SIZE;
    families.push(makeGuide({ x: 0, y: Math.round(point.y / g) * g }, 1, 0, g, g));
    families.push(makeGuide({ x: Math.round(point.x / g) * g, y: 0 }, 0, 1, g, g));
  } else if (surface === "isometric") {
    // Verticals. Odd columns carry lattice points only on odd rows - that stagger is what makes the
    // lattice triangular - so the base row follows the column's parity, and consecutive lattice
    // points up a vertical are two rows apart rather than one.
    const col = Math.round(point.x / ISO_COL);
    const odd = Math.abs(col % 2) === 1;
    families.push(
      makeGuide({ x: col * ISO_COL, y: odd ? ISO_ROW_HEIGHT : 0 }, 0, 1, ISO_ROW_HEIGHT * 2, ISO_COL),
    );
    // The two 30deg families, indexed by intercept exactly as BoardBackground steps them, so the
    // line locked onto is one that is really on the page. Every row yields a lattice point on such a
    // line, so its period is a single lattice step.
    const slope = ISO_ROW_HEIGHT / ISO_COL;
    const interceptStep = ISO_ROW_HEIGHT * 2;
    const step = Math.hypot(ISO_COL, ISO_ROW_HEIGHT);
    for (const sign of [1, -1]) {
      const intercept = point.y - sign * slope * point.x;
      const base = { x: 0, y: Math.round(intercept / interceptStep) * interceptStep };
      // Neighbouring intercepts are `interceptStep` apart measured vertically; across the lines
      // themselves that foreshortens by cos(30deg), which is the ISO_COL / step ratio.
      families.push(makeGuide(base, ISO_COL, sign * ISO_ROW_HEIGHT, step, (interceptStep * ISO_COL) / step));
    }
  }
  return families.filter(
    (line) => Math.abs(guideOffset(line, point)) <= Math.min(tolerance, line.pitch * GUIDE_PITCH_CAP),
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Live assist - the mid-gesture state machine                                                    */
/* -------------------------------------------------------------------------------------------- */

/** How long the pointer has to sit still before a straight-looking stroke is converted. */
export const HOLD_STRAIGHTEN_MS = 1000;

/** Screen-px the pointer may wander inside without restarting the hold timer. Tremor and stylus
 * jitter, not movement. */
export const HOLD_DWELL_PX = 5;

/** Straightness (chord / path length) required for the hold gesture to convert. Looser than a
 * silent correction would dare to be, because the hold *is* the request: the user parked the pen
 * for a full second over something they clearly meant to be a line. */
const HOLD_STRAIGHTNESS = 0.97;

/** Everything the assist knows about a stroke that is still being drawn.
 *
 * Becoming a line is a one-way door within a gesture, and that is deliberate: whether the stroke is
 * a line has to be decided *once*, by something the user did, and then stay decided. See the module
 * header for why re-deciding it per sample is the bug this replaces. `guide` can be given up, but
 * only ever by promoting to `straight` - what a lock releases is the *printed line*, never the
 * straightness, because nothing about pulling away from a grid line says "I wanted a scribble". */
export interface LiveAssist {
  surface: BoardSurface;
  /** Mirrors the board's snapping toggle, captured when the stroke started. */
  enabled: boolean;
  /** Where the pen went down. The hold gesture's straightness test measures from here. */
  start: BoardPoint;
  /** The fixed end of the drawn line. Equal to `start` until a guide locks, which pins it to the
   * nearest lattice point on that guide - and it stays pinned there afterwards, so coming off the
   * guide can't make the line jump at the end the user isn't even holding. */
  origin: BoardPoint;
  /** Guides through the start point that the stroke has not strayed from yet. Emptied as soon as
   * one is locked, or as soon as the stroke leaves all of them. */
  candidates: GuideLine[];
  /** The printed line the stroke is being held to, once one has been locked. */
  guide: GuideLine | null;
  /** A free straight line from `origin` to wherever the pointer is - snapping to an axis when the
   * angle is close to one, following the pointer exactly when it isn't. Set by the hold gesture, and
   * by a locked guide letting go. */
  straight: boolean;
}

export function beginLiveAssist(
  start: BoardPoint,
  surface: BoardSurface,
  enabled: boolean,
  zoom: number,
): LiveAssist {
  return {
    surface,
    enabled,
    start,
    origin: start,
    candidates: enabled ? guidesNear(start, surface, GUIDE_START_PX / zoom) : [],
    guide: null,
    straight: false,
  };
}

/** Folds one pointer sample into the state: narrows the candidates, locks onto one, or releases the
 * locked one. */
export function advanceLiveAssist(state: LiveAssist, point: BoardPoint, zoom: number): void {
  if (state.guide) {
    if (Math.abs(guideOffset(state.guide, point)) * zoom > GUIDE_DETACH_PX) {
      // Pulled clear of the printed line. What that releases is the *attachment* - the line keeps
      // its straightness and its anchor and simply follows the pointer from here, free to point
      // anywhere. Dropping back to the raw path instead would be the old bug wearing a new hat: the
      // user is drawing a line, is still drawing a line, and pulling away from a grid line has
      // never once meant "actually, make this a scribble".
      state.guide = null;
      state.straight = true;
      state.candidates = [];
    }
    return;
  }
  if (state.straight || state.candidates.length === 0) return;
  // Capped in world units too, or a zoomed-out board would have a corridor wider than the grid
  // itself and lock onto lines the stroke never followed.
  const corridor = Math.min(GUIDE_CORRIDOR_PX / zoom, BOARD_GRID_SIZE / 3);
  state.candidates = state.candidates.filter((line) => Math.abs(guideOffset(line, point)) <= corridor);
  if (state.candidates.length === 0) return;
  if (Math.hypot(point.x - state.start.x, point.y - state.start.y) < GUIDE_LOCK_TRAVEL) return;
  // A start point on an intersection sits on two or three lines at once; by a full grid step of
  // travel the crossing families have long since failed the corridor test, so whichever survivor is
  // closest is the one being followed.
  state.candidates.sort((a, b) => Math.abs(guideOffset(a, point)) - Math.abs(guideOffset(b, point)));
  state.guide = state.candidates[0];
  // Pin the fixed end onto the guide now, once, rather than deriving it per frame: it is what the
  // line is drawn from for the rest of the gesture, including after the guide is let go.
  state.origin = snapAlongGuide(state.guide, state.start);
  state.candidates = [];
}

/** The hold gesture firing. Converts a straight-looking freehand stroke into a straight line, and
 * reports whether it did, so the caller only repaints when something changed.
 *
 * Does nothing while a guide is locked (there is nothing left to convert) or when the path doesn't
 * look like a line - a pause in the middle of drawing a curve is just a pause. */
export function holdStraighten(state: LiveAssist, points: readonly BoardPoint[]): boolean {
  if (!state.enabled || state.straight || state.guide) return false;
  if (!axesFor(state.surface) || points.length < 2) return false;
  const total = pathLength(points);
  if (total < MIN_ASSIST_LENGTH) return false;
  const end = points[points.length - 1];
  if (Math.hypot(end.x - state.start.x, end.y - state.start.y) / total < HOLD_STRAIGHTNESS) return false;
  state.straight = true;
  return true;
}

/** The line this stroke has become, or null while it is still plain freehand - in which case the
 * caller draws and commits the raw path. */
export function liveAssistLine(state: LiveAssist, points: readonly BoardPoint[]): BoardPoint[] | null {
  const end = points[points.length - 1];
  if (!end) return null;
  if (state.guide) {
    // The moving end is a *projection* onto the guide, which is what makes the lock unbreakable:
    // moving back along the line shortens it, moving across it does nothing at all, and no amount
    // of scribbling can change what is drawn except by travelling along the line or leaving it.
    return [state.origin, snapAlongGuide(state.guide, end)];
  }
  if (state.straight) return straightenTo(state.origin, end, state.surface);
  return null;
}
