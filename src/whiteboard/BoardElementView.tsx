import { memo, useEffect, useRef } from "react";
import { HIGHLIGHTER_ALPHA } from "./BoardInkLayer";
import { CodeWidget } from "./widgets/CodeWidget";
import { TableWidget } from "./widgets/TableWidget";
import { VoiceWidget } from "./widgets/VoiceWidget";
import { useAssetUrl, type BoardAssets } from "./useAssetUrl";
import { boardFontStack, dashArray, isVectorShape } from "./boardTypes";
import type {
  BoardElement,
  ImageElement,
  InkElement,
  ShapeElement,
  TextElement,
} from "./boardTypes";

/** Renders one board element, positioned absolutely in *world* coordinates inside the single
 * transformed world layer (see WhiteboardView). Because the whole layer carries the zoom, nothing
 * here ever multiplies by it - an element's style values are its stored geometry, verbatim, which
 * is what keeps pan/zoom free of per-element layout work.
 *
 * Memoized on identity: board mutations are immutable array/object replacements (boardOps.ts), so a
 * drag that moves one element re-renders exactly that one, not every element on the canvas. */
export const BoardElementView = memo(function BoardElementView({
  element,
  selected,
  interactive,
  onPatch,
  onStartEditing,
  onAppendVoice,
  onDelete,
  editing,
  assets,
}: {
  element: BoardElement;
  selected: boolean;
  /** True only when the select tool is active, the element isn't locked, and it is the element
   * currently being edited - widgets and text boxes must stay click-through otherwise, so a drawing
   * tool (or a drag passing over the top of them) keeps the pointer. */
  interactive: boolean;
  onPatch: (patch: Partial<BoardElement>) => void;
  onStartEditing: () => void;
  /** Opens the recorder to append onto this voice note. Owned by the workspace - recording needs
   * the board's asset store and its modal surface - and ignored by every other kind. */
  onAppendVoice: () => void;
  onDelete: () => void;
  /** Whether this element is the one open for editing (see BoardWorkspace's select-then-edit
   * gesture). Text boxes turn on a caret; widgets turn on their own chrome. */
  editing: boolean;
  /** How this board reaches image/audio bytes - differs between the owner's device and a guest's;
   * see BoardAssets. */
  assets: BoardAssets;
}) {
  const style: React.CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.w,
    height: element.h,
  };

  return (
    <div
      // `is-editing` is what flips the element from click-through to interactive (see index.css) -
      // it must track `interactive`, not `editing`, so a locked element never becomes live.
      className={`board-element board-element-${element.kind}${selected ? " is-selected" : ""}${
        element.locked ? " is-locked" : ""
      }${interactive ? " is-editing" : ""}`}
      style={style}
      data-element-id={element.id}
    >
      {renderBody({ element, interactive, editing, onPatch, onStartEditing, onAppendVoice, onDelete, assets })}
    </div>
  );
});

function renderBody({
  element,
  interactive,
  editing,
  onPatch,
  onStartEditing,
  onAppendVoice,
  onDelete,
  assets,
}: {
  element: BoardElement;
  interactive: boolean;
  editing: boolean;
  onPatch: (patch: Partial<BoardElement>) => void;
  onStartEditing: () => void;
  onAppendVoice: () => void;
  onDelete: () => void;
  assets: BoardAssets;
}) {
  switch (element.kind) {
    case "ink":
      return <InkBody element={element} />;
    case "shape":
      return <ShapeBody element={element} interactive={interactive} editing={editing} onPatch={onPatch} />;
    case "text":
      return (
        <TextBody
          element={element}
          interactive={interactive}
          editing={editing}
          onPatch={onPatch}
          onStartEditing={onStartEditing}
        />
      );
    case "image":
      return <ImageBody element={element} assets={assets} />;
    case "code":
      return <CodeWidget element={element} editable={interactive} onChange={onPatch} />;
    case "table":
      return (
        <TableWidget element={element} editable={interactive} onChange={onPatch} onDelete={onDelete} />
      );
    case "voice":
      return (
        <VoiceWidget
          element={element}
          editable={interactive}
          onChange={onPatch}
          onAppend={onAppendVoice}
          onDelete={onDelete}
          assets={assets}
        />
      );
  }
}

