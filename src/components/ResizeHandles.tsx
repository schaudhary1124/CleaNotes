import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

const isMac = navigator.userAgent.includes("Mac");

const EDGE = 8;
const CORNER = 16;

type Direction =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const handles: {
  direction: Direction;
  className: string;
  cursor: string;
  axis: "x" | "y";
}[] = [
  { direction: "North", className: "left-0 right-0 top-0", cursor: "ns-resize", axis: "y" },
  { direction: "South", className: "left-0 right-0 bottom-0", cursor: "ns-resize", axis: "y" },
  { direction: "West", className: "top-0 bottom-0 left-0", cursor: "ew-resize", axis: "x" },
  { direction: "East", className: "top-0 bottom-0 right-0", cursor: "ew-resize", axis: "x" },
];

const corners: { direction: Direction; className: string; cursor: string }[] = [
  { direction: "NorthWest", className: "left-0 top-0", cursor: "nwse-resize" },
  { direction: "NorthEast", className: "right-0 top-0", cursor: "nesw-resize" },
  { direction: "SouthWest", className: "left-0 bottom-0", cursor: "nesw-resize" },
  { direction: "SouthEast", className: "right-0 bottom-0", cursor: "nwse-resize" },
];

/**
 * Tauri doesn't give native OS edge-resize hit-testing when `decorations`
 * is false, so we drive resizing manually via invisible strips along each
 * edge/corner that call `startResizeDragging`.
 *
 * On macOS this call is a documented no-op (`tao`'s `drag_resize_window`
 * returns `NotSupported` there and Tauri swallows the error), while the
 * NSWindow's own `resizable` style mask still lets the OS resize from the
 * true window edge on its own. Rendering these strips there would only
 * plant a dead 8-16px band right on top of that native edge, capturing
 * the mousedown and silently eating it. So skip the overlay entirely on
 * macOS and let the native resize handle it.
 */
export function ResizeHandles() {
  if (isMac) return null;

  function startDrag(direction: Direction) {
    return (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      appWindow.startResizeDragging(direction);
    };
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {handles.map(({ direction, className, cursor, axis }) => (
        <div
          key={direction}
          onMouseDown={startDrag(direction)}
          className={`pointer-events-auto absolute ${className}`}
          style={{
            height: axis === "y" ? EDGE : undefined,
            width: axis === "x" ? EDGE : undefined,
            cursor,
          }}
        />
      ))}
      {corners.map(({ direction, className, cursor }) => (
        <div
          key={direction}
          onMouseDown={startDrag(direction)}
          className={`pointer-events-auto absolute ${className}`}
          style={{ width: CORNER, height: CORNER, cursor }}
        />
      ))}
    </div>
  );
}
