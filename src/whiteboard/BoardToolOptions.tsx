import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowUpRight,
  Bold,
  BringToFront,
  Circle,
  Diamond,
  Eraser,
  Italic,
  Minus,
  Scissors,
  SendToBack,
  Square,
  Trash2,
  Triangle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTip } from "./BoardTooltip";
import {
  BOARD_ERASER_SIZE_LABELS,
  BOARD_FONT_SIZES,
  BOARD_SIZE_LABELS,
  BOARD_TOOL_SIZES,
  fillColor,
  textBackgroundColor,
  type BoardEraserMode,
  type BoardEraserShape,
  type BoardFillStyle,
  type BoardOptionGroup,
  type BoardSizedTool,
  type BoardTextBackground,
  type BoardTool,
  type BoardToolActions,
  type BoardToolSettings,
} from "./boardTools";
import {
  boardFontStack,
  dashArray,
  type BoardElement,
  type BoardFontFamily,
  type BoardShapeKind,
  type BoardStrokeStyle,
  type BoardTextAlign,
} from "./boardTypes";

/** The options panel that drops out of the toolbar directly beneath the armed tool.
 *
 * It replaces the toolbar's previous habit of either hiding a tool's options behind a second click
 * on an already-armed button (the shape picker) or appending them to the end of the one scrolling
 * toolbar row (the width dots), where they were both easy to miss and easy to confuse with the
 * button that follows. Everything a tool can be configured with is here, visible the moment the tool
 * is armed - the panel's presence *is* the affordance.
 *
 * Two things it renders, from the same controls:
 *
 *  - the armed *tool's* options: what the next thing drawn will look like.
 *  - the *selection's* options, once something on the canvas is picked (which is also what a
 *    just-inserted element is - see BoardWorkspace's addElement), so an element can be restyled
 *    where it stands instead of being deleted and drawn again.
 *
 * Every control is an icon or a preview of the thing it sets, with no text label and no group
 * heading: five groups of labelled controls is wider than most windows, and the label belongs in a
 * tooltip that appears instantly on hover (see BoardTooltip) rather than in permanent chrome. The
 * colour swatches stay up in the toolbar row - they are shared by four tools, and a control that
 * never moves is faster to hit than one that re-lays-out per tool.
 *
 * Nothing here applies its own change: every click goes through BoardToolActions, because a setting
 * change also restyles the current selection, which only the workspace can do. */

export const SHAPE_OPTIONS: { shape: BoardShapeKind; label: string; icon: LucideIcon }[] = [
  { shape: "rect", label: "Rectangle", icon: Square },
  { shape: "ellipse", label: "Ellipse", icon: Circle },
  { shape: "diamond", label: "Diamond", icon: Diamond },
  { shape: "triangle", label: "Triangle", icon: Triangle },
  { shape: "line", label: "Line", icon: Minus },
  { shape: "arrow", label: "Arrow", icon: ArrowUpRight },
];

const STROKE_STYLES: { style: BoardStrokeStyle; label: string }[] = [
  { style: "solid", label: "Solid line" },
  { style: "dashed", label: "Dashed line" },
  { style: "dotted", label: "Dotted line" },
];

const FONT_FAMILIES: { family: BoardFontFamily; label: string }[] = [
  { family: "sans", label: "Sans-serif" },
  { family: "serif", label: "Serif" },
  { family: "mono", label: "Monospace" },
];

const ALIGNMENTS: { align: BoardTextAlign; label: string; icon: LucideIcon }[] = [
  { align: "left", label: "Align left", icon: AlignLeft },
  { align: "center", label: "Align center", icon: AlignCenter },
  { align: "right", label: "Align right", icon: AlignRight },
];

const TEXT_BACKGROUNDS: { id: BoardTextBackground; label: string }[] = [
  { id: "none", label: "No background" },
  { id: "sticky", label: "Sticky note" },
  { id: "tint", label: "Tinted background" },
];

const FILLS: { fill: BoardFillStyle; label: string }[] = [
  { fill: "none", label: "No fill" },
  { fill: "tint", label: "Tinted fill" },
  { fill: "solid", label: "Solid fill" },
];

