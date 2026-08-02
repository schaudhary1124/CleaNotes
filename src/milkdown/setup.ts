import { commonmark, emphasisSchema, hardbreakFilterNodes, headingSchema, strongSchema } from "@milkdown/kit/preset/commonmark";
import { columnResizingPlugin, gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { codeBlockComponent, codeBlockConfig } from "@milkdown/kit/component/code-block";
import { $prose } from "@milkdown/kit/utils";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, editorViewOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { MarkType } from "@milkdown/kit/prose/model";
import type { EditorState } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";
import { isInTable } from "@milkdown/kit/prose/tables";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import type { XmlFragment } from "yjs";
import { getBlockAlign, getTableCellAlign } from "./alignmentCommands";
import { alignmentSidecarRemark, configureAlignmentSchemas, type BlockAlign } from "./alignmentSchemaExtensions";
import { codeBlockExtensions, codeBlockLanguages } from "./codeBlock";
import { codeBlockGrips } from "./codeBlockGrips";
import { getSelectedImageWrap } from "./imageCommands";
import { imageSchemaExt, imageWrapSidecarRemark, type ImageWrap } from "./imageSchemaExtensions";
import { imageView } from "./imageView";
import { getListState, type ListState } from "./listCommands";
import { taskListToggle } from "./taskListToggle";
import { configureVoiceNoteSchemas, voiceSidecarRemark } from "./voiceNoteSchemaExtensions";
import { voiceNoteGrips } from "./voiceNoteGrips";
import { noteLinkClickPlugin } from "./noteLinkClick";
import type { NoteLinkTarget } from "./noteLinkHref";
import { noteLinkTriggerPlugin, type NoteLinkTriggerChoice, type NoteLinkTriggerInfo } from "./noteLinkTrigger";
import { notePinPlugins } from "./notePin";
import { notePinView } from "./notePinView";
import { noteLinkChipPlugins } from "./noteLinkChip";
import { noteLinkChipView } from "./noteLinkChipView";
import type { RefObject } from "react";
import { tabTrap } from "./tabTrap";
import { tableLineBreak } from "./tableLineBreak";
import { tableCellBreakRemark, tableSchemaExtensionPlugins, tableSidecarRemark } from "./tableSchemaExtensions";
import { tableGrips } from "./tableGrips";
import { highlightSchema, strikethroughSchema, textDecorationPlugins, underlineSchema } from "./textDecorationMarks";

export type BlockStyle = "paragraph" | 1 | 2 | 3;

export interface EditorSelectionState {
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
  imageWrap: ImageWrap | null;
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

export function getSelectionState(ctx: Ctx): EditorSelectionState {
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
    imageWrap: getSelectedImageWrap(ctx),
  };
}

/** `{from, to}` of the current selection, reported only while it's a genuine highlighted text
 * range - see reportSelectionRange below. Drives the floating selection toolbar in Editor.tsx. */
export interface EditorSelectionRange {
  from: number;
  to: number;
}

/** Binds the editor to a live collaboration session - see src/collab/hostSession.ts (owner) and
 * src/collab/yjsBridge.ts (guest), which create `yXmlFragment` for the owner (hostSession) or a
 * guest (joinSession) respectively. Passing this swaps Milkdown's plain undo/redo history for
 * Yjs-aware undo (see yUndoPlugin below, which only undoes *this device's own* edits, never a
 * collaborator's) and, when `canEdit` is false (a Viewer, or the note is currently locked),
 * makes the editor read-only. */
export interface CollabPluginConfig {
  yXmlFragment: XmlFragment;
  canEdit: boolean;
  /** Live cursors/selections/presence - see src/collab/hostSession.ts/yjsBridge.ts. Optional
   * only so a caller mid-transition (e.g. the moment a session ends) can't be forced to
   * fabricate one; in practice both hostSession and joinSession always provide it. */
  awareness?: Awareness;
}

/** Assembles the full Milkdown plugin set used by the note editor: GFM +
 * commonmark formatting, undo/redo, clipboard/paste handling, the resolved
 * image view, and the custom flashcard/MCQ block. */
export function registerMilkdownPlugins(
  editor: Editor,
  notePath: string,
  onMarkdownUpdated: (markdown: string) => void,
  onSelectionStateChanged?: (state: EditorSelectionState) => void,
  onNavigateToNoteLink?: (target: NoteLinkTarget) => void,
  onNoteLinkTriggerChange?: (info: NoteLinkTriggerInfo | null) => void,
  noteLinkResultsRef?: RefObject<NoteLinkTriggerChoice[]>,
  onSelectionRangeChanged?: (range: EditorSelectionRange | null) => void,
  // Whether the add-voice-note affordance should be included - see voiceNoteGrips.ts for what
  // this gates. Fixed at editor construction (like every other plugin here), so toggling it
  // requires remounting the Editor - see App.tsx's Editor `key`.
  voiceNotesEnabled: boolean = true,
  collabSession?: CollabPluginConfig,
) {
  function reportSelectionState(ctx: Ctx) {
    if (!onSelectionStateChanged) return;
    onSelectionStateChanged(getSelectionState(ctx));
  }

  // Only a non-empty plain-text selection counts - a collapsed cursor has nothing to link, and a
  // NodeSelection (an image, a table cell range) already has its own contextual toolbar
  // (SelectedImageToolbar/TableMenu), so this deliberately stays out of their way.
  function reportSelectionRange(ctx: Ctx) {
    if (!onSelectionRangeChanged) return;
    const { selection } = ctx.get(editorViewCtx).state;
    onSelectionRangeChanged(
      selection instanceof TextSelection && !selection.empty ? { from: selection.from, to: selection.to } : null,
    );
  }

  const withCoreSchema = editor
    .config((ctx) => {
      ctx
        .get(listenerCtx)
        .markdownUpdated((_ctx, markdown, prevMarkdown) => {
          if (markdown !== prevMarkdown) onMarkdownUpdated(markdown);
        })
        .updated((updatedCtx) => {
          reportSelectionState(updatedCtx);
          reportSelectionRange(updatedCtx);
        })
        // selectionUpdated fires from inside the plugin's state.apply, before
        // view.state has been reassigned to the new state - read on the next
        // microtask so editorViewCtx reflects the transaction that just landed.
        .selectionUpdated((updatedCtx) =>
          queueMicrotask(() => {
            reportSelectionState(updatedCtx);
            reportSelectionRange(updatedCtx);
          }),
        );
      ctx.update(codeBlockConfig.key, (prev) => ({
        ...prev,
        languages: codeBlockLanguages,
        extensions: codeBlockExtensions,
      }));
      // Milkdown's hardbreakFilterPlugin silently drops any hardbreak
      // (Shift-Enter, and now plain Enter via tableLineBreak.ts) inserted
      // inside a node listed here - "table" is in its default block-list, so
      // without this override a line break inside a table cell would keep
      // silently failing even after tableLineBreak.ts reroutes Enter to it.
      // "code_block" stays filtered: it renders via its own CodeMirror node
      // view (see codeBlock.ts), which doesn't use inline hardbreak nodes.
      ctx.update(hardbreakFilterNodes.key, (prev) => prev.filter((name) => name !== "table"));
      // Patches paragraph/heading's existing schema in place rather than
      // `.use()`-ing an `.extendSchema()`'d replacement (contrast with
      // tableSchemaExtensionPlugins below) - see configureAlignmentSchemas's
      // own comment for why that distinction matters here.
      configureAlignmentSchemas(ctx);
      // Layered after configureAlignmentSchemas so the two patches' sidecar comments emit in a
      // fixed, deterministic order - see voiceNoteSchemaExtensions.ts's own comment.
      configureVoiceNoteSchemas(ctx);
      // Read-only for a Viewer collaborator (or when the owner has the note locked) - this is
      // a UX signal only, not the actual security boundary, which lives entirely on the
      // owner's device (see hostSession.ts's hostSession: it never applies/rebroadcasts an
      // inbound update from a non-editor, independent of what this device's own UI allows).
      if (collabSession && !collabSession.canEdit) {
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
      }
    })
    // Registered before commonmark/gfm so its handleKeyDown - which
    // intercepts plain Enter inside a table cell - runs before gfm's own
    // tableKeymap ("ExitTable" is also bound to plain Enter and would
    // otherwise win first, see tableLineBreak.ts).
    .use(tableLineBreak)
    .use(commonmark)
    .use(gfm)
    // Swaps the plain <pre><code> rendering commonmark's codeBlockSchema
    // gives fenced code blocks for a CodeMirror 6 node view - VSCode-style
    // syntax highlighting, a language picker, and a copy button. Depends on
    // codeBlockSchema, which commonmark just registered above.
    .use(codeBlockComponent)
    // Adds the delete affordance the component above doesn't ship - see
    // codeBlockGrips.ts.
    .use(codeBlockGrips(notePath))
    // Registered after gfm so these table extensions (background/height
    // attrs, the markdown sidecar comment) override gfm's own node schemas -
    // Milkdown dedups node schemas by id and the last one `.use()`d wins.
    .use(tableSchemaExtensionPlugins)
    // Must also come after gfm: it needs remarkGFM to have already turned
    // raw pipe tables into mdast `table` nodes before it can attach the
    // sidecar comment's data onto them.
    .use(tableSidecarRemark)
    // Same ordering requirement as tableSidecarRemark - see
    // tableCellBreakRemark's own comment for what this fixes.
    .use(tableCellBreakRemark)
    // Same ordering requirement as tableSidecarRemark: needs commonmark's
    // remarkHtmlTransformer to have already run so raw sidecar HTML nodes are
    // in their final flat shape. (The paragraph/heading schema patch itself
    // is applied eagerly in .config() above, not here - see
    // configureAlignmentSchemas.)
    .use(alignmentSidecarRemark)
    // Same ordering requirement as alignmentSidecarRemark, plus its own list-item-vs-sibling
    // ordering internally - see voiceNoteSchemaExtensions.ts. (Its own paragraph/heading/
    // list-item schema patches are applied eagerly in .config() above, not here - see
    // configureVoiceNoteSchemas.)
    .use(voiceSidecarRemark)
    // Overrides commonmark's `image` node schema with the `wrap` attr - safe
    // to `.use()` under the existing "image" id (see imageSchemaExt's own
    // comment for why, unlike paragraph/heading above).
    .use(imageSchemaExt)
    // Needs commonmark's inline-html parsing already settled, same ordering
    // requirement as the sidecar plugins above.
    .use(imageWrapSidecarRemark)
    // Same ordering requirement as tableSidecarRemark: needs commonmark's
    // remarkHtmlTransformer and gfm's own remark plugins to have already run
    // so raw `<mark>`/`<u>` HTML nodes are in their final flat shape.
    .use(textDecorationPlugins)
    .use(columnResizingPlugin)
    .use(tableGrips);

  // Yjs-aware undo (only ever undoes *this device's own* edits - see yUndoPlugin's default
  // trackedOrigins, which tracks ySyncPluginKey and nothing else, so a collaborator's inbound
  // update, applied with their peerId as origin in yjsBridge.ts, is automatically excluded from
  // this device's undo stack) replaces Milkdown's plain history plugin when collaborating -
  // the two are mutually exclusive, never both registered at once.
  const withHistory = collabSession
    ? withCoreSchema
        .use($prose(() => ySyncPlugin(collabSession.yXmlFragment)))
        .use($prose(() => yUndoPlugin()))
        // Renders every other connected collaborator's live cursor/selection as a colored
        // caret + name tag (see index.css's .ProseMirror-yjs-cursor/-selection rules) -
        // conditional on awareness actually being provided, same as the rest of this block.
        .use(collabSession.awareness ? $prose(() => yCursorPlugin(collabSession.awareness!)) : [])
    : withCoreSchema.use(history);

  return withHistory
    .use(listener)
    .use(clipboard)
    .use(trailing)
    .use(cursor)
    .use(imageView)
    .use(taskListToggle)
    // The margin "add voice note"/pill affordance and its recording handling - see
    // voiceNoteGrips.ts. Needs `notePath` (for writeAttachment when a recording is saved), which
    // none of the other plugins here require - same reasoning imageCommands.ts's insertImageFile
    // in Editor.tsx already closes over `notePath` for the same call.
    .use(voiceNoteGrips(notePath, voiceNotesEnabled))
    // The `notePin` atom node ("Copy link to this point" in the selection toolbar - see
    // notePin.ts/notePinView.ts) and its markdown round-trip. Same ordering requirement as the
    // other sidecar remarks: must come after commonmark/gfm above.
    .use(notePinPlugins)
    .use(notePinView)
    // The `noteLinkChip` atom (a pasted-with-no-selection note:// link, standing in for a `link`
    // mark - see noteLinkChip.ts/noteLinkChipView.ts). Same ordering requirement as notePinPlugins.
    .use(noteLinkChipPlugins)
    .use(noteLinkChipView((target) => onNavigateToNoteLink?.(target)))
    // Click handling (LinkPopover) and Cmd/Ctrl-click fast-path navigation for `link`-marked
    // text - see noteLinkClick.ts.
    .use(noteLinkClickPlugin((target) => onNavigateToNoteLink?.(target)))
    // The `[[` live autocomplete trigger - see noteLinkTrigger.ts. Registered after
    // noteLinkClickPlugin (no ordering requirement between the two, just grouped together).
    .use(
      noteLinkTriggerPlugin({
        onTriggerChange: (info) => onNoteLinkTriggerChange?.(info),
        resultsRef: noteLinkResultsRef ?? { current: [] },
      }),
    )
    // Registered last so the list-sink and table-next-cell Tab shortcuts
    // above get first chance at the key - see tabTrap.ts.
    .use(tabTrap);
}
