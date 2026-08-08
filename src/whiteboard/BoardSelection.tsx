import {
  isFreelyResizable,
  lineEndpoints,
  type BoardElement,
  type BoardPoint,
  type BoardRect,
} from "./boardTypes";

/** The eight resize anchors, as unit multipliers against the selection box. `fx`/`fy` say which
 * corner is *fixed* while dragging this handle, and `dx`/`dy` which axes the drag affects - which
 * is all `resizeFromHandle` needs to turn a pointer delta into a new rect. */
export const RESIZE_HANDLES = [
  { id: "nw", x: 0, y: 0, dx: -1, dy: -1, cursor: "nwse-resize" },
  { id: "n", x: 0.5, y: 0, dx: 0, dy: -1, cursor: "ns-resize" },
  { id: "ne", x: 1, y: 0, dx: 1, dy: -1, cursor: "nesw-resize" },
  { id: "e", x: 1, y: 0.5, dx: 1, dy: 0, cursor: "ew-resize" },
  { id: "se", x: 1, y: 1, dx: 1, dy: 1, cursor: "nwse-resize" },
  { id: "s", x: 0.5, y: 1, dx: 0, dy: 1, cursor: "ns-resize" },
  { id: "sw", x: 0, y: 1, dx: -1, dy: 1, cursor: "nesw-resize" },
  { id: "w", x: 0, y: 0.5, dx: -1, dy: 0, cursor: "ew-resize" },
] as const;

export type ResizeHandleId = (typeof RESIZE_HANDLES)[number]["id"];

/** Applies a world-space pointer delta to `start` for the given handle. Anchoring is implicit:
 * a handle that pulls the west edge moves `x` *and* shrinks `w`, so the east edge stays put. */
export function resizeFromHandle(start: BoardRect, handle: ResizeHandleId, dx: number, dy: number): BoardRect {
  const spec = RESIZE_HANDLES.find((h) => h.id === handle)!;
  let { x, y, w, h } = start;
  if (spec.dx === -1) {
    x += dx;
    w -= dx;
  } else if (spec.dx === 1) {
    w += dx;
  }
  if (spec.dy === -1) {
    y += dy;
    h -= dy;
  } else if (spec.dy === 1) {
    h += dy;
  }
  return { x, y, w, h };
}

/** Whether a resize that turned `raw` inside out has mirrored a vector shape's diagonal.
 *
 * `flipped` says which diagonal of the box the line runs along, so reflecting the box in exactly one
 * axis - dragging an endpoint past its anchor horizontally but not vertically - swaps it. The flag
 * has to follow, or the endpoint the user *isn't* touching appears to move. Reflecting in both axes
 * is a 180-degree rotation, which lands on the same diagonal.
 *
 * Reads the pre-clamp rect, since clampRect is precisely what folds the negative extents away. */
export function flipAfterResize(flipped: boolean, raw: BoardRect): boolean {
  return (raw.w < 0) !== (raw.h < 0) ? !flipped : flipped;
}

/** A grabbable point on the current selection, resolved to where it actually sits in world space.
 *
 * The two kinds differ in more than placement, which is why they're one type rather than one list
 * of positions: a "resize" drag edits the selection's *box*, an "endpoint" drag edits one end of a
 * line and lets the box fall out of it (see boardOps' setLineEndpoints). */
export type SelectionHandle =
  | { kind: "resize"; id: ResizeHandleId; x: number; y: number; cursor: string }
  | { kind: "endpoint"; id: "a" | "b"; x: number; y: number; cursor: string };

/** The endpoints on offer when the selection is a single line - of either kind, drawn with the line
 * tool or straightened out of a pen stroke (see boardTypes' lineEndpoints). */
function endpointsFor(elements: readonly BoardElement[]) {
  const single = elements.length === 1 ? elements[0] : null;
  return single ? lineEndpoints(single) : null;
}

/** Every handle the given selection offers, placed in world space.
 *
 * Three cases. A selection with anything locked in it offers nothing. A lone line offers its two
 * ends and nothing else - it doesn't *fill* the box it's stored in, so the other six handles would
 * be edges to drag on a shape that has no presence along them, and the box itself is something the
 * user never drew. Everything else gets the box anchors, minus the vertical pair for a widget whose
 * height is driven by its content (see isFreelyResizable).
 *
 * Both the drawing below and the workspace's own hit-testing read this one function, so where a
 * handle appears and where it can be grabbed can never drift apart. */
