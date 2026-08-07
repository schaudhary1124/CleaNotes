import { useCallback, useEffect, useRef } from "react";
import { dashPattern } from "./boardTypes";
import type { BoardPoint, BoardStrokeStyle, BoardSurface, BoardViewport } from "./boardTypes";
import { screenPointFromEvent, screenToWorld, worldToScreen, type EraserRegion } from "./geometry";
import { assistStroke, type AssistResult } from "./inkAssist";

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
 * by it on release. */
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
  // Every value the paint path reads is mirrored into a ref so `redraw` can stay referentially
  // stable (empty dep array) and be called straight from pointer handlers without re-creating a
  // closure per sample.
  const propsRef = useRef({ tool, color, width, dash, eraserSquare, surface, assistEnabled, viewport });
  propsRef.current = { tool, color, width, dash, eraserSquare, surface, assistEnabled, viewport };

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
    // be committed. `assistStroke` is pure and cheap (one pass over the points), so running it per
    // sample costs the same order as drawing the stroke itself.
    const preview = assist ? assistStroke(raw, s) : { points: raw };
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

  function worldPoint(e: React.PointerEvent<HTMLCanvasElement>): BoardPoint {
    return screenToWorld(screenPointFromEvent(e, e.currentTarget), propsRef.current.viewport);
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
    const last = pointsRef.current[pointsRef.current.length - 1];
    const minStep = 1 / propsRef.current.viewport.zoom;
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < minStep) return;
    pointsRef.current.push(point);
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
    const raw = pointsRef.current;
    pointsRef.current = [];
    const { tool: t, color: c, width: w, dash: d, surface: s, assistEnabled: assist } = propsRef.current;
    if (raw.length > 0 && t !== "eraser") {
      const result = assist
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