/** Whether a tool has anything to configure. The placement tools (image/code/table/voice) genuinely
 * don't - they place one thing, which is then selected and configurable as a selection - so no panel
 * opens for them rather than an empty one, which would read as something failing to load. */
export function boardToolHasOptions(tool: BoardTool): boolean {
  return (
    tool === "pen" || tool === "highlighter" || tool === "eraser" || tool === "shape" || tool === "text"
  );
}

export function BoardToolOptions({
  tool,
  settings,
  actions,
}: {
  tool: BoardTool;
  settings: BoardToolSettings;
  actions: BoardToolActions;
}) {
  switch (tool) {
    case "pen":
      return (
        <>
          <SizeGroup tool="pen" settings={settings} actions={actions} />
          <StrokeStyleGroup
            active={settings.penStyle}
            color={settings.color}
            onChange={actions.setPenStyle}
          />
        </>
      );
    case "highlighter":
      return <SizeGroup tool="highlighter" settings={settings} actions={actions} />;
    case "eraser":
      return <EraserOptions settings={settings} actions={actions} />;
    case "shape":
      return (
        <>
          <ShapeGroup settings={settings} actions={actions} />
          <SizeGroup tool="shape" settings={settings} actions={actions} />
          <StrokeStyleGroup
            active={settings.shapeStyle}
            color={settings.color}
            onChange={actions.setShapeStyle}
          />
          <FillGroup settings={settings} actions={actions} />
        </>
      );
    case "text":
      return <TextOptions settings={settings} actions={actions} />;
    default:
      return null;
  }
}

/** The same controls, chosen by what is selected rather than by what is armed.
 *
 * `groups` is the intersection across the selected kinds (see sharedOptionGroups), so what appears
 * always applies to every selected element - two strokes get the stroke controls, a stroke and a
 * picture get neither, since a picture has no stroke to change. `settings` is the selection's own
 * style, read back out of it by settingsFromSelection: the panel shows what the elements *are*, not
 * what the tool would draw next.
 *
 * Paint order is the exception, and the reason a lone picture still gets a panel: reordering is a
 * board operation rather than a property of any kind, so it rides along with whatever else is here. */
export function BoardSelectionOptions({
  elements,
  groups,
  settings,
  actions,
}: {
  elements: readonly BoardElement[];
  groups: ReadonlySet<BoardOptionGroup>;
  settings: BoardToolSettings;
  actions: BoardToolActions;
}) {
  const ink = elements.find((el) => el.kind === "ink");
  // Which ink size table applies: a highlighter's presets are far broader than a pen's, so the group
  // has to follow the selected stroke's own tool.
  const inkSized: BoardSizedTool = ink?.kind === "ink" && ink.tool === "highlighter" ? "highlighter" : "pen";

  return (
    <>
      {groups.has("ink") && (
        <>
          <SizeGroup tool={inkSized} settings={settings} actions={actions} />
          <StrokeStyleGroup
            active={settings.penStyle}
            color={settings.color}
            onChange={actions.setPenStyle}
          />
        </>
      )}
      {groups.has("shape") && (
        <>
          <ShapeGroup settings={settings} actions={actions} />
          <SizeGroup tool="shape" settings={settings} actions={actions} />
          <StrokeStyleGroup
            active={settings.shapeStyle}
            color={settings.color}
            onChange={actions.setShapeStyle}
          />
          <FillGroup settings={settings} actions={actions} />
        </>
      )}
      {groups.has("text") && <TextOptions settings={settings} actions={actions} />}
      <ArrangeGroup actions={actions} />
    </>
  );
}

// ------------------------------------------------------------------ per-tool

