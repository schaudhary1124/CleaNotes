import { useCallback, useEffect, useRef } from "react";
import { dashPattern } from "./boardTypes";
import type { BoardPoint, BoardStrokeStyle, BoardSurface, BoardViewport } from "./boardTypes";
import { screenPointFromEvent, screenToWorld, worldToScreen, type EraserRegion } from "./geometry";
import {
  HOLD_DWELL_PX,
  HOLD_STRAIGHTEN_MS,
  advanceLiveAssist,
  assistStroke,
  beginLiveAssist,
  guideSpan,
  holdStraighten,
  liveAssistLine,
  type AssistResult,
  type GuideLine,
  type LiveAssist,
} from "./inkAssist";

export const HIGHLIGHTER_ALPHA = 0.35;

/** Captures freehand drawing on the board and paints the in-progress stroke.
 *
 * Only the *live* stroke lives here. Committed ink is a normal BoardElement rendered as SVG inside
 * the world layer (see BoardElementView), which gets crisp scaling at every zoom level for free and
 * makes ink selectable/movable like anything else on the canvas. Splitting the two is the same
 * base/live division SketchLayer uses, and for the same reason: repainting committed history on
 * every pointer sample makes drawing latency grow with total ink on the board.
 *
 * The canvas is viewport-sized and sits *outside* the world transform, so this component works
 * entirely in screen pixels and converts through the viewport only at the two boundaries - reading
 * a pointer event, and committing the finished stroke. That avoids compounding a scale transform
 * with a canvas backing-store scale, which is where SketchLayer's zoom handling gets its
 * complexity from; here there is simply nothing to divide by.
 *
 * A live preview of the assist result (see inkAssist.ts) is drawn *while* the pointer is down on a
 * graph/isometric surface, so the user can see the line about to snap rather than being surprised
 * by it on release. This layer owns the two things the assist state machine can't compute for
 * itself: the pointer samples that feed it, and the hold timer - a pointer resting perfectly still
 * emits no events at all, so nothing but a timer would ever notice the pause. */
/** The ink style a finished stroke is committed with - the drawing half of the toolbar's current
 * settings, resolved. */
export interface InkStyle {
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  dash: BoardStrokeStyle;
}

