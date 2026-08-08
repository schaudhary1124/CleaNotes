import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { BoardBackground } from "./BoardBackground";
import { BoardElementView } from "./BoardElementView";
import { BoardInkLayer } from "./BoardInkLayer";
import {
  BoardSelection,
  flipAfterResize,
  handleAt,
  resizeFromHandle,
  type ResizeHandleId,
  type SelectionHandle,
} from "./BoardSelection";
import { BoardToolbar } from "./BoardToolbar";
import { VoiceCapture } from "./VoiceCapture";
import {
  BOARD_TOOL_SIZES,
  boardToolSize,
  defaultBoardToolSettings,
  fillColor,
  textBackgroundColor,
  type BoardEraserMode,
  type BoardEraserShape,
  type BoardFillStyle,
  type BoardSizedTool,
  type BoardTextStyle,
  type BoardTool,
  type BoardToolActions,
  type BoardToolSettings,
} from "./boardTools";
import {
  BOARD_GRID_SIZE,
  clampZoom,
  isVectorShape,
  lineEndpoints,
  type BoardElement,
  type BoardPoint,
  type BoardRect,
  type BoardShapeKind,
  type BoardStrokeStyle,
  type BoardViewport,
  type InkElement,
  type ShapeElement,
} from "./boardTypes";
import {
  clampRect,
  createCode,
  createImage,
  createShape,
  createTable,
  createText,
  createVoice,
  duplicate,
  eraseInk,
  inkFromPoints,
  moveBy,
  removeElements,
  reorder,
  resizeElement,
  retargetShape,
  setLineEndpoints,
  updateElements,
  type NewTextStyle,
} from "./boardOps";
import {
  boundsOf,
  elementTouchesRegion,
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
  type EraserRegion,
} from "./geometry";
import { putAsset, type BoardAssets } from "./useAssetUrl";
import type { BoardStore } from "./useBoardStore";

/** How far from a resize handle's centre, in *screen* px, a press still counts as grabbing it. Wider
 * than the 10px square that is drawn: a handle sits right at the edge of its element, so a miss
 * lands on empty canvas and starts a marquee - which clears the selection, hides the handles, and
 * re-selects as the band sweeps back over the element. Forgiving the near miss is what stops a
 * resize from turning into that. */
const HANDLE_GRAB_PX = 11;

/** How far, in *screen* px, a press may travel and still count as a click rather than a drag - the
 * distinction that decides whether releasing over an already-selected element opens it for editing
 * or simply ends a (possibly very short) move. Sized for a hand holding a mouse or a stylus, where
 * a "stationary" press still wanders a pixel or two. */
const CLICK_SLOP_PX = 4;

/** The board editing surface itself: an infinite, pannable, zoomable canvas of free-floating
 * elements.
 *
 * Deliberately knows nothing about where its document comes from or where assets live - both
 * arrive as injected `store`/`assets`. That is what lets the same component serve all three
 * places a board is edited (the owner's vault via WhiteboardView, a desktop collaborator and a
 * browser collaborator via SharedBoardView), and it is why this lives in its own module: the
 * owner-side wrapper imports fsNotes.ts, and a browser guest reaching that import - even
 * transitively - fails the bundle's Tauri-isolation check outright (scripts/check-browser-bundle.mjs).
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
 * and it's what lets an element's *interior* become live only once it's explicitly being edited,
 * instead of every widget on the canvas competing for the pointer at all times. Opening one is the
 * standard two-stage canvas gesture - click to select, click the selection again (or double-click
 * outright) to work inside it - implemented on the `move` gesture's `enterEdit`, since only
 * pointer-*up* knows whether a press turned out to be a drag.
 *
 * `BoardElement` is still imported as a type only - no value import here reaches the filesystem. */
