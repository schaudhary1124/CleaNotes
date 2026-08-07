import {
  Bold,
  Brush,
  Code,
  Highlighter,
  ImagePlus,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Minus as DividerIcon,
  Printer,
  RemoveFormatting,
  Strikethrough,
  Underline,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Ctx } from "@milkdown/kit/ctx";
import { callCommand } from "@milkdown/kit/utils";
import { createCodeBlockCommand, insertHrCommand, toggleEmphasisCommand, toggleStrongCommand } from "@milkdown/kit/preset/commonmark";
import { ToolbarButtonGroup, type ToolbarAction } from "../components/ToolbarButtonGroup";
import { ALIGN_OPTIONS, TableMenu } from "../components/TableMenu";
import { LookDropdown } from "../components/LookDropdown";
import { PageSetupDropdown } from "../components/PageSetupDropdown";
import { TextStyleDropdown } from "../components/TextStyleDropdown";
import { setBlockAlign, setTableColumnAlign } from "../milkdown/alignmentCommands";
import {
  DEFAULT_DECORATION_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  highlightSchema,
  strikethroughSchema,
  toggleTextDecoration,
  underlineSchema,
} from "../milkdown/textDecorationMarks";
import { clearFormatting, setBlockStyle } from "../milkdown/formatCommands";
import { liftOutOfList, toggleBulletList, toggleOrderedList, toggleTaskItem } from "../milkdown/listCommands";
import { addTableColumn, addTableRow, deleteCurrentTable, deleteTableColumn, deleteTableRow, insertTable, setTableCellBackground } from "../milkdown/tableCommands";
import type { NoteLook, PageSetup } from "../types";
import type { BrowserSelectionState } from "./browserSelectionState";

interface BrowserToolbarProps {
  selectionState: BrowserSelectionState;
  run: (action: (ctx: Ctx) => unknown) => void;
  look: NoteLook;
  onSelectLook: (look: NoteLook) => void;
  codeBlockEnabled: boolean;
  onInsertImage: () => void;
  uploadError: string | null;
  /** Hidden entirely (not just disabled) for a viewer, matching onInsertImage's own affordance -
   * see BrowserEditor.tsx, which only renders this whole toolbar at all when canEdit. */
  onToggleSketchMode: () => void;
  /** Fixed-Size (kind === "fixed-size") support - see Editor.tsx's identical `paginated` prop
   * for why this stays a plain prop rather than a global feature flag. */
  paginated: boolean;
  pageSetup: PageSetup;
  onChangePageSetup: (next: PageSetup) => void;
  onPrint: () => void;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
}

/** The browser-guest build's formatting toolbar - structurally the same subset of
 * Editor.tsx's toolbar as minimalMilkdownSetup.ts registers plugins for (see that file's own
 * comment for what's deliberately excluded: sketch, voice notes, note-linking, image insert).
 * Reuses the same extracted sub-components (ToolbarButtonGroup/TableMenu/LookDropdown/
 * TextStyleDropdown - see src/components/) and the same command functions Editor.tsx calls,
 * just without that file's sketch-mode/note-linking/voice-note-specific wiring around them. */