export function BoardInkLayer({
  active,
  tool,
  color,
  width,
  dash,
  eraserSquare,
  surface,
  assistEnabled,
  viewport,
  viewWidth,
  viewHeight,
  onCommit,
  onErase,
  onEraseStart,
}: {
  /** Whether a drawing tool currently owns the pointer. Inactive layers are fully click-through. */
  active: boolean;
  tool: "pen" | "highlighter" | "eraser";
  color: string;
  /** In *world* px, so ink drawn zoomed-out isn't hairline-thin when the user zooms back in. Stroke
   * width for pen/highlighter; for the eraser it is the nib's *diameter* - the span the user sees
   * on screen - which the region below halves. */
  width: number;
  /** Dash pattern for pen/highlighter strokes; the live preview matches what gets committed. */
  dash: BoardStrokeStyle;
  /** Square rather than round eraser nib - see BoardEraserShape. */
  eraserSquare: boolean;
  surface: BoardSurface;
  assistEnabled: boolean;
  viewport: BoardViewport;
  viewWidth: number;
  viewHeight: number;
  onCommit: (result: AssistResult, style: InkStyle) => void;
  /** The patch of world the eraser nib covers right now; the board decides what that hits. */
  onErase: (region: EraserRegion) => void;
  /** One notification per erase gesture, before the first `onErase` - lets the board collapse a
   * whole drag into a single undo step. */
  onEraseStart?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<BoardPoint[]>([]);
  const drawingRef = useRef(false);
  const erasingRef = useRef(false);
  /** Where the eraser nib is hovering, in world coordinates, or null when the pointer is off the
   * canvas. Drawn as an outline: a 48px square nib is otherwise invisible until it has already
   * deleted something, which makes both the size and shape settings unusable. */
  const hoverRef = useRef<BoardPoint | null>(null);
  /** Whether the in-progress stroke has become a line, and by which route - see LiveAssist. Null
   * between gestures. */
  const liveRef = useRef<LiveAssist | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  /** Where the pointer settled last. The hold gesture measures its second from here, not from the
   * last sample, so a hand that trembles a few px in place still counts as holding. */
  const holdAnchorRef = useRef<BoardPoint | null>(null);
  // Every value the paint path reads is mirrored into a ref so `redraw` can stay referentially
  // stable (empty dep array) and be called straight from pointer handlers without re-creating a
  // closure per sample.
  const propsRef = useRef({
    tool,
    color,
    width,
    dash,
    eraserSquare,
    surface,
    assistEnabled,
    viewport,
    viewWidth,
    viewHeight,
  });
  propsRef.current = {
    tool,
    color,
    width,
    dash,
    eraserSquare,
    surface,
    assistEnabled,
    viewport,
    viewWidth,
    viewHeight,
  };
  /** The resolved `--board-guide` colour, read once per stroke rather than per sample: reading a
   * computed style is a style-recalc the paint path would otherwise pay for at pointer rate, and a
   * theme cannot change between putting the pen down and lifting it. */
  const guideColorRef = useRef("rgba(99, 102, 241, 0.65)");

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewWidth === 0 || viewHeight === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewWidth * dpr);
    canvas.height = Math.round(viewHeight * dpr);
    canvas.style.width = `${viewWidth}px`;
    canvas.style.height = `${viewHeight}px`;
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [viewWidth, viewHeight]);

  useEffect(() => {
    resize();
  }, [resize]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const {
      tool: t,
      color: c,
      width: w,
      dash: d,
      eraserSquare: square,
      surface: s,
      assistEnabled: assist,
      viewport: vp,
      viewWidth: vw,
      viewHeight: vh,
    } = propsRef.current;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    if (t === "eraser") {
      drawEraserNib(ctx, hoverRef.current, w / 2, square, vp);
      return;
    }

    const raw = pointsRef.current;
    if (raw.length === 0) return;

    // Preview the assisted result, not the raw path, so what's on screen mid-gesture is what will
    // be committed. Both passes are pure and cheap (one walk over the points), so running them per
    // sample costs the same order as drawing the stroke itself.
    const live = liveRef.current;
    const line = live ? liveAssistLine(live, raw) : null;
    // Painted first so it sits behind the ink. Without it the lock has no visible state at all: the
    // user would see a straight line but nothing telling them it is *held* to a particular line, or
    // which one they are about to come off by pulling away.
    if (live?.guide) drawGuide(ctx, live.guide, vp, vw, vh, guideColorRef.current);
    const preview = line ? { points: line } : assist ? assistStroke(raw, s) : { points: raw };
    const pts = (preview.shape ? shapeOutline(preview.shape) : preview.points).map((p) =>
      worldToScreen(p, vp),
    );

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = Math.max(1, w * vp.zoom);
    // The pattern is in world px like the width it is derived from, so it scales with zoom exactly
    // as the committed SVG dasharray will.
    const pattern = dashPattern(d, w);
    if (pattern) ctx.setLineDash(pattern.map((segment) => segment * vp.zoom));
    if (t === "highlighter") ctx.globalAlpha = HIGHLIGHTER_ALPHA;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      // Quadratic smoothing through segment midpoints - the same curve SketchLayer draws, so ink
      // looks identical whether it was drawn on a note or on a board.
      for (let i = 1; i < pts.length - 1; i++) {
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
    }
    ctx.restore();
  }, []);

  // Repaint whenever the camera moves: the live stroke and the eraser nib are both anchored to world
  // coordinates, so a pan or zoom mid-gesture has to re-project them.
  useEffect(redraw, [viewport, redraw]);

  // A tool switch (or losing the pointer altogether) must not leave a stale nib outline painted on
  // an otherwise idle layer.
  useEffect(() => {
    hoverRef.current = null;
    redraw();
  }, [tool, active, redraw]);

  // Unmounting mid-stroke (closing the board, switching tabs) must not leave a timer that fires
  // into a dead component.
  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    },
    [],
  );

  function worldPoint(e: React.PointerEvent<HTMLCanvasElement>): BoardPoint {
    return screenToWorld(screenPointFromEvent(e, e.currentTarget), propsRef.current.viewport);
  }

  /** (Re)starts the hold countdown from `point`. Called on pointer-down and again every time the
   * pointer leaves the dwell radius, so the wait is always measured from the moment the pointer
   * last came to rest rather than from the start of the stroke. */
  function armHold(point: BoardPoint) {
    holdAnchorRef.current = point;
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      const live = liveRef.current;
      // The gesture may have ended in the meantime; and holdStraighten declines quietly when the
      // path doesn't look like a line, which is why the repaint is conditional on it.
      if (drawingRef.current && live && holdStraighten(live, pointsRef.current)) redraw();
    }, HOLD_STRAIGHTEN_MS);
  }

  function cancelHold() {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    holdAnchorRef.current = null;
  }

  /** The nib's footprint at `point`. `width` is a diameter, so the region's half-extent is half of
   * it - and a square nib covers the same span as a round one of the same setting. */
  function eraserRegion(point: BoardPoint): EraserRegion {
    const { width: w, eraserSquare: square } = propsRef.current;
    return { center: point, radius: Math.max(0.5, w / 2), square };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return;
    // Middle/right button stays reserved for panning and the context menu even while a draw tool
    // is selected - the standard canvas-app escape hatch out of a modal tool.
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = worldPoint(e);
    if (propsRef.current.tool === "eraser") {
      erasingRef.current = true;
      hoverRef.current = point;
      onEraseStart?.();
      onErase(eraserRegion(point));
      redraw();
      return;
    }
    drawingRef.current = true;
    pointsRef.current = [point];
    guideColorRef.current = resolveGuideColor(e.currentTarget);
    const { surface: s, assistEnabled: assist, viewport: vp } = propsRef.current;
    // The candidate guides are decided by where the pen goes *down* - "did you start on a line" is
    // a question about this one point, and re-asking it later would let a stroke that wandered onto
    // a line halfway through claim it started there.
    liveRef.current = beginLiveAssist(point, s, assist, vp.zoom);
    armHold(point);
    redraw();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return;
    const point = worldPoint(e);
    if (propsRef.current.tool === "eraser") {
      hoverRef.current = point;
      if (erasingRef.current) onErase(eraserRegion(point));
      // Painted on every move, pressed or not: the outline *is* the cursor.
      redraw();
      return;
    }
    if (!drawingRef.current) return;
    // Drop samples that barely moved: at high zoom a slow hand emits dozens of sub-pixel points
    // per second, which bloats the stored stroke and skews inkAssist's path-length measurement
    // without adding any visible detail.
    const zoom = propsRef.current.viewport.zoom;
    const last = pointsRef.current[pointsRef.current.length - 1];
    const minStep = 1 / zoom;
    // Bailing here also means the hold keeps counting: a sample too small to record is a hand
    // holding still, which is exactly what the gesture is waiting for.
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < minStep) return;
    pointsRef.current.push(point);
    const live = liveRef.current;
    if (live) advanceLiveAssist(live, point, zoom);
    const anchor = holdAnchorRef.current;
    // Leaving the dwell radius means the pointer is travelling, not resting, so the countdown
    // restarts from wherever it has got to.
    if (!anchor || Math.hypot(point.x - anchor.x, point.y - anchor.y) * zoom > HOLD_DWELL_PX) {
      armHold(point);
    }
    redraw();
  }

  function endGesture(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (erasingRef.current) {
      erasingRef.current = false;
      return;
    }
    if (!drawingRef.current) return;
    drawingRef.current = false;
    cancelHold();
    const raw = pointsRef.current;
    pointsRef.current = [];
    const live = liveRef.current;
    liveRef.current = null;
    const { tool: t, color: c, width: w, dash: d, surface: s, assistEnabled: assist } = propsRef.current;
    if (raw.length > 0 && t !== "eraser") {
      // A stroke that became a line commits as that line and nothing else - running the release
      // pass over it as well could only disagree with what the user has been looking at.
      const line = live ? liveAssistLine(live, raw) : null;
      const result = line
        ? { points: line }
        : assist
          ? assistStroke(raw, s)
          : // With assist off a lone tap still snaps nowhere, but a single point needs *some* extent
            // to become a visible dot - inkFromPoints' width padding handles that.
            { points: raw };
      onCommit(result, { tool: t, color: c, width: w, dash: d });
    }
    redraw();
  }

  return (
    <canvas
      ref={canvasRef}
      className="board-ink-layer"
      style={{
        pointerEvents: active ? "auto" : "none",
        touchAction: active ? "none" : "auto",
        // The eraser used to rely on a "cell" cursor to hint at its size; it now paints its own nib
        // outline, so every ink tool wants the same precise crosshair.
        cursor: "crosshair",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={() => {
        hoverRef.current = null;
        redraw();
      }}
    />
  );
}

/** The eraser's footprint, painted as an outline that follows the pointer.
 *
 * Neutral grey rather than the accent colour: it sits directly over board content on both a light
 * and a dark surface, and an accent-tinted overlay reads as a selection rather than as a tool. */
function drawEraserNib(
  ctx: CanvasRenderingContext2D,
  hover: BoardPoint | null,
  radius: number,
  square: boolean,
  viewport: BoardViewport,
) {
  if (!hover) return;
  const center = worldToScreen(hover, viewport);
  // Floored at a few pixels so a small nib on a zoomed-out board is still visible.
  const r = Math.max(3, radius * viewport.zoom);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(130, 130, 140, 0.9)";
  ctx.fillStyle = "rgba(150, 150, 160, 0.12)";
  ctx.beginPath();
  if (square) ctx.rect(center.x - r, center.y - r, r * 2, r * 2);
  else ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** `--board-guide` as something canvas can accept.
 *
 * The variable is defined in terms of `--accent-rgb` so the guide follows the user's accent colour;
 * a computed custom property has its `var()` references substituted, so this normally comes back as
 * a literal colour. The guard is for the case where it doesn't: assigning an unsubstituted `var(…)`
 * to `strokeStyle` is silently ignored, which would leave the guide painted in whatever colour the
 * context happened to hold - the one failure mode worth a line of code to avoid. */
function resolveGuideColor(canvas: HTMLCanvasElement): string {
  const value = getComputedStyle(canvas).getPropertyValue("--board-guide").trim();
  return value && !value.includes("var(") ? value : "rgba(99, 102, 241, 0.65)";
}

/** The printed line a stroke is currently held to, drawn across the viewport behind the ink.
 *
 * Dashed and in the accent colour rather than the grid's own grey: it has to read as a live tool
 * state - "your line is attached to *this*" - and a solid grey line would just look like one grid
 * line drawn heavier than its neighbours. */
function drawGuide(
  ctx: CanvasRenderingContext2D,
  guide: GuideLine,
  viewport: BoardViewport,
  width: number,
  height: number,
  color: string,
) {
  // Rather than clip the infinite line to the viewport rect, extend it a full diagonal either side
  // of the screen centre - the same picture on screen, without the case analysis.
  const centre = screenToWorld({ x: width / 2, y: height / 2 }, viewport);
  const [from, to] = guideSpan(guide, centre, Math.hypot(width, height) / viewport.zoom);
  const a = worldToScreen(from, viewport);
  const b = worldToScreen(to, viewport);
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

/** Polyline preview for a recognized shape, so the live canvas can show the rectangle/ellipse the
 * assist is about to snap to before the pointer lifts. */
function shapeOutline(shape: NonNullable<AssistResult["shape"]>): BoardPoint[] {
  const { x, y, w, h } = shape;
  if (shape.kind === "rect") {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
      { x, y },
    ];
  }
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const steps = 48;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}