function EraserOptions({
  settings,
  actions,
}: {
  settings: BoardToolSettings;
  actions: BoardToolActions;
}) {
  const nibs: { shape: BoardEraserShape; label: string; icon: LucideIcon }[] = [
    { shape: "round", label: "Round nib", icon: Circle },
    { shape: "square", label: "Square nib", icon: Square },
  ];
  const modes: { mode: BoardEraserMode; label: string; icon: LucideIcon }[] = [
    { mode: "object", label: "Erase whole elements", icon: Eraser },
    { mode: "partial", label: "Erase part of a stroke", icon: Scissors },
  ];
  return (
    <>
      <SizeGroup tool="eraser" settings={settings} actions={actions} />
      <Group>
        {nibs.map(({ shape, label, icon: Icon }) => (
          <OptionButton
            key={shape}
            label={label}
            active={settings.eraserShape === shape}
            onClick={() => actions.setEraserShape(shape)}
          >
            <Icon size={13} />
          </OptionButton>
        ))}
      </Group>
      <Group>
        {modes.map(({ mode, label, icon: Icon }) => (
          <OptionButton
            key={mode}
            label={label}
            active={settings.eraserMode === mode}
            onClick={() => actions.setEraserMode(mode)}
          >
            <Icon size={14} />
          </OptionButton>
        ))}
      </Group>
      <Group>
        {/* Opens the workspace's confirmation - see BoardToolActions.clearBoard. */}
        <OptionButton label="Clear the whole board" danger onClick={actions.clearBoard}>
          <Trash2 size={14} />
        </OptionButton>
      </Group>
    </>
  );
}

function TextOptions({
  settings,
  actions,
}: {
  settings: BoardToolSettings;
  actions: BoardToolActions;
}) {
  const { text } = settings;
  return (
    <>
      <Group>
        {BOARD_FONT_SIZES.map(({ size, label }, index) => (
          <OptionButton
            key={size}
            label={`${label} text (${size}px)`}
            active={text.fontSize === size}
            onClick={() => actions.setTextStyle({ fontSize: size })}
          >
            {/* The glyph is the label: four A's at rising sizes need no word next to them. */}
            <span style={{ fontSize: 9 + index * 3, lineHeight: 1, fontWeight: 600 }}>A</span>
          </OptionButton>
        ))}
      </Group>
      <Group>
        {FONT_FAMILIES.map(({ family, label }) => (
          <OptionButton
            key={family}
            label={label}
            active={text.fontFamily === family}
            onClick={() => actions.setTextStyle({ fontFamily: family })}
          >
            <span style={{ fontFamily: boardFontStack(family), fontSize: 12, lineHeight: 1 }}>Aa</span>
          </OptionButton>
        ))}
      </Group>
      <Group>
        <OptionButton
          label="Bold"
          active={text.bold}
          onClick={() => actions.setTextStyle({ bold: !text.bold })}
        >
          <Bold size={13} />
        </OptionButton>
        <OptionButton
          label="Italic"
          active={text.italic}
          onClick={() => actions.setTextStyle({ italic: !text.italic })}
        >
          <Italic size={13} />
        </OptionButton>
      </Group>
      <Group>
        {ALIGNMENTS.map(({ align, label, icon: Icon }) => (
          <OptionButton
            key={align}
            label={label}
            active={text.align === align}
            onClick={() => actions.setTextStyle({ align })}
          >
            <Icon size={13} />
          </OptionButton>
        ))}
      </Group>
      <Group>
        {TEXT_BACKGROUNDS.map(({ id, label }) => (
          <OptionButton
            key={id}
            label={label}
            active={text.background === id}
            onClick={() => actions.setTextStyle({ background: id })}
          >
            <Swatch color={textBackgroundColor(id, settings.color)} />
          </OptionButton>
        ))}
      </Group>
    </>
  );
}

function ShapeGroup({
  settings,
  actions,
}: {
  settings: BoardToolSettings;
  actions: BoardToolActions;
}) {
  return (
    <Group>
      {SHAPE_OPTIONS.map(({ shape, label, icon: Icon }) => (
        <OptionButton
          key={shape}
          label={label}
          active={settings.shape === shape}
          onClick={() => actions.setShape(shape)}
        >
          <Icon size={14} />
        </OptionButton>
      ))}
    </Group>
  );
}

function FillGroup({
  settings,
  actions,
}: {
  settings: BoardToolSettings;
  actions: BoardToolActions;
}) {
  return (
    <Group>
      {FILLS.map(({ fill, label }) => (
        <OptionButton
          key={fill}
          label={label}
          active={settings.fill === fill}
          onClick={() => actions.setFill(fill)}
        >
          <Swatch color={fillColor(fill, settings.color)} />
        </OptionButton>
      ))}
    </Group>
  );
}

