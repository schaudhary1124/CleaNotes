import { isFreelyResizable, type BoardElement, type BoardRect } from "./boardTypes";

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

/** Selection chrome: the outline around the current selection plus its resize handles.
 *
 * Lives *inside* the world layer so it tracks pan/zoom with the elements it describes, but its
 * stroke and handle sizes are pre-divided by zoom (see the `zoom` prop) so they stay a constant
 * on-screen size - a 1px outline scaled to 5x would be a fat 5px band, and handles would grow into
 * the shape they're meant to sit beside. */
export function BoardSelection({
  bounds,
  elements,
  zoom,
  onHandlePointerDown,
}: {
  bounds: BoardRect;
  /** The selected elements themselves - the handle set depends on what's selected (see
   * isFreelyResizable: widgets with content-driven height only offer horizontal handles). */
  elements: readonly BoardElement[];
  zoom: number;
  onHandlePointerDown: (handle: ResizeHandleId, e: React.PointerEvent) => void;
}) {
  const scale = 1 / zoom;
  const single = elements.length === 1 ? elements[0] : null;
  const freeform = !single || isFreelyResizable(single.kind);
  const handles = freeform ? RESIZE_HANDLES : RESIZE_HANDLES.filter((h) => h.dy === 0);
  const anyLocked = elements.some((el) => el.locked);

  return (
    <div
      className="board-selection"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
        borderWidth: 1.5 * scale,
      }}
    >
      {!anyLocked &&
        handles.map((handle) => (
          <span
            key={handle.id}
            className="board-handle"
            style={{
              left: `calc(${handle.x * 100}% - ${5 * scale}px)`,
              top: `calc(${handle.y * 100}% - ${5 * scale}px)`,
              width: 10 * scale,
              height: 10 * scale,
              borderWidth: 1.5 * scale,
              borderRadius: 3 * scale,
              cursor: handle.cursor,
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandlePointerDown(handle.id, e);
            }}
          />
        ))}
    </div>
  );
}