/** Committed ink, as SVG rather than canvas.
 *
 * Vector output means a stroke stays crisp at 5x zoom instead of resampling a rasterized bitmap,
 * and it means ink participates in the same absolutely-positioned world layer as every other
 * element - so selecting, moving, and resizing ink needs no special case. `vectorEffect` is
 * deliberately *not* used: stroke width is a world-space property that should scale with zoom
 * exactly like the geometry it belongs to, the same way a drawn line on real paper gets thicker
 * when you look closer. */
function InkBody({ element }: { element: InkElement }) {
  const d = pathData(element);
  return (
    <svg
      className="board-ink"
      viewBox={`0 0 ${element.w} ${element.h}`}
      // preserveAspectRatio="none" lets a resize stretch the stroke with its box, matching how
      // resizeElement scales the underlying points.
      preserveAspectRatio="none"
      width={element.w}
      height={element.h}
    >
      <path
        d={d}
        fill="none"
        stroke={element.color}
        strokeWidth={element.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Undefined for a solid stroke, which is also what every stroke drawn before stroke styles
        // existed reads back as - see dashArray.
        strokeDasharray={dashArray(element.dash, element.width)}
        opacity={element.tool === "highlighter" ? HIGHLIGHTER_ALPHA : 1}
      />
    </svg>
  );
}

/** Quadratic-through-midpoints smoothing, the same curve the live ink canvas paints - so a stroke
 * doesn't visibly change shape at the moment it's committed. */
function pathData(element: InkElement): string {
  const pts = element.points;
  if (pts.length === 0) return "";
  if (pts.length === 1) {
    // A lone tap has no path to trace; a zero-length line with a round cap renders as the dot the
    // user actually drew.
    return `M ${pts[0].x} ${pts[0].y} L ${pts[0].x} ${pts[0].y}`;
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    d += ` Q ${pts[i].x} ${pts[i].y} ${(pts[i].x + pts[i + 1].x) / 2} ${(pts[i].y + pts[i + 1].y) / 2}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function ShapeBody({
  element,
  interactive,
  editing,
  onPatch,
}: {
  element: ShapeElement;
  interactive: boolean;
  editing: boolean;
  onPatch: (patch: Partial<ShapeElement>) => void;
}) {
  const { w, h, stroke, fill, strokeWidth } = element;
  // Inset by half the stroke so a stroked outline sits fully inside the element's box - otherwise
  // the outer half of the stroke is clipped by the SVG viewport and the shape looks thinner on its
  // edges than its own strokeWidth claims.
  const i = strokeWidth / 2;
  const common = {
    fill: fill === "none" ? "none" : fill,
    stroke,
    strokeWidth,
    strokeLinejoin: "round" as const,
    strokeDasharray: dashArray(element.dash, strokeWidth),
    // A dotted pattern is a run of zero-length dashes, which only render as dots under a round cap -
    // without this a dotted outline disappears entirely.
    strokeLinecap: element.dash === "dotted" ? ("round" as const) : undefined,
  };

  return (
    <>
      <svg className="board-shape" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {element.shape === "rect" && <rect x={i} y={i} width={Math.max(0, w - strokeWidth)} height={Math.max(0, h - strokeWidth)} rx={4} {...common} />}
        {element.shape === "ellipse" && (
          <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - i)} ry={Math.max(0, h / 2 - i)} {...common} />
        )}
        {element.shape === "diamond" && (
          <polygon points={`${w / 2},${i} ${w - i},${h / 2} ${w / 2},${h - i} ${i},${h / 2}`} {...common} />
        )}
        {element.shape === "triangle" && (
          <polygon points={`${w / 2},${i} ${w - i},${h - i} ${i},${h - i}`} {...common} />
        )}
        {isVectorShape(element.shape) && (
          // Line and arrow run corner to corner rather than filling the box; `flipped` picks which
          // diagonal (see ShapeElement.flipped for why direction isn't a negative w/h).
          <line
            x1={0}
            y1={element.flipped ? h : 0}
            x2={w}
            y2={element.flipped ? 0 : h}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={dashArray(element.dash, strokeWidth)}
            markerEnd={element.shape === "arrow" ? `url(#${arrowMarkerId(element)})` : undefined}
          />
        )}
        {element.shape === "arrow" && (
          <defs>
            {/* Per-element marker id: markers are document-global, and a single shared one would
             * force every arrow on the board to the colour of whichever element defined it last. */}
            <marker id={arrowMarkerId(element)} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
            </marker>
          </defs>
        )}
      </svg>
      <ShapeLabel element={element} interactive={interactive} editing={editing} onPatch={onPatch} />
    </>
  );
}