export function selectionHandles(bounds: BoardRect, elements: readonly BoardElement[]): SelectionHandle[] {
  if (elements.some((el) => el.locked)) return [];
  const ends = endpointsFor(elements);
  if (ends) {
    // An end moves in both axes at once, so none of the eight directional resize cursors is honest
    // about it - "move" is what it actually does.
    return [
      { kind: "endpoint", id: "a", x: ends.a.x, y: ends.a.y, cursor: "move" },
      { kind: "endpoint", id: "b", x: ends.b.x, y: ends.b.y, cursor: "move" },
    ];
  }
  const single = elements.length === 1 ? elements[0] : null;
  const anchors =
    !single || isFreelyResizable(single.kind) ? RESIZE_HANDLES : RESIZE_HANDLES.filter((h) => h.dy === 0);
  return anchors.map((h) => ({
    kind: "resize",
    id: h.id,
    x: bounds.x + bounds.w * h.x,
    y: bounds.y + bounds.h * h.y,
    cursor: h.cursor,
  }));
}

/** The handle whose centre is within `tolerance` world px of `point`, or null.
 *
 * The drawn handle is a 10px square, which is a small target to ask for pixel accuracy on - and the
 * cost of missing it is not "nothing happens" but a marquee that clears the very selection the user
 * was reaching for. So the board hit-tests handles itself, with a grab radius wider than the square,
 * exactly as it already does for elements (see geometry.ts's topmostAt).
 *
 * Nearest wins rather than first: on a selection small enough that neighbouring grab radii overlap,
 * the closer handle is the one being aimed at. */
export function handleAt(
  bounds: BoardRect,
  elements: readonly BoardElement[],
  point: BoardPoint,
  tolerance: number,
): SelectionHandle | null {
  let best: SelectionHandle | null = null;
  let bestDistance = tolerance;
  for (const handle of selectionHandles(bounds, elements)) {
    const distance = Math.hypot(handle.x - point.x, handle.y - point.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = handle;
    }
  }
  return best;
}

/** Selection chrome: the outline around the current selection plus its resize handles.
 *
 * Lives *inside* the world layer so it tracks pan/zoom with the elements it describes, but its
 * stroke and handle sizes are pre-divided by zoom (see the `zoom` prop) so they stay a constant
 * on-screen size - a 1px outline scaled to 5x would be a fat 5px band, and handles would grow into
 * the shape they're meant to sit beside.
 *
 * A lone line is the exception to the outline: its box is storage, not something the user drew, so
 * boxing it reads as a second and much larger shape appearing around the one that was selected. It
 * gets two dots on its actual ends and nothing else (see selectionHandles). */
export function BoardSelection({
  bounds,
  elements,
  zoom,
  onHandlePointerDown,
}: {
  bounds: BoardRect;
  /** The selected elements themselves - the handle set depends on what's selected (see
   * selectionHandles: a line offers its ends, a content-sized widget only its horizontal pair). */
  elements: readonly BoardElement[];
  zoom: number;
  onHandlePointerDown: (handle: SelectionHandle, e: React.PointerEvent) => void;
}) {
  const scale = 1 / zoom;
  const handles = selectionHandles(bounds, elements);
  // Only drop the outline when there are endpoint dots to replace it with: a locked line offers no
  // handles at all, and the outline is then the only thing saying what the user just selected.
  const endpoints = handles.some((h) => h.kind === "endpoint");

  return (
    <div
      className="board-selection"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
        borderWidth: endpoints ? 0 : 1.5 * scale,
      }}
    >
      {handles.map((handle) => (
        <span
          key={`${handle.kind}-${handle.id}`}
          className="board-handle"
          style={{
            // Positioned from the handle's world coordinates rather than as a fraction of the box,
            // because an ink line's ends are inset from its bounds (see lineEndpoints).
            left: handle.x - bounds.x - 5 * scale,
            top: handle.y - bounds.y - 5 * scale,
            width: 10 * scale,
            height: 10 * scale,
            borderWidth: 1.5 * scale,
            // Round for an endpoint, rounded-square for a box corner - the same distinction every
            // diagramming tool draws between "this point" and "this edge".
            borderRadius: handle.kind === "endpoint" ? "50%" : 3 * scale,
            cursor: handle.cursor,
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            onHandlePointerDown(handle, e);
          }}
        />
      ))}
    </div>
  );
}
