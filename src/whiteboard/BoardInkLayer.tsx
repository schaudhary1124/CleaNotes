import { useCallback, useEffect, useRef } from "react";
import type { BoardPoint, BoardSurface, BoardViewport } from "./boardTypes";
import { screenPointFromEvent, screenToWorld, worldToScreen } from "./geometry";
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
export function BoardInkLayer({
  active,
  tool,
  color,
  width,
  surface,
  assistEnabled,
  viewport,
  viewWidth,
  viewHeight,
  onCommit,
  onErase,
}: {
  /** Whether a drawing tool currently owns the pointer. Inactive layers are fully click-through. */
  active: boolean;
  tool: "pen" | "highlighter" | "eraser";
  color: string;
  /** Stroke width / erase radius in *world* px, so ink drawn zoomed-out isn't hairline-thin when
   * the user zooms back in. */
  width: number;
  surface: BoardSurface;
  assistEnabled: boolean;
  viewport: BoardViewport;
  viewWidth: number;
  viewHeight: number;
  onCommit: (result: AssistResult, tool: "pen" | "highlighter", color: string, width: number) => void;
  /** World point + world radius touched by the eraser; the board decides what that hits. */
  onErase: (point: BoardPoint, radius: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<BoardPoint[]>([]);
  const drawingRef = useRef(false);
  const erasingRef = useRef(false);
  // Every value the paint path reads is mirrored into a ref so `redraw` can stay referentially
  // stable (empty dep array) and be called straight from pointer handlers without re-creating a
  // closure per sample.
  const propsRef = useRef({ tool, color, width, surface, assistEnabled, viewport });
  propsRef.current = { tool, color, width, surface, assistEnabled, viewport };

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
    const { tool: t, color: c, width: w, surface: s, assistEnabled: assist, viewport: vp } = propsRef.current;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    const raw = pointsRef.current;
    if (raw.length === 0 || t === "eraser") return;

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

  function worldPoint(e: React.PointerEvent<HTMLCanvasElement>): BoardPoint {
    return screenToWorld(screenPointFromEvent(e, e.currentTarget), propsRef.current.viewport);
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
      onErase(point, propsRef.current.width);
      return;
    }
    drawingRef.current = true;
    pointsRef.current = [point];
    redraw();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return;
    const point = worldPoint(e);
    if (erasingRef.current) {
      onErase(point, propsRef.current.width);
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
    const { tool: t, color: c, width: w, surface: s, assistEnabled: assist } = propsRef.current;
    if (raw.length > 0 && t !== "eraser") {
      const result = assist
        ? assistStroke(raw, s)
        : // With assist off a lone tap still snaps nowhere, but a single point needs *some* extent
          // to become a visible dot - inkFromPoints' width padding handles that.
          { points: raw };
      onCommit(result, t, c, w);
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
        cursor: tool === "eraser" ? "cell" : "crosshair",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    />
  );
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
