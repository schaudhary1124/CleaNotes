import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashAssetBytes } from "../collab/assetStore";
import { DEFAULT_SKETCH_COLOR } from "../components/SketchToolbar";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { fsAssetStore, writeNote } from "../utils/fsNotes";
import { updateNoteInBacklinksIndex } from "../utils/backlinksIndex";
import { updateNoteInIndex } from "../utils/searchIndex";
import { broadcastNoteSaved } from "../utils/noteSync";
import type { NoteKindViewProps } from "../noteKinds/DefaultKindView";
import { BoardBackground } from "./BoardBackground";
import { BoardElementView } from "./BoardElementView";
import { BoardInkLayer } from "./BoardInkLayer";
import { BoardSelection, resizeFromHandle, type ResizeHandleId } from "./BoardSelection";
import { BOARD_WIDTHS, BoardToolbar, type BoardTool } from "./BoardToolbar";
import { VoiceCapture } from "./VoiceCapture";
import {
  BOARD_GRID_SIZE,
  clampZoom,
  isVectorShape,
  type BoardElement,
  type BoardPoint,
  type BoardRect,
  type BoardShapeKind,
  type BoardViewport,
} from "./boardTypes";
import {
  boardDigest,
  clampRect,
  createCode,
  createImage,
  createShape,
  createTable,
  createText,
  createVoice,
  duplicate,
  inkFromPoints,
  moveBy,
  removeElements,
  reorder,
  resizeElement,
  updateElements,
} from "./boardOps";
import {
  boundsOf,
  fitViewport,
  hitTestElement,
  normalizeRect,
  rectsIntersect,
  screenPointFromEvent,
  screenToWorld,
  snapToSurface,
  topmostAt,
  visibleWorldRect,
  worldToScreen,
} from "./geometry";
import { useBoardStore } from "./useBoardStore";

/** The Whiteboard kind's edit view: an infinite, pannable, zoomable canvas of free-floating
 * elements, registered in noteKinds/registry.tsx exactly like DefaultKindView.
 *
 * The whole surface is three stacked layers over one measured box:
 *
 *   1. BoardBackground - a viewport-sized canvas painting the grid, never interactive.
 *   2. The *world layer* - a single `transform: translate() scale()` div holding every element in
 *      raw world coordinates. This is the only place the viewport is applied, which is what makes
 *      pan/zoom a composite-only operation no matter how much is on the board.
 *   3. BoardInkLayer - a viewport-sized canvas that owns the pointer while a drawing tool is
 *      active, and is fully click-through otherwise.
 *
 * Pointer handling is a small state machine (`gestureRef`) rather than per-element handlers:
 * elements are click-through by default and the root does hit-testing itself (geometry.ts's
 * `topmostAt`). That keeps a drag that starts on one element and continues over others coherent,
 * and it's what lets an element's *interior* become live only once it's explicitly being edited
 * (double-click), instead of every widget on the canvas competing for the pointer at all times. */