export function BrowserToolbar({
  selectionState,
  run,
  look,
  onSelectLook,
  codeBlockEnabled,
  onInsertImage,
  uploadError,
  onToggleSketchMode,
  paginated,
  pageSetup,
  onChangePageSetup,
  onPrint,
  zoom,
  onZoomOut,
  onZoomIn,
}: BrowserToolbarProps) {
  const emphasisGroup: ToolbarAction[] = [
    { icon: Bold, label: "Bold", action: () => run((ctx) => callCommand(toggleStrongCommand.key)(ctx)), isActive: selectionState.bold },
    { icon: Italic, label: "Italic", action: () => run((ctx) => callCommand(toggleEmphasisCommand.key)(ctx)), isActive: selectionState.italic },
  ];

  const decorationGroup: ToolbarAction[] = [
    {
      icon: Highlighter,
      label: "Highlight",
      action: () => run((ctx) => toggleTextDecoration(ctx, highlightSchema.type(ctx), { color: DEFAULT_HIGHLIGHT_COLOR })),
      isActive: selectionState.highlight,
    },
    {
      icon: Underline,
      label: "Underline",
      action: () => run((ctx) => toggleTextDecoration(ctx, underlineSchema.type(ctx), { color: DEFAULT_DECORATION_COLOR })),
      isActive: selectionState.underline,
    },
    {
      icon: Strikethrough,
      label: "Strikethrough",
      action: () => run((ctx) => toggleTextDecoration(ctx, strikethroughSchema.type(ctx), { color: DEFAULT_DECORATION_COLOR })),
      isActive: selectionState.strikethrough,
    },
  ];

  // Same reasoning as Editor.tsx: list_item requires a paragraph as its first child, so a
  // heading line can't be wrapped into one - disable rather than silently no-op.
  const listDisabled = selectionState.blockStyle !== "paragraph";
  const listGroup: ToolbarAction[] = [
    { icon: List, label: "Bullet list", action: () => run(toggleBulletList), isActive: selectionState.list === "bullet", disabled: listDisabled },
    {
      icon: ListOrdered,
      label: "Numbered list",
      action: () => run(toggleOrderedList),
      isActive: selectionState.list === "ordered",
      disabled: listDisabled,
    },
    { icon: ListChecks, label: "Checklist", action: () => run(toggleTaskItem), isActive: selectionState.list === "task", disabled: listDisabled },
  ];

  const alignGroup: ToolbarAction[] = ALIGN_OPTIONS.map(({ align, label, icon }) => ({
    icon,
    label,
    action: () => run((ctx) => setBlockAlign(ctx, align)),
    isActive: selectionState.align === align,
  }));

  return (
    <div className="border-subtle flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
      <button
        type="button"
        onClick={onToggleSketchMode}
        title="Sketch on this note"
        aria-label="Toggle sketch mode"
        aria-pressed="false"
        className="btn-ghost h-7 w-7 shrink-0"
      >
        <Brush size={14} />
      </button>
      <div className="divider mx-1 h-5 w-px shrink-0" />
      <TextStyleDropdown
        blockStyle={selectionState.blockStyle}
        onSelect={(style) =>
          run((ctx) => {
            liftOutOfList(ctx);
            setBlockStyle(ctx, style);
          })
        }
      />
      <div className="divider mx-1 h-5 w-px shrink-0" />
      <ToolbarButtonGroup items={emphasisGroup} />
      <ToolbarButtonGroup items={decorationGroup} />
      <ToolbarButtonGroup items={listGroup} />
      <ToolbarButtonGroup items={alignGroup} />
      <button
        type="button"
        onClick={() => run((ctx) => clearFormatting(ctx))}
        title="Clear formatting"
        aria-label="Clear formatting"
        className="btn-ghost h-7 w-7 shrink-0"
      >
        <RemoveFormatting size={14} />
      </button>
      <TableMenu
        inTable={selectionState.inTable}
        cellAlign={selectionState.cellAlign}
        onInsert={(row, col) => run((ctx) => insertTable(ctx, row, col))}
        onAddRow={() => run(addTableRow)}
        onAddColumn={() => run(addTableColumn)}
        onDeleteRow={() => run(deleteTableRow)}
        onDeleteColumn={() => run(deleteTableColumn)}
        onDeleteTable={() => run(deleteCurrentTable)}
        onSetCellColor={(color) => run((ctx) => setTableCellBackground(ctx, color))}
        onSetCellAlign={(align) => run((ctx) => setTableColumnAlign(ctx, align))}
      />
      <button
        type="button"
        onClick={() => run((ctx) => callCommand(insertHrCommand.key)(ctx))}
        title="Divider"
        aria-label="Divider"
        className="btn-ghost h-7 w-7 shrink-0"
      >
        <DividerIcon size={14} />
      </button>
      <button
        type="button"
        onClick={onInsertImage}
        title="Insert image"
        aria-label="Insert image"
        className="btn-ghost h-7 w-7 shrink-0"
      >
        <ImagePlus size={14} />
      </button>
      {codeBlockEnabled && (
        <button
          type="button"
          onClick={() => run((ctx) => callCommand(createCodeBlockCommand.key)(ctx))}
          title="Code block"
          aria-label="Code block"
          className="btn-ghost h-7 w-7 shrink-0"
        >
          <Code size={14} />
        </button>
      )}
      <div className="divider mx-1 h-5 w-px shrink-0" />
      {paginated && (
        <>
          <PageSetupDropdown setup={pageSetup} onChange={onChangePageSetup} />
          <button
            type="button"
            onClick={onPrint}
            title="Print / export as PDF"
            aria-label="Print / export as PDF"
            className="btn-ghost h-7 w-7 shrink-0"
          >
            <Printer size={14} />
          </button>
          <div className="divider mx-1 h-5 w-px shrink-0" />
          <button
            type="button"
            onClick={onZoomOut}
            disabled={zoom <= 0.5}
            title="Zoom out"
            aria-label="Zoom out"
            className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-40"
          >
            <ZoomOut size={14} />
          </button>
          <span className="text-secondary w-10 shrink-0 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={onZoomIn}
            disabled={zoom >= 2}
            title="Zoom in"
            aria-label="Zoom in"
            className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-40"
          >
            <ZoomIn size={14} />
          </button>
        </>
      )}
      <LookDropdown look={look} onSelect={onSelectLook} />
      {uploadError && <span className="text-danger ml-2 shrink-0 text-xs">{uploadError}</span>}
    </div>
  );
}
