import { useCallback, useEffect, useRef } from "react";
import type { SketchPoint, SketchStroke, SketchTool } from "../types";

interface SketchLayerProps {
  className?: string;
  /** Whether sketch mode is on - controls pointer capture vs. click-through. */
  active: boolean;
  strokes: SketchStroke[];
  tool: SketchTool;
  color: string;
  /** Line width (pen/highlighter) or erase radius (eraser), in CSS pixels. */
  width: number;
  onAddStroke: (stroke: SketchStroke) => void;
  onEraseStrokes: (ids: string[]) => void;
}

const HIGHLIGHTER_ALPHA = 0.35;

function distanceToSegment(p: SketchPoint, a: SketchPoint, b: SketchPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: SketchStroke) {
  const { points } = stroke;
  if (points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  if (stroke.tool === "highlighter") ctx.globalAlpha = HIGHLIGHTER_ALPHA;

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Notability-style ink layer: a canvas overlay that draws/erases vector
 * strokes over the note.
 *
 * Strokes are stored in raw CSS pixels relative to the note content's
 * top-left corner (i.e. the scrolling wrapper's origin, not the viewport),
 * not a coordinate space that scales with the note's width. The text
 * underneath doesn't reflow proportionally when the window is resized (short
 * lines just gain/lose surrounding whitespace), so scaling ink with
 * container width made it drift away from the words it was drawn on.
 * Keeping ink in fixed document-relative pixels means it stays exactly where
 * the user drew it - moving only if the text above it actually reflows, same
 * as the text itself.
 *
 * The canvases themselves, however, are sized to the scrolling ancestor's
 * *viewport* (clientHeight), not the full scrollable content height, and
 * repositioned/redrawn on scroll rather than living in normal document flow.
 * They used to be full document height (simplest: just another absolutely-
 * positioned child spanning the whole scrollable wrapper, scrolling for
 * free along with the text). But a canvas backing store is a GPU-composited
 * layer whose recomposite cost scales with its pixel area, and WKWebView
 * recomposites every layer on every single frame during a live window
 * resize (see lib.rs's layerContentsRedrawPolicy fix) - for a long note that
 * made the ink layer, alone, the single largest composited layer on the
 * page, and resizing the window turned into a many-hundred-millisecond
 * stall per frame that scaled with total note length, including content
 * scrolled out of view. Capping both canvases to the visible viewport keeps
 * their pixel area bounded no matter how long the note is. `scrollTopRef`
 * plus a `ctx.translate` when drawing (and the inverse when converting a
 * pointer event back to a document-relative point) keeps ink storage and
 * hit-testing exactly as before - only *where it's rasterized* changed.
 *
 * The canvases also span .prose-note's *whole* box on every side - text
 * column plus its padding gutter, top/bottom included - so drawing reaches
 * every visible edge of the note, not just the text column. Stroke storage
 * stays relative to the text column's own top-left corner regardless
 * (matching Editor.tsx's handleAddStroke, which resolves gesture points
 * against that same origin), so `padLeftRef`/`padTopRef` carry the same
 * correction horizontally that `scrollTopRef` already had to make
 * vertically - see the effect below.
 *
 * Rendered as two stacked canvases rather than one: a `base` layer holding
 * every committed stroke, repainted only when `strokes` actually changes,
 * and a `live` layer holding just the in-progress stroke, repainted on
 * every pointer sample while drawing. A single canvas would have to clear
 * and replay the *entire* stroke history on every pointer move to show the
 * new point - fine for a fresh note, but drawing latency grew with total
 * ink on the page, since every additional pointer sample cost O(all ink
 * ever drawn) instead of O(the one stroke currently being drawn). */
export function SketchLayer({
  className,
  active,
  strokes,
  tool,
  color,
  width,
  onAddStroke,
  onEraseStrokes,
}: SketchLayerProps) {
  // clipRef is the outermost element (gets `className`/`inset-0` from the caller, matching
  // sketchWrapperRef's own bounds exactly) and exists solely to `overflow: hidden` - containerRef
  // (below) is `position: absolute` with a `top` driven by the live scroll offset, and an
  // absolutely-positioned descendant still counts toward its *scrolling* ancestor's (.prose-note)
  // scrollable overflow region even though it's outside normal flow. Without a clip somewhere, any
  // sub-pixel overshoot in that computed `top` would grow .prose-note's scrollHeight, which permits
  // scrolling further, which pushes `top` further still next tick - a runaway feedback loop that
  // kept adding empty space at the bottom of the note the further you scrolled. This clip has to
  // live on a dedicated element rather than sketchWrapperRef itself (the more obvious place): that
  // div also carries the "paper"/"index-card" look's ruled-line background (see index.css), which
  // deliberately uses *negative* insets to bleed past its own edges out to .prose-note's padding
  // gutter - clipping there cut the lines off short instead.
  const clipRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const currentStrokeRef = useRef<SketchStroke | null>(null);
  const isDrawingRef = useRef(false);
  const isErasingRef = useRef(false);
  const erasedIdsRef = useRef<Set<string>>(new Set());
  // How far the scrolling ancestor (`.prose-note`) is currently scrolled - kept in sync by the
  // "scroll" listener below. Both canvases only ever rasterize this scrollTop..scrollTop+viewport
  // slice of document-relative stroke coordinates (see the component doc comment above), so every
  // draw/hit-test that mixes a screen-space point with document-relative stroke storage needs it.
  const scrollTopRef = useRef(0);
  // The canvas itself spans .prose-note's *entire* box, including its padding gutter on all four
  // sides (see the effect below), so drawing reaches all the way to the visible edges of the note -
  // not just the text column. Stroke storage, though, stays relative to the text column's own
  // top-left corner (sketchWrapperRef in Editor.tsx) for compatibility with already-saved ink and
  // with handleAddStroke's gesture classification, which resolves points against that same origin.
  // These are the gap between the two: .prose-note's current left/top padding in px, kept in sync
  // alongside scrollTopRef, and applied as an extra translate term everywhere scrollTopRef is (plus
  // padTopRef also correcting *where* the container itself sits - see applyScrollOffset).
  const padLeftRef = useRef(0);
  const padTopRef = useRef(0);

  function clearCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /** Repaints committed history - only needed when `strokes` changes, an
   * erase hits something, the canvas is resized, or the note scrolls. */
  const redrawBase = useCallback(() => {
    const canvas = baseCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    clearCanvas(canvas, ctx);
    ctx.save();
    // Shifts document-relative stroke coordinates into this (viewport-sized) canvas's own local
    // space - the inverse of toLocalPoint's offsets below.
    ctx.translate(padLeftRef.current, padTopRef.current - scrollTopRef.current);
    for (const stroke of strokesRef.current) {
      if (erasedIdsRef.current.has(stroke.id)) continue;
      drawStroke(ctx, stroke);
    }
    ctx.restore();
  }, []);

  /** Repaints just the in-progress stroke - called on every pointer sample
   * while drawing, so its cost is bounded by that one stroke's length. */
  const redrawLive = useCallback(() => {
    const canvas = liveCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    clearCanvas(canvas, ctx);
    if (currentStrokeRef.current) {
      ctx.save();
      ctx.translate(padLeftRef.current, padTopRef.current - scrollTopRef.current);
      drawStroke(ctx, currentStrokeRef.current);
      ctx.restore();
    }
  }, []);

  /** Keeps the container pinned over the currently-visible slice of the note as it scrolls -
   * `containerRef` is `position: absolute` inside the (document-height-tall) scroll content, so
   * without this it would scroll away with the text instead of staying put like a real overlay.
   * No `padTopRef` term here despite containerRef needing to reach .prose-note's true top edge
   * (padding gutter included): containerRef's containing block is clipRef, not sketchWrapperRef
   * directly, and clipRef's own `top: -padTop` (see the effect below) already carries exactly that
   * correction - stacking a second one here would double it. `padTopRef` still matters for
   * drawing/hit-testing (see redrawBase/toLocalPoint), just not for this element's own position. */
  const applyScrollOffset = useCallback(() => {
    const el = containerRef.current;
    if (el) el.style.top = `${scrollTopRef.current}px`;
  }, []);

  const resizeAndRedraw = useCallback(
    (width: number, height: number) => {
      if (width === 0 || height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const container = containerRef.current;
      if (container) {
        container.style.height = `${height}px`;
        container.style.bottom = "auto";
      }
      for (const canvas of [baseCanvasRef.current, liveCanvasRef.current]) {
        if (!canvas) continue;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      redrawBase();
      redrawLive();
    },
    [redrawBase, redrawLive],
  );

  useEffect(() => {
    const scrollEl = clipRef.current?.closest<HTMLElement>(".prose-note");
    if (!scrollEl) return;

    // clipRef's own bounds default to matching sketchWrapperRef (the text column, via the
    // `inset-0` className) - pulled out here, past sketchWrapperRef's own edges, to .prose-note's
    // real padding edges on all four sides, so the paintable area reaches the whole visible note
    // instead of stopping at the text column. Read fresh (not hardcoded to Editor.tsx's
    // px-12/py-8/@max-lg:.../@max-sm:...) so it stays correct across the @container breakpoints
    // that resize those paddings - see index.css's own note-look-paper rule-line background,
    // which bleeds out the same way for the same reason. Unlike the horizontal case, this doesn't
    // risk reintroducing the runaway-scrollHeight feedback loop that overflow-hidden on clipRef
    // was added to prevent in the first place: that loop was fed by a value (scrollTop) that was
    // itself bounded by the very thing it inflated - padding is a fixed CSS value, and extending
    // clipRef to include it just reaches .prose-note's own true content extent (which already
    // includes its own padding, by definition of the CSS box model), not one pixel further.
    const applyBleed = () => {
      const clip = clipRef.current;
      if (!clip) return { padLeft: 0, padTop: 0 };
      const style = getComputedStyle(scrollEl);
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padRight = parseFloat(style.paddingRight) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      const padBottom = parseFloat(style.paddingBottom) || 0;
      clip.style.left = `${-padLeft}px`;
      clip.style.right = `${-padRight}px`;
      clip.style.top = `${-padTop}px`;
      clip.style.bottom = `${-padBottom}px`;
      return { padLeft, padTop };
    };

    // Order matters: applyScrollOffset reads padTopRef, so it has to run *after* applyBleed has
    // updated it, not before - otherwise the container briefly (re)positions itself off the stale
    // padding value from the previous measurement (or 0, on first mount).
    const measure = () => {
      const { padLeft, padTop } = applyBleed();
      padLeftRef.current = padLeft;
      padTopRef.current = padTop;
      applyScrollOffset();
      resizeAndRedraw(scrollEl.clientWidth, scrollEl.clientHeight);
    };
    const onScroll = () => {
      scrollTopRef.current = scrollEl.scrollTop;
      applyScrollOffset();
      redrawBase();
      redrawLive();
    };

    scrollTopRef.current = scrollEl.scrollTop;
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scrollEl.removeEventListener("scroll", onScroll);
    };
  }, [resizeAndRedraw, redrawBase, redrawLive, applyScrollOffset]);

  useEffect(() => {
    redrawBase();
  }, [strokes, redrawBase]);

  function toLocalPoint(e: React.PointerEvent<HTMLCanvasElement>): SketchPoint {
    const rect = e.currentTarget.getBoundingClientRect();
    // rect is viewport-relative (the canvas covers all of .prose-note's current viewport, edge to
    // edge - see the component doc comment), but stroke storage stays relative to the text
    // column's own top-left corner and is unaffected by scroll, so these offsets get applied back
    // in here - the inverse of redrawBase/redrawLive's
    // `ctx.translate(padLeftRef.current, padTopRef.current - scrollTopRef.current)`.
    return {
      x: e.clientX - rect.left - padLeftRef.current,
      y: e.clientY - rect.top + scrollTopRef.current - padTopRef.current,
    };
  }

  function eraseAt(point: SketchPoint) {
    const radius = width;
    let changed = false;
    for (const stroke of strokesRef.current) {
      if (erasedIdsRef.current.has(stroke.id)) continue;
      const pts = stroke.points;
      const hitRadius = radius + stroke.width / 2;
      let hit =
        pts.length === 1 && Math.hypot(point.x - pts[0].x, point.y - pts[0].y) < hitRadius;
      for (let i = 0; !hit && i < pts.length - 1; i++) {
        if (distanceToSegment(point, pts[i], pts[i + 1]) < hitRadius) hit = true;
      }
      if (hit) {
        erasedIdsRef.current.add(stroke.id);
        changed = true;
      }
    }
    if (changed) redrawBase();
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = toLocalPoint(e);

    if (tool === "eraser") {
      isErasingRef.current = true;
      erasedIdsRef.current = new Set();
      eraseAt(point);
      return;
    }

    isDrawingRef.current = true;
    currentStrokeRef.current = {
      id: crypto.randomUUID(),
      tool,
      color,
      width,
      points: [point],
    };
    redrawLive();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return;
    const point = toLocalPoint(e);
    if (isErasingRef.current) {
      eraseAt(point);
      return;
    }
    if (isDrawingRef.current && currentStrokeRef.current) {
      currentStrokeRef.current.points.push(point);
      redrawLive();
    }
  }

  function endGesture(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!active) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (isErasingRef.current) {
      isErasingRef.current = false;
      const ids = Array.from(erasedIdsRef.current);
      erasedIdsRef.current = new Set();
      if (ids.length > 0) onEraseStrokes(ids);
      return;
    }
    if (isDrawingRef.current && currentStrokeRef.current) {
      isDrawingRef.current = false;
      const stroke = currentStrokeRef.current;
      currentStrokeRef.current = null;
      onAddStroke(stroke);
      // onAddStroke may classify this as a text decoration and never commit
      // it into `strokes` (see Editor.tsx's handleAddStroke) - in that case
      // no prop change will trigger the base-layer redraw effect below, and
      // the just-finished raw stroke would stay rasterized on the live
      // layer until the next unrelated redraw. Clearing it here is a no-op
      // for the normal ink case (redrawBase() from the `strokes` effect
      // repaints the same pixels on the base layer moments later) but is
      // required for the decoration case.
      redrawLive();
    }
  }

  const cursor = tool === "eraser" ? "cell" : "crosshair";

  return (
    // pointerEvents "none" here, not just on the canvases: an ordinary div
    // defaults to "auto" and, positioned over the whole note, would swallow
    // every click/focus attempt into the editor underneath even while this
    // layer is otherwise fully transparent and inactive.
    <div ref={clipRef} className={className} style={{ pointerEvents: "none", overflow: "hidden" }}>
      <div ref={containerRef} style={{ position: "absolute", left: 0, right: 0 }}>
        <canvas ref={baseCanvasRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
        <canvas
          ref={liveCanvasRef}
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: active ? "auto" : "none",
            touchAction: active ? "none" : "auto",
            cursor,
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        />
      </div>
    </div>
  );
}