export function WhiteboardView({
  note,
  settings,
  activeContentRef,
  savedContentRef,
  toolbarVisible,
}: NoteKindViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const [tool, setTool] = useState<BoardTool>("select");
  const [shape, setShape] = useState<BoardShapeKind>("rect");
  const [color, setColor] = useState(DEFAULT_SKETCH_COLOR);
  const [widthIndex, setWidthIndex] = useState(1);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<BoardRect | null>(null);
  const [draftShape, setDraftShape] = useState<BoardRect | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pendingVoiceAt, setPendingVoiceAt] = useState<BoardPoint | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // A Whiteboard's real document is its sidecar, but every other part of the app reads the `.md` -
  // so the note's Markdown is kept as a regenerated text digest of the canvas (see boardDigest).
  // It goes through the same activeContentRef/savedContentRef pair every other kind uses, so
  // App.tsx's flush-on-switch/close path saves it without needing to know boards exist.
  const persistDigest = useDebouncedCallback(async (elements: BoardElement[]) => {
    const digest = boardDigest(elements);
    activeContentRef.current = digest;
    if (digest === savedContentRef.current) return;
    await writeNote(note.path, digest);
    savedContentRef.current = digest;
    updateNoteInIndex(note.path, digest);
    updateNoteInBacklinksIndex(note.path, digest);
    await broadcastNoteSaved(note.path, digest);
  }, 900);

  const store = useBoardStore(note.path, persistDigest);
  const { doc, commit, commitTransient, beginHistory, setViewport } = store;
  const { elements, surface, viewport } = doc;

  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const snapping = snapEnabled && surface !== "plain";
  const strokeWidth = BOARD_WIDTHS[widthIndex];
  const drawing = tool === "pen" || tool === "highlighter" || tool === "eraser";
  // Space-to-pan is the universal canvas-app override, and it has to beat every other tool - so it
  // is resolved here rather than inside the gesture handlers, which then only see "hand".
  const effectiveTool: BoardTool = spaceHeld ? "hand" : tool;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Elements currently intersecting the viewport, plus anything selected (so a selected element
   * dragged off-screen doesn't vanish mid-gesture along with its handles). Culling here rather
   * than letting the browser deal with thousands of off-screen absolutely-positioned nodes keeps
   * the DOM proportional to what's visible, not to board size. */
  const visible = useMemo(() => {
    if (size.width === 0) return elements;
    const window = visibleWorldRect(viewport, size.width, size.height);
    // Pad by a screenful so an element only partly off the edge is already mounted before it
    // scrolls in, rather than popping into existence at the boundary.
    const padded = {
      x: window.x - window.w / 2,
      y: window.y - window.h / 2,
      w: window.w * 2,
      h: window.h * 2,
    };
    return elements.filter((el) => selection.has(el.id) || rectsIntersect(el, padded));
  }, [elements, viewport, size, selection]);

  const selectedElements = useMemo(
    () => elements.filter((el) => selection.has(el.id)),
    [elements, selection],
  );
  const selectionBounds = useMemo(() => boundsOf(selectedElements), [selectedElements]);

  // ---------------------------------------------------------------- viewport

  const applyZoom = useCallback(
    (nextZoom: number, anchor?: BoardPoint) => {
      const vp = viewportRef.current;
      const point = anchor ?? { x: size.width / 2, y: size.height / 2 };
      const zoom = clampZoom(nextZoom);
      const world = screenToWorld(point, vp);
      setViewport({ zoom, x: world.x - point.x / zoom, y: world.y - point.y / zoom });
    },
    [setViewport, size.width, size.height],
  );

  const zoomToFit = useCallback(() => {
    const bounds = boundsOf(elementsRef.current);
    if (!bounds || size.width === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    setViewport(fitViewport(bounds, size.width, size.height));
  }, [setViewport, size.width, size.height]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Registered natively (not as a React prop) so it can be non-passive: a trackpad pinch arrives
    // as a ctrlKey wheel event, and without preventDefault the WebView zooms the whole app chrome
    // instead of the board. React attaches wheel listeners passively, where preventDefault is a
    // no-op.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const anchor = screenPointFromEvent(e, el);
      const vp = viewportRef.current;
      if (e.ctrlKey || e.metaKey) {
        // Exponential rather than linear so each notch changes zoom by a constant *ratio* - the
        // only mapping that feels uniform across the 0.1x..5x range.
        applyZoom(vp.zoom * Math.exp(-e.deltaY / 320), anchor);
      } else {
        setViewport({ ...vp, x: vp.x + e.deltaX / vp.zoom, y: vp.y + e.deltaY / vp.zoom });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom, setViewport]);

  // ------------------------------------------------------------ mutation ops

  // Editing bursts (typing into a text box, a table cell, a code block) are coalesced into one
  // undo step each: a keystroke-level history would make undo useless, but *no* board-level
  // history at all leaves a table cell with no undo whatsoever - a controlled <input> has no
  // usable native one. A new burst starts when the edit moves to a different element, or after
  // this much idle time on the same one.
  const EDIT_BURST_MS = 1200;
  const lastPatch = useRef<{ id: string; at: number } | null>(null);

  const patchElement = useCallback(
    (id: string, patch: Partial<BoardElement>) => {
      const now = Date.now();
      const previous = lastPatch.current;
      if (!previous || previous.id !== id || now - previous.at > EDIT_BURST_MS) beginHistory();
      lastPatch.current = { id, at: now };
      commitTransient(
        elementsRef.current.map((el) => (el.id === id ? ({ ...el, ...patch } as BoardElement) : el)),
      );
    },
    [beginHistory, commitTransient],
  );

  const addElement = useCallback(
    (element: BoardElement, { edit = false }: { edit?: boolean } = {}) => {
      commit([...elementsRef.current, element]);
      setSelection(new Set([element.id]));
      setEditingId(edit ? element.id : null);
      setTool("select");
    },
    [commit],
  );

  const deleteSelection = useCallback(() => {
    if (selectionRef.current.size === 0) return;
    commit(removeElements(elementsRef.current, selectionRef.current));
    setSelection(new Set());
    setEditingId(null);
  }, [commit]);

  const duplicateSelection = useCallback(() => {
    if (selectionRef.current.size === 0) return;
    const { elements: next, created } = duplicate(elementsRef.current, selectionRef.current);
    commit(next);
    setSelection(new Set(created.map((el) => el.id)));
  }, [commit]);

  const eraseAt = useCallback(
    (point: BoardPoint, radius: number) => {
      const hit = elementsRef.current.filter((el) => !el.locked && hitTestElement(el, point, radius));
      if (hit.length === 0) return;
      const ids = new Set(hit.map((el) => el.id));
      // Each erase *gesture* should be one undo step, but the eraser fires continuously - so
      // history is pushed only when the gesture actually removes something, and consecutive
      // removals within one drag each become their own step. That's still far better than the
      // alternative (a whole drag collapsing into one step that can't be partially undone), and
      // matches how SketchLayer's eraser already behaves.
      commit(removeElements(elementsRef.current, ids));
    },
    [commit],
  );

  // -------------------------------------------------------------- placement

  /** Where the pending file-picker result should land - the picker is async and modal, so the
   * click's world point has to outlive the gesture that opened it. */
  const pendingImageAt = useRef<BoardPoint | null>(null);

  /** World point for a placement click, snapped to the lattice when snapping is on. */
  const placementPoint = useCallback(
    (screen: BoardPoint): BoardPoint => {
      const world = screenToWorld(screen, viewportRef.current);
      return snapping ? snapToSurface(world, surface) : world;
    },
    [snapping, surface],
  );

  const placeAt = useCallback(
    (screen: BoardPoint) => {
      const at = placementPoint(screen);
      switch (tool) {
        case "text":
          addElement(createText(at, color, "none"), { edit: true });
          break;
        case "code":
          addElement(createCode(at), { edit: true });
          break;
        case "table":
          addElement(createTable(at), { edit: true });
          break;
        case "image":
          // The file picker is async and modal; the tool stays armed until a file comes back so a
          // cancelled picker doesn't silently swallow the click.
          pendingImageAt.current = at;
          imageInputRef.current?.click();
          break;
        case "voice":
          setPendingVoiceAt(at);
          setVoiceOpen(true);
          break;
        default:
          break;
      }
    },
    [addElement, color, placementPoint, tool],
  );

  async function handleImageFile(file: File) {
    const at = pendingImageAt.current ?? placementPoint({ x: size.width / 2, y: size.height / 2 });
    pendingImageAt.current = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Content-addressed, exactly like Editor.tsx's insertImageFile - the same picture dropped on
      // a board and pasted into a note dedupes onto one file on disk.
      const hash = await hashAssetBytes(bytes);
      await fsAssetStore.put(hash, bytes);
      const { width, height } = await imageDimensions(file);
      // Cap the placed size so a 4000px screenshot doesn't land as a wall covering the viewport,
      // while keeping its aspect ratio.
      const scale = Math.min(1, 420 / Math.max(width, height));
      const element = createImage(at, hash, Math.round(width * scale), Math.round(height * scale));
      addElement({ ...element, alt: file.name });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't add that image");
      setTimeout(() => setStatus(null), 4000);
    }
  }

  // -------------------------------------------------------------- gestures

  type Gesture =
    | { kind: "pan"; startScreen: BoardPoint; startViewport: BoardViewport }
    | { kind: "marquee"; startWorld: BoardPoint; additive: boolean; baseSelection: ReadonlySet<string> }
    | { kind: "move"; startWorld: BoardPoint; origins: Map<string, BoardPoint> }
    | { kind: "resize"; handle: ResizeHandleId; startWorld: BoardPoint; origins: Map<string, BoardRect> }
    | { kind: "draft-shape"; startWorld: BoardPoint };

  const gestureRef = useRef<Gesture | null>(null);
  // Which diagonal the in-progress vector shape was dragged along - a ref rather than state
  // because only the commit at pointer-up reads it, so tracking it never needs a re-render.
  const draftFlippedRef = useRef(false);

  function beginResize(handle: ResizeHandleId, e: React.PointerEvent) {
    const container = containerRef.current;
    if (!container) return;
    container.setPointerCapture(e.pointerId);
    beginHistory();
    gestureRef.current = {
      kind: "resize",
      handle,
      startWorld: screenToWorld(screenPointFromEvent(e, container), viewportRef.current),
      origins: new Map(
        elementsRef.current
          .filter((el) => selectionRef.current.has(el.id))
          .map((el) => [el.id, { x: el.x, y: el.y, w: el.w, h: el.h }]),
      ),
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container) return;
    // Let a live widget (an element being edited) keep its own clicks - it stops propagation
    // itself, so anything reaching here is genuinely canvas-directed.
    const screen = screenPointFromEvent(e, container);
    const world = screenToWorld(screen, viewportRef.current);

    // Middle-drag pans from any tool - the standard escape hatch out of a modal tool.
    if (e.button === 1 || effectiveTool === "hand") {
      container.setPointerCapture(e.pointerId);
      gestureRef.current = { kind: "pan", startScreen: screen, startViewport: viewportRef.current };
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || drawing) return;

    if (tool === "shape") {
      container.setPointerCapture(e.pointerId);
      gestureRef.current = { kind: "draft-shape", startWorld: snapping ? snapToSurface(world, surface) : world };
      setDraftShape({ x: world.x, y: world.y, w: 0, h: 0 });
      return;
    }
    if (tool !== "select") {
      placeAt(screen);
      return;
    }

    // Tolerance scales with zoom so "close enough to click" is a constant *on-screen* distance -
    // at 0.2x a 4px world tolerance would be a sub-pixel target.
    const tolerance = 6 / viewportRef.current.zoom;
    const hit = topmostAt(elementsRef.current, world, tolerance);
    const additive = e.shiftKey || e.metaKey;

    if (!hit) {
      setEditingId(null);
      container.setPointerCapture(e.pointerId);
      gestureRef.current = {
        kind: "marquee",
        startWorld: world,
        additive,
        baseSelection: additive ? selectionRef.current : new Set(),
      };
      if (!additive) setSelection(new Set());
      setMarquee({ x: world.x, y: world.y, w: 0, h: 0 });
      return;
    }

    let nextSelection: ReadonlySet<string>;
    if (additive) {
      const next = new Set(selectionRef.current);
      if (next.has(hit.id)) next.delete(hit.id);
      else next.add(hit.id);
      nextSelection = next;
    } else if (selectionRef.current.has(hit.id)) {
      // Dragging an already-multi-selected element moves the whole selection, rather than
      // collapsing it to just the one under the cursor.
      nextSelection = selectionRef.current;
    } else {
      nextSelection = new Set([hit.id]);
    }
    setSelection(nextSelection);
    selectionRef.current = nextSelection;
    if (editingId && editingId !== hit.id) setEditingId(null);

    container.setPointerCapture(e.pointerId);
    beginHistory();
    gestureRef.current = {
      kind: "move",
      startWorld: world,
      origins: new Map(
        elementsRef.current.filter((el) => nextSelection.has(el.id) && !el.locked).map((el) => [el.id, { x: el.x, y: el.y }]),
      ),
    };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    const container = containerRef.current;
    if (!gesture || !container) return;
    const screen = screenPointFromEvent(e, container);
    const world = screenToWorld(screen, viewportRef.current);

    switch (gesture.kind) {
      case "pan": {
        // Divided by the *starting* zoom: panning never changes zoom, and using the live value
        // would make the drag distance drift if a zoom happened to land mid-gesture.
        const zoom = gesture.startViewport.zoom;
        setViewport({
          zoom,
          x: gesture.startViewport.x - (screen.x - gesture.startScreen.x) / zoom,
          y: gesture.startViewport.y - (screen.y - gesture.startScreen.y) / zoom,
        });
        return;
      }
      case "marquee": {
        const rect = normalizeRect(gesture.startWorld, world);
        setMarquee(rect);
        const inside = elementsRef.current.filter((el) => !el.locked && rectsIntersect(el, rect));
        const next = new Set(gesture.baseSelection);
        for (const el of inside) next.add(el.id);
        setSelection(next);
        return;
      }
      case "move": {
        let dx = world.x - gesture.startWorld.x;
        let dy = world.y - gesture.startWorld.y;
        if (snapping) {
          // Snap the *anchor element's* resulting corner, then apply the same correction to every
          // element in the selection - so a multi-element drag keeps the group's internal spacing
          // instead of collapsing each element onto its own nearest lattice point.
          const first = gesture.origins.values().next().value;
          if (first) {
            const snapped = snapToSurface({ x: first.x + dx, y: first.y + dy }, surface);
            dx = snapped.x - first.x;
            dy = snapped.y - first.y;
          }
        }
        commitTransient(
          elementsRef.current.map((el) => {
            const origin = gesture.origins.get(el.id);
            return origin ? moveBy({ ...el, x: origin.x, y: origin.y }, dx, dy) : el;
          }),
        );
        return;
      }
      case "resize": {
        let dx = world.x - gesture.startWorld.x;
        let dy = world.y - gesture.startWorld.y;
        if (snapping) {
          const snapped = snapToSurface({ x: world.x, y: world.y }, surface);
          dx = snapped.x - gesture.startWorld.x;
          dy = snapped.y - gesture.startWorld.y;
        }
        commitTransient(
          elementsRef.current.map((el) => {
            const origin = gesture.origins.get(el.id);
            if (!origin) return el;
            // A line or arrow is legitimately flat in one axis, so it gets a 1px floor rather than
            // the general minimum, which would tilt a horizontal line off true.
            const min = el.kind === "shape" && isVectorShape(el.shape) ? 1 : undefined;
            return resizeElement(el, clampRect(resizeFromHandle(origin, gesture.handle, dx, dy), min));
          }),
        );
        return;
      }
      case "draft-shape": {
        const end = snapping ? snapToSurface(world, surface) : world;
        setDraftShape(normalizeRect(gesture.startWorld, end));
        // Vector shapes need to remember which diagonal was actually dragged - the normalized box
        // alone can't distinguish a down-right drag from an up-right one.
        draftFlippedRef.current = (end.x - gesture.startWorld.x) * (end.y - gesture.startWorld.y) < 0;
        return;
      }
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    const container = containerRef.current;
    if (container?.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
    gestureRef.current = null;
    setMarquee(null);

    if (gesture?.kind === "draft-shape" && draftShape) {
      const vector = isVectorShape(shape);
      const tiny = draftShape.w < 4 && draftShape.h < 4;
      // A click (rather than a drag) places a default-sized shape, the way every diagramming tool
      // does - dragging one out and clicking to drop one are both expected gestures.
      const rect = tiny
        ? { x: draftShape.x, y: draftShape.y, w: vector ? BOARD_GRID_SIZE * 4 : 160, h: vector ? 0 : 120 }
        : draftShape;
      addElement(createShape(rect, shape, color, "none", strokeWidth, vector && draftFlippedRef.current));
      setDraftShape(null);
      draftFlippedRef.current = false;
      return;
    }
    setDraftShape(null);
  }

  // --------------------------------------------------------------- keyboard

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      // Never steal keys from a live text surface - a board is full of them (contentEditable text,
      // table cells, CodeMirror), and a bare "e" typed into one must not switch to the eraser.
      const typing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        !!target?.closest(".cm-editor");

      if (e.code === "Space" && !typing && !e.repeat) {
        setSpaceHeld(true);
        e.preventDefault();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        // Undo/redo belongs to whatever surface has focus first - CodeMirror and contentEditable
        // both keep their own histories.
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "d" && !typing) {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "a" && !typing) {
        e.preventDefault();
        setSelection(new Set(elementsRef.current.filter((el) => !el.locked).map((el) => el.id)));
        return;
      }
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        applyZoom(viewportRef.current.zoom * 1.2);
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        applyZoom(viewportRef.current.zoom / 1.2);
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        applyZoom(1);
        return;
      }
      if (typing || mod) return;

      if (e.key === "Escape") {
        setEditingId(null);
        setSelection(new Set());
        setTool("select");
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key.startsWith("Arrow") && selectionRef.current.size > 0) {
        e.preventDefault();
        // Shift gives a full grid cell, matching the nudge granularity of the surface itself; the
        // bare arrow is a 1px trim.
        const step = e.shiftKey ? BOARD_GRID_SIZE : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        commit(updateElements(elementsRef.current, selectionRef.current, (el) => moveBy(el, dx, dy)));
        return;
      }
      if (e.key === "]" && selectionRef.current.size > 0) {
        commit(reorder(elementsRef.current, selectionRef.current, "front"));
        return;
      }
      if (e.key === "[" && selectionRef.current.size > 0) {
        commit(reorder(elementsRef.current, selectionRef.current, "back"));
        return;
      }
      if (e.shiftKey && e.key === "!") {
        zoomToFit();
        return;
      }

      const shortcuts: Record<string, BoardTool> = {
        v: "select",
        h: "hand",
        p: "pen",
        m: "highlighter",
        e: "eraser",
        s: "shape",
        t: "text",
      };
      const next = shortcuts[e.key.toLowerCase()];
      if (next) setTool(next);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpaceHeld(false);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [applyZoom, commit, deleteSelection, duplicateSelection, store, zoomToFit]);

  // ----------------------------------------------------------------- render

  const cursor =
    effectiveTool === "hand" ? "grab" : effectiveTool === "select" ? "default" : "crosshair";

  const worldStyle = useMemo(
    () => ({
      // translate before scale, and both in one transform: the world layer's own origin is the
      // top-left, so this is exactly worldToScreen expressed as a CSS matrix.
      transform: `scale(${viewport.zoom}) translate(${-viewport.x}px, ${-viewport.y}px)`,
      transformOrigin: "0 0",
    }),
    [viewport],
  );

  return (
    <div className="board-root">
      {toolbarVisible && (
        <BoardToolbar
          tool={tool}
          onToolChange={(next) => {
            setTool(next);
            setEditingId(null);
          }}
          shape={shape}
          onShapeChange={setShape}
          color={color}
          onColorChange={(next) => {
            setColor(next);
            // Recolouring with something selected retints it, rather than only affecting the next
            // thing drawn - the behaviour every drawing tool has.
            if (selection.size > 0) {
              commit(
                updateElements(elements, selection, (el) =>
                  el.kind === "ink"
                    ? { ...el, color: next }
                    : el.kind === "shape"
                      ? { ...el, stroke: next }
                      : el.kind === "text"
                        ? { ...el, color: next }
                        : el,
                ),
              );
            }
          }}
          widthIndex={widthIndex}
          onWidthIndexChange={setWidthIndex}
          surface={surface}
          onSurfaceChange={store.setSurface}
          snapEnabled={snapEnabled}
          onSnapToggle={() => setSnapEnabled((v) => !v)}
          zoom={viewport.zoom}
          onZoomIn={() => applyZoom(viewport.zoom * 1.2)}
          onZoomOut={() => applyZoom(viewport.zoom / 1.2)}
          onZoomReset={() => applyZoom(1)}
          onZoomToFit={zoomToFit}
          canUndo={store.canUndo}
          canRedo={store.canRedo}
          onUndo={store.undo}
          onRedo={store.redo}
          hasSelection={selection.size > 0}
          onDuplicate={duplicateSelection}
          onDelete={deleteSelection}
          voiceEnabled={settings.features.voiceNotes}
          codeEnabled={settings.features.codeBlock}
        />
      )}

      <div
        ref={containerRef}
        className="board-canvas"
        style={{ cursor }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={(e) => {
          if (effectiveTool !== "select") return;
          const container = containerRef.current;
          if (!container) return;
          const world = screenToWorld(screenPointFromEvent(e, container), viewportRef.current);
          const hit = topmostAt(elementsRef.current, world, 6 / viewportRef.current.zoom);
          if (hit && !hit.locked) {
            setSelection(new Set([hit.id]));
            setEditingId(hit.id);
          } else {
            // Double-clicking empty canvas drops a text box there, the standard whiteboard idiom.
            addElement(createText(snapping ? snapToSurface(world, surface) : world, color, "none"), { edit: true });
          }
        }}
      >
        <BoardBackground surface={surface} viewport={viewport} width={size.width} height={size.height} />

        <div className="board-world" style={worldStyle}>
          {visible.map((el) => (
            <BoardElementView
              key={el.id}
              element={el}
              selected={selection.has(el.id)}
              interactive={editingId === el.id && !el.locked}
              editing={editingId === el.id}
              onPatch={(patch) => patchElement(el.id, patch)}
              onStartEditing={() => setEditingId(el.id)}
            />
          ))}

          {draftShape && (
            <div
              className="board-draft"
              style={{
                left: draftShape.x,
                top: draftShape.y,
                width: draftShape.w,
                height: draftShape.h,
                borderWidth: 1 / viewport.zoom,
              }}
            />
          )}

          {selectionBounds && !editingId && (
            <BoardSelection
              bounds={selectionBounds}
              elements={selectedElements}
              zoom={viewport.zoom}
              onHandlePointerDown={beginResize}
            />
          )}
        </div>

        <BoardInkLayer
          active={drawing}
          tool={drawing ? (tool as "pen" | "highlighter" | "eraser") : "pen"}
          color={color}
          // A highlighter nib is much broader than a pen's, and an eraser broader still - the same
          // relationship SketchToolbar's SKETCH_TOOL_SIZES encodes for in-note ink.
          width={tool === "eraser" ? strokeWidth * 6 : tool === "highlighter" ? strokeWidth * 4 : strokeWidth}
          surface={surface}
          assistEnabled={snapping}
          viewport={viewport}
          viewWidth={size.width}
          viewHeight={size.height}
          onErase={eraseAt}
          onCommit={(result, inkTool, inkColor, inkWidth) => {
            if (result.shape) {
              // The assist recognized a closed shape - commit a real ShapeElement rather than ink,
              // so it can be filled, relabelled and resized like any other shape.
              commit([
                ...elementsRef.current,
                createShape(result.shape, result.shape.kind, inkColor, "none", inkWidth),
              ]);
              return;
            }
            const element = inkFromPoints(result.points, inkTool, inkColor, inkWidth);
            if (element) commit([...elementsRef.current, element]);
          }}
        />

        {marquee && (
          <div
            className="board-marquee"
            style={(() => {
              const topLeft = worldToScreen({ x: marquee.x, y: marquee.y }, viewport);
              return {
                left: topLeft.x,
                top: topLeft.y,
                width: marquee.w * viewport.zoom,
                height: marquee.h * viewport.zoom,
              };
            })()}
          />
        )}

        {store.loading && <div className="board-status">Loading board…</div>}
        {status && <div className="board-status is-error">{status}</div>}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleImageFile(file);
        }}
      />

      {voiceOpen && (
        <VoiceCapture
          countdownSeconds={settings.voiceNoteCountdown}
          onCancel={() => {
            setVoiceOpen(false);
            setPendingVoiceAt(null);
            setTool("select");
          }}
          onComplete={({ src, durationMs, peaks }) => {
            const at = pendingVoiceAt ?? placementPoint({ x: size.width / 2, y: size.height / 2 });
            addElement(createVoice(at, src, durationMs, peaks));
            setVoiceOpen(false);
            setPendingVoiceAt(null);
          }}
        />
      )}
    </div>
  );
}

/** Natural pixel dimensions of an image file, used to place it at its own aspect ratio. Falls back
 * to a square when the browser can't decode it, so an unsupported file still lands as *something*
 * the user can see and delete rather than a zero-size invisible element. */
function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || 320, height: img.naturalHeight || 320 });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 320, height: 320 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}