function arrowMarkerId(element: ShapeElement): string {
  return `board-arrow-${element.id}`;
}

/** A shape's optional centered label - the "labelled box" every diagramming tool has. Only mounts
 * an editable surface once the shape is actually being edited, so an unlabeled shape costs nothing
 * and never intercepts pointer events meant for the canvas. */
function ShapeLabel({
  element,
  interactive,
  editing,
  onPatch,
}: {
  element: ShapeElement;
  interactive: boolean;
  editing: boolean;
  onPatch: (patch: Partial<ShapeElement>) => void;
}) {
  if (!editing && !element.text) return null;
  return (
    <EditableText
      value={element.text ?? ""}
      editing={editing && interactive}
      className="board-shape-label"
      style={{ color: element.textColor ?? "var(--text-primary)", textAlign: "center" }}
      onChange={(text) => onPatch({ text })}
    />
  );
}

function TextBody({
  element,
  interactive,
  editing,
  onPatch,
  onStartEditing,
}: {
  element: TextElement;
  interactive: boolean;
  editing: boolean;
  onPatch: (patch: Partial<TextElement>) => void;
  onStartEditing: () => void;
}) {
  return (
    <div
      className="board-text"
      style={{
        background: element.background === "none" ? "transparent" : element.background,
        color: element.color,
        fontSize: element.fontSize,
        textAlign: element.align,
        fontFamily: boardFontStack(element.fontFamily),
        fontWeight: element.bold ? 600 : undefined,
        fontStyle: element.italic ? "italic" : undefined,
      }}
      onDoubleClick={interactive ? onStartEditing : undefined}
    >
      <EditableText
        value={element.text}
        editing={editing && interactive}
        placeholder="Type something"
        className="board-text-content"
        onChange={(text) => onPatch({ text })}
      />
    </div>
  );
}

/** Shared text surface for text elements and shape labels.
 *
 * Uses `contentEditable` rather than a `<textarea>` so the text sits in normal flow and inherits
 * the world layer's transform cleanly - a textarea inside a scaled ancestor has its own scrollbar
 * and caret metrics computed pre-scale, which puts the caret visibly off the glyphs at anything but
 * 100% zoom. The DOM is written to only when the incoming value differs from what's already there,
 * because assigning `textContent` unconditionally would collapse the caret to position 0 on every
 * keystroke. */
function EditableText({
  value,
  editing,
  placeholder,
  className,
  style,
  onChange,
}: {
  value: string;
  editing: boolean;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.textContent !== value) el.textContent = value;
  }, [value]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Place the caret at the end rather than wherever the browser's default focus lands, which for
    // an empty contentEditable can be outside the element entirely.
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  return (
    <div
      ref={ref}
      className={className}
      style={style}
      contentEditable={editing}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      spellCheck={false}
      onInput={(e) => onChange(e.currentTarget.textContent ?? "")}
      onPointerDown={(e) => {
        // While editing, the pointer belongs to the caret; otherwise it belongs to the board so
        // the element can be dragged by its text.
        if (editing) e.stopPropagation();
      }}
      onKeyDown={(e) => {
        // Escape ends editing; the board's own key handler does the state change, this just keeps
        // the keystroke from being typed into the text first.
        if (e.key === "Escape") e.currentTarget.blur();
        else e.stopPropagation();
      }}
    />
  );
}

function ImageBody({ element, assets }: { element: ImageElement; assets: BoardAssets }) {
  const url = useAssetUrl(element.src, assets);
  if (!url) return <div className="board-image-placeholder" />;
  return <img className="board-image" src={url} alt={element.alt ?? ""} draggable={false} />;
}