export function BoardWorkspace({
  store,
  assets,
  canEdit,
  toolbarVisible,
  voiceEnabled,
  codeEnabled,
  voiceNoteCountdown,
}: {
  store: BoardStore;
  assets: BoardAssets;
  /** False for a collaborator the owner has set to viewer, or while the note is locked. Hides
   * every mutating affordance and drops the board to pan/zoom only - enforcement itself still
   * lives on the owner's device (see hostSession.ts), this is purely local UI. */
  canEdit: boolean;
  toolbarVisible: boolean;
  voiceEnabled: boolean;
  codeEnabled: boolean;
  voiceNoteCountdown: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const [tool, setTool] = useState<BoardTool>("select");
  /** What the *next* thing drawn looks like: colour, per-tool sizes, brush/shape/text options. All
   * local to this device - none of it is document state (see BoardToolSettings). */
  const [settings, setSettings] = useState<BoardToolSettings>(defaultBoardToolSettings);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<BoardRect | null>(null);
  const [draftShape, setDraftShape] = useState<BoardRect | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pendingVoiceAt, setPendingVoiceAt] = useState<BoardPoint | null>(null);
  /** Element id when the recorder was opened from an existing voice note's "Record more", null when
   * it was opened to place a new one - the one thing that decides what happens at the end of a
   * recording, so it is tracked rather than inferred. */
  const [appendVoiceTo, setAppendVoiceTo] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const { doc, commit, commitTransient, beginHistory, setViewport } = store;
  const { elements, surface, viewport } = doc;

  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // Read by the pointer/erase handlers, which are recreated per gesture rather than per settings
  // change - a stale closure here would erase with the previous nib or place the previous style.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const snapping = snapEnabled && surface !== "plain";
  const { color, shape } = settings;
  // Which size table the ink layer should read: the drawing tools each keep their own preset index,
  // so a broad highlighter no longer implies a fat pen.
  const inkSizedTool: BoardSizedTool =
    tool === "highlighter" ? "highlighter" : tool === "eraser" ? "eraser" : "pen";
  const inkWidth = boardToolSize(settings, inkSizedTool);
  const shapeStrokeWidth = boardToolSize(settings, "shape");
  // A viewer gets pan/zoom and nothing else: the ink layer never takes the pointer, placement
  // gestures no-op, and the toolbar hides its editing half. Resolved once here so every gesture
  // below reads a single flag rather than re-checking `canEdit` in a dozen places.
  const drawing = canEdit && (tool === "pen" || tool === "highlighter" || tool === "eraser");
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
    /** The DOM box of the topmost *selected* element under `anchor`, if there is one.
     *
     * Selection, rather than mere hover, is the gate: an unselected widget the pointer happens to
     * be over has no claim on the wheel, or every pan that crossed a code block would stall on it.
     * Hit-tested through the board's own geometry rather than through `e.target` because an
     * element that isn't open for editing is `pointer-events: none` (see .board-element in
     * index.css) and so never appears as an event target - which is exactly the case this exists
     * to serve, a selected widget the user wants to scroll without clicking into it first.
     *
     * Restricted to the selection rather than reusing topmostAt, which answers a different
     * question: an unselected element stacked over a selected table would be topmost, but it is
     * click-through and inert, so letting it block the table's scroll would be arbitrary. */
    const selectedBoxAt = (anchor: BoardPoint): Element | null => {
      const selected = selectionRef.current;
      // By far the most common wheel is a pan with nothing selected, and it shouldn't pay for a
      // walk of the board to discover there was nothing to scroll.
      if (selected.size === 0) return null;
      const world = screenToWorld(anchor, viewportRef.current);
      const elements = elementsRef.current;
      // Back-to-front, like topmostAt, so two stacked selected widgets resolve the way they look.
      for (let i = elements.length - 1; i >= 0; i--) {
        const candidate = elements[i];
        if (!selected.has(candidate.id) || !hitTestElement(candidate, world, 0)) continue;
        return el.querySelector(`[data-element-id="${candidate.id}"]`);
      }
      return null;
    };

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
        return;
      }
      // A widget whose content outgrew its frame owns the wheel over its own box: panning the
      // board out from under a half-read code block is never what the gesture meant, and until
      // this existed there was no way to reach the rest of that content at all - the board just
      // slid away underneath it.
      const scroller = wheelScroller(e.target, () => selectedBoxAt(anchor), e.deltaX, e.deltaY);
      if (scroller) {
        // Divided by zoom for the same reason the pan below is: scroll offsets are in the pane's
        // own untransformed units, so a screen-space delta has to be converted before the content
        // travels exactly as far as the fingers did.
        scroller.scrollLeft += e.deltaX / vp.zoom;
        scroller.scrollTop += e.deltaY / vp.zoom;
        return;
      }
      setViewport({ ...vp, x: vp.x + e.deltaX / vp.zoom, y: vp.y + e.deltaY / vp.zoom });
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
        elementsRef.current.map((el) => (el.id === id ? applyPatch(el, patch) : el)),
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

  /** Whether this erase gesture has already pushed its undo snapshot. One snapshot per gesture,
   * taken lazily at the first actual removal: the eraser fires on every pointer sample, so pushing
   * per sample would bury the rest of the history under dozens of steps, and pushing eagerly at
   * pointer-down would leave a no-op undo step behind every eraser drag that hit nothing. */
  const erasedThisGesture = useRef(false);

  const eraseAt = useCallback(
    (region: EraserRegion) => {
      const current = elementsRef.current;
      const mode = settingsRef.current.eraserMode;
      let next: BoardElement[];

      if (mode === "partial") {
        // Only ink can be cut: "half an image" has no meaning, and quietly deleting the whole thing
        // while the user asked for a partial erase is the surprising outcome (see BoardEraserMode).
        next = [];
        let changed = false;
        for (const el of current) {
          if (el.locked || el.kind !== "ink") {
            next.push(el);
            continue;
          }
          const pieces = eraseInk(el, region);
          if (!pieces) {
            next.push(el);
            continue;
          }
          changed = true;
          next.push(...pieces);
        }
        if (!changed) return;
      } else {
        const hit = current.filter((el) => !el.locked && elementTouchesRegion(el, region));
        if (hit.length === 0) return;
        next = removeElements(current, new Set(hit.map((el) => el.id)));
      }

      if (!erasedThisGesture.current) {
        beginHistory();
        erasedThisGesture.current = true;
      }
      // Erasing can remove a selected element; dropping it from the selection keeps the resize
      // handles from hanging over empty canvas.
      setSelection((previous) => {
        if (previous.size === 0) return previous;
        const surviving = new Set(next.map((el) => el.id));
        if ([...previous].every((id) => surviving.has(id))) return previous;
        return new Set([...previous].filter((id) => surviving.has(id)));
      });
      commitTransient(next);
    },
    [beginHistory, commitTransient],
  );

  // --------------------------------------------------------- tool option state

  /** Restyles the current selection to match a tool option that just changed - the behaviour every
   * drawing tool has, where picking a colour or a width with something selected restyles it rather
   * than only affecting the next thing drawn. A no-op when nothing is selected, or when the change
   * doesn't apply to any selected element (picking a font with only shapes selected), so an option
   * click never pushes an undo step that changes nothing. */
  const restyleSelection = useCallback(
    (patch: (el: BoardElement) => BoardElement) => {
      const ids = selectionRef.current;
      if (ids.size === 0) return;
      const current = elementsRef.current;
      const next = updateElements(current, ids, patch);
      if (next.every((el, index) => el === current[index])) return;
      commit(next);
    },
    [commit],
  );

  const actions: BoardToolActions = useMemo(
    () => ({
      setColor: (color: string) => {
        setSettings((s) => ({ ...s, color }));
        // Each branch returns the element untouched when it already looks that way, so re-clicking
        // the option a selected element is already set to doesn't push an undo step that does
        // nothing (see restyleSelection, which only commits when a reference actually changed).
        restyleSelection((el) => {
          if (el.kind === "ink" || el.kind === "text") {
            return el.color === color ? el : { ...el, color };
          }
          if (el.kind !== "shape") return el;
          // A filled shape keeps its own fill *style* through a recolour - detected by whether the
          // stored colour carries an alpha, which is what fillColor produces for a tint.
          const fill =
            el.fill === "none" ? "none" : fillColor(el.fill.startsWith("rgba") ? "tint" : "solid", color);
          return el.stroke === color && el.fill === fill ? el : { ...el, stroke: color, fill };
        });
      },
      setSize: (sized: BoardSizedTool, index: number) => {
        setSettings((s) => ({ ...s, sizes: { ...s.sizes, [sized]: index } }));
        if (sized === "eraser") return; // the nib size styles nothing already on the canvas
        const size = BOARD_TOOL_SIZES[sized][index];
        restyleSelection((el) => {
          if (sized === "shape") {
            return el.kind === "shape" && el.strokeWidth !== size ? { ...el, strokeWidth: size } : el;
          }
          const inkTool = sized === "highlighter" ? "highlighter" : "pen";
          const applies = el.kind === "ink" && el.tool === inkTool && el.width !== size;
          return applies ? withInkWidth(el as InkElement, size) : el;
        });
      },
      setPenStyle: (style: BoardStrokeStyle) => {
        setSettings((s) => ({ ...s, penStyle: style }));
        restyleSelection((el) => (el.kind === "ink" ? withDash(el, style) : el));
      },
      setShape: (shape: BoardShapeKind) => {
        setSettings((s) => ({ ...s, shape }));
        // With a shape selected the picker converts it, rather than only deciding what the next one
        // will be - the whole point of the selection panel (see retargetShape).
        restyleSelection((el) =>
          el.kind === "shape" && el.shape !== shape ? retargetShape(el, shape) : el,
        );
      },
      setShapeStyle: (style: BoardStrokeStyle) => {
        setSettings((s) => ({ ...s, shapeStyle: style }));
        restyleSelection((el) => (el.kind === "shape" ? withDash(el, style) : el));
      },
      setFill: (fill: BoardFillStyle) => {
        setSettings((s) => ({ ...s, fill }));
        restyleSelection((el) => {
          if (el.kind !== "shape") return el;
          const next = fillColor(fill, el.stroke);
          return el.fill === next ? el : { ...el, fill: next };
        });
      },
      setEraserShape: (eraserShape: BoardEraserShape) => setSettings((s) => ({ ...s, eraserShape })),
      setEraserMode: (eraserMode: BoardEraserMode) => setSettings((s) => ({ ...s, eraserMode })),
      setTextStyle: (patch: Partial<BoardTextStyle>) => {
        setSettings((s) => ({ ...s, text: { ...s.text, ...patch } }));
        // Only the keys the user actually touched are applied to the selection: pushing the whole
        // merged style would silently overwrite a selected box's size just because it was italicized.
        restyleSelection((el) => {
          if (el.kind !== "text") return el;
          const next = { ...el };
          let changed = false;
          if (patch.fontSize !== undefined && patch.fontSize !== el.fontSize) {
            next.fontSize = patch.fontSize;
            // Grow the box to hold a line of the new size, but never shrink it - the user may have
            // sized it deliberately.
            next.h = Math.max(el.h, Math.round(patch.fontSize * 2.6));
            changed = true;
          }
          if (patch.align !== undefined && patch.align !== el.align) {
            next.align = patch.align;
            changed = true;
          }
          if (patch.fontFamily !== undefined && patch.fontFamily !== (el.fontFamily ?? "sans")) {
            next.fontFamily = patch.fontFamily;
            changed = true;
          }
          if (patch.bold !== undefined && patch.bold !== !!el.bold) {
            next.bold = patch.bold;
            changed = true;
          }
          if (patch.italic !== undefined && patch.italic !== !!el.italic) {
            next.italic = patch.italic;
            changed = true;
          }
          if (patch.background !== undefined) {
            const background = textBackgroundColor(patch.background, el.color);
            if (background !== el.background) {
              next.background = background;
              changed = true;
            }
          }
          return changed ? next : el;
        });
      },
      raiseSelection: () => {
        if (selectionRef.current.size === 0) return;
        commit(reorder(elementsRef.current, selectionRef.current, "front"));
      },
      lowerSelection: () => {
        if (selectionRef.current.size === 0) return;
        commit(reorder(elementsRef.current, selectionRef.current, "back"));
      },
      clearBoard: () => setConfirmClear(true),
    }),
    [commit, restyleSelection],
  );

  // -------------------------------------------------------------- placement

  /** The style a new text box gets from the current settings. */
  const newTextStyle = useCallback((): NewTextStyle => {
    const { text, color: textColor } = settingsRef.current;
    return {
      color: textColor,
      background: textBackgroundColor(text.background, textColor),
      fontSize: text.fontSize,
      align: text.align,
      fontFamily: text.fontFamily,
      bold: text.bold,
      italic: text.italic,
    };
  }, []);

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
          addElement(createText(at, newTextStyle()), { edit: true });
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
    [addElement, newTextStyle, placementPoint, tool],
  );

  async function handleImageFile(file: File) {
    const at = pendingImageAt.current ?? placementPoint({ x: size.width / 2, y: size.height / 2 });
    pendingImageAt.current = null;
    try {
      // Shrunk first on a device that asked for that (see BoardAssets.prepareImage) - which is
      // also why the hash below is taken from these bytes rather than the file's: what gets stored
      // is what gets addressed.
      const bytes = assets.prepareImage
        ? await assets.prepareImage(file)
        : new Uint8Array(await file.arrayBuffer());
      // Content-addressed, exactly like Editor.tsx's insertImageFile - the same picture dropped on
      // a board and pasted into a note dedupes onto one file on disk (or one IndexedDB entry, for
      // a browser guest - see BoardAssets).
      const hash = await putAsset(assets, bytes);
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

  /** A selected element's geometry as it stood when a resize began. `flipped` rides along with the
   * box because a vector shape's direction has to be derived from where the drag *started* - by the
   * second pointermove the element itself is already carrying the value the first one wrote (see
   * flipAfterResize). Non-shapes park a harmless `false` there. */
  type ResizeOrigin = BoardRect & { flipped: boolean };

  type Gesture =
    | { kind: "pan"; startScreen: BoardPoint; startViewport: BoardViewport }
    | { kind: "marquee"; startWorld: BoardPoint; additive: boolean; baseSelection: ReadonlySet<string> }
    /** `enterEdit` carries the element a *click* (as opposed to a drag) should open for editing -
     * the second click of the select-then-edit gesture. It is armed at pointer-down and cleared by
     * the first pointermove that travels far enough to read as a drag, so pointer-up only has to
     * ask whether it survived. */
    | {
        kind: "move";
        startWorld: BoardPoint;
        origins: Map<string, BoardPoint>;
        enterEdit: string | null;
      }
    | { kind: "resize"; handle: ResizeHandleId; startWorld: BoardPoint; origins: Map<string, ResizeOrigin> }
    /** Dragging one end of a lone line. `anchor` is the end staying put and `moving` where the
     * dragged end started, both in world space; `end` says which slot the dragged one occupies so
     * the rebuilt line keeps its points in their original order. */
    | {
        kind: "endpoint";
        id: string;
        end: "a" | "b";
        startWorld: BoardPoint;
        anchor: BoardPoint;
        moving: BoardPoint;
      }
    | { kind: "draft-shape"; startWorld: BoardPoint };

  const gestureRef = useRef<Gesture | null>(null);
  // Which diagonal the in-progress vector shape was dragged along - a ref rather than state
  // because only the commit at pointer-up reads it, so tracking it never needs a re-render.
  const draftFlippedRef = useRef(false);

  function beginResize(handle: ResizeHandleId, e: React.PointerEvent) {
    const container = containerRef.current;
    if (!container) return;
    // A press on a handle stops propagation, so it never reaches handlePointerDown's own
    // preventDefault - and a resize drag would otherwise start the native text selection described
    // there. Harmlessly redundant on the near-miss path, which comes through that handler.
    e.preventDefault();
    container.setPointerCapture(e.pointerId);
    beginHistory();
    gestureRef.current = {
      kind: "resize",
      handle,
      startWorld: screenToWorld(screenPointFromEvent(e, container), viewportRef.current),
      origins: new Map(
        elementsRef.current
          .filter((el) => selectionRef.current.has(el.id))
          .map((el) => [
            el.id,
            { x: el.x, y: el.y, w: el.w, h: el.h, flipped: el.kind === "shape" && el.flipped === true },
          ]),
      ),
    };
  }

  /** Starts dragging one end of the selected line - a line/arrow shape or a straightened pen
   * stroke alike (see lineEndpoints). */
  function beginEndpoint(end: "a" | "b", e: React.PointerEvent) {
    const container = containerRef.current;
    if (!container) return;
    const selected = elementsRef.current.filter((el) => selectionRef.current.has(el.id));
    const ends = selected.length === 1 ? lineEndpoints(selected[0]) : null;
    // Only reachable from a handle this same geometry produced, so the selection has already
    // changed under the press if there's no line here - safer to drop the gesture than to guess.
    if (!ends) return;
    e.preventDefault();
    container.setPointerCapture(e.pointerId);
    beginHistory();
    gestureRef.current = {
      kind: "endpoint",
      id: selected[0].id,
      end,
      startWorld: screenToWorld(screenPointFromEvent(e, container), viewportRef.current),
      anchor: end === "a" ? ends.b : ends.a,
      moving: end === "a" ? ends.a : ends.b,
    };
  }

  function beginHandleDrag(handle: SelectionHandle, e: React.PointerEvent) {
    if (handle.kind === "endpoint") beginEndpoint(handle.id, e);
    else beginResize(handle.id, e);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container) return;
    // A live widget owns every press that lands inside it - caret placement, drag-selecting code,
    // scrubbing a waveform, dragging a table's column grip. Checked structurally, once, rather than
    // by asking each widget to stopPropagation on each of its own parts: the widgets are full of
    // interactive surfaces (CodeMirror's content, menus, inputs, scrollbars) and the ones that
    // forgot would silently have their drags stolen by the board's own move gesture. Returning
    // before `e.preventDefault()` below is the point - that call is what would otherwise stop the
    // widget from taking focus at all.
    if (editingId && (e.target as HTMLElement | null)?.closest?.(`[data-element-id="${editingId}"]`)) {
      return;
    }
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
    // Every branch below starts a board gesture, and none of them wants the WebView's default
    // response to a press-and-drag: a native text selection, anchored here and extended across the
    // document as the pointer moves. That selection is invisible over the board's own markup - the
    // canvas has nothing to highlight - right up until it spans one of the two <canvas> elements,
    // which are *replaced* elements and so get `::selection` painted across their whole box. With
    // `--selection` being `rgb(var(--accent-rgb) / 0.22)`, that reads as an accent-coloured wash
    // over the entire board, appearing and vanishing as the drag crosses the canvas.
    //
    // The pan branch above has always called this, which is why panning was the one gesture that
    // never showed it.
    e.preventDefault();
    // Past this point every branch either creates or moves something, so a viewer stops here -
    // they keep the pan/hand paths handled above.
    if (!canEdit) return;

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

    // A press that lands near a resize handle is aiming at that handle, whatever is behind it. The
    // handle's own onPointerDown catches a direct hit; this catches the near miss, which otherwise
    // falls through to the branches below and - when the pointer is outside the selected element -
    // starts a marquee that clears the selection the user was reaching for.
    // Still offered while an element is being edited: a press that landed *inside* the live widget
    // has already returned above, so anything reaching here is on the chrome around it - and having
    // to click away from a table before it can be made wider is exactly the kind of detour the
    // select-then-edit gesture is supposed to remove.
    if (selectionBounds) {
      const handle = handleAt(selectionBounds, selectedElements, world, HANDLE_GRAB_PX / viewportRef.current.zoom);
      if (handle) {
        beginHandleDrag(handle, e);
        return;
      }
    }

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

    // Captured before the selection is rewritten below, since "was this already selected?" is what
    // separates the click that selects from the click that opens.
    const wasSelected = selectionRef.current.has(hit.id);

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
      // Click an element to select it, click the selected element again to work inside it - the
      // two-stage gesture every canvas app uses, and the reason a single click can't open a widget
      // outright: the first press on an element is far more often the start of a drag. Only a lone,
      // unmodified, non-additive selection qualifies, so shift-extending a selection or moving a
      // multi-element group never trips it. Double-click still opens an element in one go (see the
      // canvas's onDoubleClick), which is what makes the shortcut discoverable from either habit.
      enterEdit: !additive && !hit.locked && wasSelected && nextSelection.size === 1 ? hit.id : null,
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
        // Past this much travel the gesture is a drag, not a click, so it can no longer end by
        // opening the element. Measured in screen px so the threshold is the same physical slop at
        // every zoom - at 5x, a world-space tolerance would be five times as twitchy.
        if (gesture.enterEdit && Math.hypot(dx, dy) * viewportRef.current.zoom > CLICK_SLOP_PX) {
          gesture.enterEdit = null;
        }
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
            const vector = el.kind === "shape" && isVectorShape(el.shape);
            const raw = resizeFromHandle(origin, gesture.handle, dx, dy);
            // A line or arrow is legitimately flat in one axis, so it gets a 1px floor rather than
            // the general minimum, which would tilt a horizontal line off true.
            const next = resizeElement(el, clampRect(raw, vector ? 1 : undefined));
            // Dragging an endpoint past its anchor mirrors the box, and a vector shape stores its
            // direction *in* that box - so the diagonal has to be re-read, or the anchored end is
            // the one that appears to move.
            return vector
              ? { ...(next as ShapeElement), flipped: flipAfterResize(origin.flipped, raw) }
              : next;
          }),
        );
        return;
      }
      case "endpoint": {
        const dragged = {
          x: gesture.moving.x + (world.x - gesture.startWorld.x),
          y: gesture.moving.y + (world.y - gesture.startWorld.y),
        };
        // Snapping lands the end on the lattice itself rather than snapping the *delta*, which is
        // the same rule the pen's straighten assist follows - so an end dragged onto a vertex meets
        // whatever else was drawn to that vertex.
        const target = snapping ? snapToSurface(dragged, surface) : dragged;
        const a = gesture.end === "a" ? target : gesture.anchor;
        const b = gesture.end === "a" ? gesture.anchor : target;
        commitTransient(
          elementsRef.current.map((el) => (el.id === gesture.id ? setLineEndpoints(el, a, b) : el)),
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

    // A click that neither moved nor changed the selection: the second click of select-then-edit.
    if (gesture?.kind === "move" && gesture.enterEdit) {
      setEditingId(gesture.enterEdit);
      return;
    }

    if (gesture?.kind === "draft-shape" && draftShape) {
      const vector = isVectorShape(shape);
      const tiny = draftShape.w < 4 && draftShape.h < 4;
      // A click (rather than a drag) places a default-sized shape, the way every diagramming tool
      // does - dragging one out and clicking to drop one are both expected gestures.
      const rect = tiny
        ? { x: draftShape.x, y: draftShape.y, w: vector ? BOARD_GRID_SIZE * 4 : 160, h: vector ? 0 : 120 }
        : draftShape;
      addElement(
        createShape(rect, shape, {
          stroke: color,
          // A line or arrow has no interior to fill, so the fill setting simply doesn't apply to it.
          fill: vector ? "none" : fillColor(settings.fill, color),
          strokeWidth: shapeStrokeWidth,
          dash: settings.shapeStyle,
          flipped: vector && draftFlippedRef.current,
        }),
      );
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
      if (mod && e.key.toLowerCase() === "z" && canEdit) {
        // Undo/redo belongs to whatever surface has focus first - CodeMirror and contentEditable
        // both keep their own histories.
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "d" && !typing && canEdit) {
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
      // Selection, tool switching and zoom stay available to a viewer; everything below this
      // point mutates the document.
      if (!canEdit && (e.key === "Delete" || e.key === "Backspace" || e.key.startsWith("Arrow") || e.key === "[" || e.key === "]")) {
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
  }, [applyZoom, canEdit, commit, deleteSelection, duplicateSelection, store, zoomToFit]);

  // ----------------------------------------------------------------- render

  const cursor =
    effectiveTool === "hand" ? "grab" : effectiveTool === "select" ? "default" : "crosshair";

  /** The clip "Record more" is appending onto, resolved from the id so a voice note deleted (or
   * replaced) while the recorder is open degrades to a plain new recording rather than patching an
   * element that is no longer there. */
  const appendVoiceSrc = useMemo(() => {
    if (!appendVoiceTo) return undefined;
    const target = elements.find((el) => el.id === appendVoiceTo);
    return target?.kind === "voice" ? target.src : undefined;
  }, [appendVoiceTo, elements]);

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
          settings={settings}
          actions={actions}
          selectedElements={selectedElements}
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
          voiceEnabled={voiceEnabled}
          codeEnabled={codeEnabled}
          canEdit={canEdit}
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
          if (effectiveTool !== "select" || !canEdit) return;
          const container = containerRef.current;
          if (!container) return;
          // Double-clicking *inside* a live widget is that widget's own gesture (select a word, a
          // table cell's text), not a request to open something.
          if (editingId && (e.target as HTMLElement | null)?.closest?.(`[data-element-id="${editingId}"]`)) {
            return;
          }
          const world = screenToWorld(screenPointFromEvent(e, container), viewportRef.current);
          const hit = topmostAt(elementsRef.current, world, 6 / viewportRef.current.zoom);
          if (hit && !hit.locked) {
            setSelection(new Set([hit.id]));
            setEditingId(hit.id);
          } else {
            // Double-clicking empty canvas drops a text box there, the standard whiteboard idiom.
            addElement(createText(snapping ? snapToSurface(world, surface) : world, newTextStyle()), {
              edit: true,
            });
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
              onAppendVoice={() => {
                setAppendVoiceTo(el.id);
                setVoiceOpen(true);
              }}
              onDelete={() => {
                commit(removeElements(elementsRef.current, new Set([el.id])));
                setSelection(new Set());
                setEditingId(null);
              }}
              assets={assets}
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

          {/* Kept up while an element is being edited, unlike a bare text box's caret-only state used
              to be: a widget's outline is what says which element the toolbar's options apply to, and
              its handles are how it gets resized without first clicking away. */}
          {selectionBounds && canEdit && (
            <BoardSelection
              bounds={selectionBounds}
              elements={selectedElements}
              zoom={viewport.zoom}
              onHandlePointerDown={beginHandleDrag}
            />
          )}
        </div>

        <BoardInkLayer
          active={drawing}
          tool={drawing ? (tool as "pen" | "highlighter" | "eraser") : "pen"}
          color={color}
          // Each ink tool has its own size table - a highlighter nib is much broader than a pen's,
          // and an eraser broader still (see BOARD_TOOL_SIZES).
          width={inkWidth}
          // The brush style belongs to the pen: a dashed highlighter nobody asked for would be the
          // surprising consequence of dashing the pen.
          dash={tool === "pen" ? settings.penStyle : "solid"}
          eraserSquare={settings.eraserShape === "square"}
          surface={surface}
          assistEnabled={snapping}
          viewport={viewport}
          viewWidth={size.width}
          viewHeight={size.height}
          onEraseStart={() => {
            erasedThisGesture.current = false;
          }}
          onErase={eraseAt}
          onCommit={(result, style) => {
            if (result.shape) {
              // The assist recognized a closed shape - commit a real ShapeElement rather than ink,
              // so it can be filled, relabelled and resized like any other shape. It keeps the
              // *stroke's* own style, not the shape tool's, since that is what was drawn.
              commit([
                ...elementsRef.current,
                createShape(result.shape, result.shape.kind, {
                  stroke: style.color,
                  fill: "none",
                  strokeWidth: style.width,
                  dash: style.dash,
                }),
              ]);
              return;
            }
            const element = inkFromPoints(result.points, style.tool, style.color, style.width, style.dash);
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

      {/* Hosted here rather than in the options panel that triggers it: the dialog's scrim is
          `absolute inset-0`, and inside the panel it would cover the panel instead of the board. */}
      {confirmClear && (
        <ConfirmDialog
          title="Clear this whole board?"
          description="Every element on the canvas is removed. You can undo it with ⌘Z."
          confirmLabel="Clear board"
          onConfirm={() => {
            commit([]);
            setSelection(new Set());
            setEditingId(null);
            setConfirmClear(false);
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {voiceOpen && (
        <VoiceCapture
          countdownSeconds={voiceNoteCountdown}
          assets={assets}
          // Set only for "Record more", which makes the recorder append onto the clip already there
          // rather than produce a second one (see VoiceCapture, which does the re-encode).
          appendTo={appendVoiceSrc}
          onCancel={() => {
            setVoiceOpen(false);
            setPendingVoiceAt(null);
            setAppendVoiceTo(null);
            setTool("select");
          }}
          onComplete={({ src, durationMs, peaks }) => {
            if (appendVoiceTo) {
              // A patch, not a new element: the clip keeps its place, its size, its title and its
              // z-order, which is the whole point of recording *more* rather than recording again.
              commit(
                elementsRef.current.map((el) =>
                  el.id === appendVoiceTo && el.kind === "voice"
                    ? { ...el, src, durationMs, peaks }
                    : el,
                ),
              );
            } else {
              const at = pendingVoiceAt ?? placementPoint({ x: size.width / 2, y: size.height / 2 });
              addElement(createVoice(at, src, durationMs, peaks));
            }
            setVoiceOpen(false);
            setPendingVoiceAt(null);
            setAppendVoiceTo(null);
          }}
        />
      )}
    </div>
  );
}

/** Every scroll pane a board element can put inside (or beside) its own box: a table's grid, a code
 * block's CodeMirror scroller, and the language dropdown's list. Nothing else on the board holds
 * content that can outgrow the frame the user sized, so nothing else has a claim on the wheel. */
const WIDGET_SCROLLER = ".board-table-scroll, .cm-scroller, .board-widget-menu-list";

/** The pane a wheel should scroll instead of panning the board, or null to let the board have it.
 *
 * Two lookups, because how a widget can be found depends on whether it is live. `target` resolves
 * the pane directly under the cursor and so is the exact answer whenever the pointer can reach the
 * widget at all - an element open for editing, including the dropdowns it hangs outside its own
 * box. `boxAt` is the fallback for everything else: a selected-but-not-editing widget is
 * click-through, so it has to be found by board geometry instead, and the first pane inside it that
 * can move takes the gesture.
 *
 * A pane only claims the wheel when it actually overflows along the axis the gesture is mostly
 * travelling. A table that fits its frame has nothing to scroll, and swallowing the event there
 * would strand the user on a board that suddenly refuses to pan. */
function wheelScroller(
  target: EventTarget | null,
  /** Resolved lazily: it costs a walk of the board, and the two cases that dominate - a pan over
   * open canvas, and a wheel the pointer could already reach a pane for - never need it. */
  boxAt: () => Element | null,
  deltaX: number,
  deltaY: number,
): HTMLElement | null {
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
  // Sub-pixel slack: a scroll pane rounds its own metrics, and a fraction of a pixel of "overflow"
  // is not something the user can see, let alone scroll to.
  const canScroll = (pane: HTMLElement) =>
    (vertical ? pane.scrollHeight - pane.clientHeight : pane.scrollWidth - pane.clientWidth) > 1;

  const direct = (target as Element | null)?.closest?.<HTMLElement>(WIDGET_SCROLLER);
  // A direct hit that can't move is the end of it, not a reason to look further: the pane under the
  // cursor is the only one the gesture could have meant.
  if (direct) return canScroll(direct) ? direct : null;

  for (const pane of boxAt()?.querySelectorAll<HTMLElement>(WIDGET_SCROLLER) ?? []) {
    if (canScroll(pane)) return pane;
  }
  return null;
}

/** Applies a widget's patch to an element, treating an explicitly-`undefined` value as "drop this
 * field" rather than as "store undefined here".
 *
 * Every optional field on a board element is stored by *absence* - no `"dash": "solid"`, no
 * `"fills": null` (see boardTypes and tableOps' fillsPatch) - both so a board file written before a
 * feature existed stays indistinguishable from one that simply isn't using it, and so the collab
 * layer, which puts whole element values into a Y.Map (see collab/boardSync.ts), never has to carry
 * an `undefined` across the wire. A plain `{ ...el, ...patch }` spread would defeat that: the key
 * survives the spread with an undefined value and lands in the JSON as `null`. */
function applyPatch(el: BoardElement, patch: Partial<BoardElement>): BoardElement {
  const next: Record<string, unknown> = { ...el, ...patch };
  for (const key of Object.keys(patch)) {
    if ((patch as Record<string, unknown>)[key] === undefined) delete next[key];
  }
  return next as unknown as BoardElement;
}

/** An ink stroke at a new width.
 *
 * Rebuilt through inkFromPoints rather than patched, because a stroke's box is its centerline padded
 * by half the stroke width - editing `width` alone would leave a box that no longer contains what it
 * draws, so the stroke would be clipped and mis-hit-tested. The id is carried over so the element
 * stays the same element to the selection and to collaborators. */
function withInkWidth(el: InkElement, width: number): InkElement {
  const rebuilt = inkFromPoints(
    el.points.map((p) => ({ x: p.x + el.x, y: p.y + el.y })),
    el.tool,
    el.color,
    width,
    el.dash,
  );
  return rebuilt ? { ...rebuilt, id: el.id, ...(el.locked ? { locked: true } : {}) } : el;
}

/** An ink or shape element with a dash pattern applied. A solid line drops the field entirely, so
 * files stay free of a redundant `"dash": "solid"` on every stroke. Returns the element itself when
 * it already carries that pattern, so restyling can tell "nothing changed" by reference. */
function withDash<T extends { dash?: BoardStrokeStyle }>(el: T, dash: BoardStrokeStyle): T {
  if ((el.dash ?? "solid") === dash) return el;
  if (dash === "solid") {
    const { dash: _dropped, ...rest } = el;
    return rest as T;
  }
  return { ...el, dash };
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
