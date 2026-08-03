import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { emphasisSchema, headingSchema, strongSchema } from "@milkdown/kit/preset/commonmark";
import type { MarkType } from "@milkdown/kit/prose/model";
import type { EditorState } from "@milkdown/kit/prose/state";
import { isInTable } from "@milkdown/kit/prose/tables";
import { getBlockAlign, getTableCellAlign } from "../milkdown/alignmentCommands";
import type { BlockAlign } from "../milkdown/alignmentSchemaExtensions";
import { getListState, type ListState } from "../milkdown/listCommands";
import { highlightSchema, strikethroughSchema, underlineSchema } from "../milkdown/textDecorationMarks";

/**
 * A trimmed copy of setup.ts's getSelectionState/EditorSelectionState, for the browser-guest
 * toolbar - not imported from setup.ts directly, deliberately: that file also imports
 * milkdown/imageCommands.ts (for the desktop toolbar's image-wrap picker), which itself
 * imports milkdown/imageView.ts, which imports fsNotes.ts's readAttachment
 * (`@tauri-apps/plugin-fs`). Importing setup.ts at all would pull that whole chain into the
 * browser build's module graph. This copy simply omits the one field (`imageWrap`) that chain
 * was for - image support isn't part of the browser toolbar yet (see the implementation plan's
 * Part F) - so there's nothing here to omit deliberately vs. by missing a field; the type is
 * just smaller because the browser toolbar has less to report.
 */

export type BlockStyle = "paragraph" | 1 | 2 | 3;

export interface BrowserSelectionState {
  bold: boolean;
  italic: boolean;
  highlight: boolean;
  underline: boolean;
  strikethrough: boolean;
  blockStyle: BlockStyle;
  list: ListState;
  inTable: boolean;
  align: BlockAlign;
  cellAlign: BlockAlign;
}

function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function getBlockStyle(ctx: Ctx, state: EditorState): BlockStyle {
  const node = state.selection.$from.node();
  if (node.type === headingSchema.type(ctx) && [1, 2, 3].includes(node.attrs.level)) {
    return node.attrs.level as 1 | 2 | 3;
  }
  return "paragraph";
}

export function getBrowserSelectionState(ctx: Ctx): BrowserSelectionState {
  const state = ctx.get(editorViewCtx).state;
  return {
    bold: isMarkActive(state, strongSchema.type(ctx)),
    italic: isMarkActive(state, emphasisSchema.type(ctx)),
    highlight: isMarkActive(state, highlightSchema.type(ctx)),
    underline: isMarkActive(state, underlineSchema.type(ctx)),
    strikethrough: isMarkActive(state, strikethroughSchema.type(ctx)),
    blockStyle: getBlockStyle(ctx, state),
    list: getListState(ctx),
    inTable: isInTable(state),
    align: getBlockAlign(ctx),
    cellAlign: getTableCellAlign(ctx),
  };
}