function ArrangeGroup({ actions }: { actions: BoardToolActions }) {
  return (
    <Group>
      <OptionButton label="Bring to front (])" onClick={actions.raiseSelection}>
        <BringToFront size={14} />
      </OptionButton>
      <OptionButton label="Send to back ([)" onClick={actions.lowerSelection}>
        <SendToBack size={14} />
      </OptionButton>
    </Group>
  );
}

function SizeGroup({
  tool,
  settings,
  actions,
}: {
  tool: BoardSizedTool;
  settings: BoardToolSettings;
  actions: BoardToolActions;
}) {
  const presets = BOARD_TOOL_SIZES[tool];
  const labels = tool === "eraser" ? BOARD_ERASER_SIZE_LABELS : BOARD_SIZE_LABELS;
  const largest = presets[presets.length - 1];
  return (
    <Group>
      {presets.map((size, index) => {
        // Each preview is the preset's real size scaled into the button, so the dots read as the
        // ratio between the actual nib widths rather than as three arbitrary sizes.
        const diameter = Math.max(4, Math.round((size / largest) * 16));
        const squareNib = tool === "eraser" && settings.eraserShape === "square";
        return (
          <OptionButton
            key={size}
            label={`${labels[index] ?? "Size"} (${size}px)`}
            active={settings.sizes[tool] === index}
            onClick={() => actions.setSize(tool, index)}
          >
            <span
              className={squareNib ? "" : "rounded-full"}
              style={{
                width: diameter,
                height: diameter,
                // The eraser's preview is an outline, matching the nib it draws on the canvas; the
                // drawing tools' previews are filled, like the ink they lay down.
                background: tool === "eraser" ? "transparent" : "currentColor",
                border: tool === "eraser" ? "1.5px solid currentColor" : undefined,
              }}
            />
          </OptionButton>
        );
      })}
    </Group>
  );
}

function StrokeStyleGroup({
  active,
  color,
  onChange,
}: {
  active: BoardStrokeStyle;
  color: string;
  onChange: (style: BoardStrokeStyle) => void;
}) {
  return (
    <Group>
      {STROKE_STYLES.map(({ style, label }) => (
        <OptionButton key={style} label={label} active={active === style} onClick={() => onChange(style)} wide>
          <svg width={22} height={10} viewBox="0 0 22 10" aria-hidden="true">
            <line
              x1={2}
              y1={5}
              x2={20}
              y2={5}
              stroke={active === style ? color : "currentColor"}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={dashArray(style, 2)}
            />
          </svg>
        </OptionButton>
      ))}
    </Group>
  );
}

// ------------------------------------------------------------------ elements

function Group({ children }: { children: React.ReactNode }) {
  return <div className="board-option-group">{children}</div>;
}

function OptionButton({
  label,
  active,
  wide,
  danger,
  onClick,
  children,
}: {
  /** Shown as an instant tooltip, and used as the button's accessible name - it has no text of its
   * own (see this module's header). */
  label: string;
  /** Omitted for the buttons that *do* something (clear, arrange) rather than select a setting, so
   * they don't claim to be pressable toggles. */
  active?: boolean;
  /** For previews that need room to read as a line rather than a dot. */
  wide?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tip = useTip();
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      // Keeps the caret where it is: a text box being edited is also the selection these controls
      // act on, and letting the button take focus would blur the contentEditable, so restyling text
      // mid-sentence would silently end the sentence. Doesn't affect keyboard activation.
      onMouseDown={(e) => e.preventDefault()}
      className={`btn-ghost flex h-7 shrink-0 items-center justify-center ${wide ? "w-9" : "w-7"} ${
        active ? "bg-accent-soft text-accent" : ""
      } ${danger ? "hover:text-danger" : ""}`}
      {...tip(label)}
    >
      {children}
    </button>
  );
}

/** A fill preview. "none" gets a diagonal slash rather than an empty box, which would otherwise be
 * indistinguishable from a white fill on a light theme. */
function Swatch({ color }: { color: string }) {
  if (color === "none") {
    return (
      <span className="board-option-swatch">
        <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
          <line x1={2} y1={12} x2={12} y2={2} stroke="currentColor" strokeWidth={1.5} />
        </svg>
      </span>
    );
  }
  return <span className="board-option-swatch" style={{ background: color }} />;
}
