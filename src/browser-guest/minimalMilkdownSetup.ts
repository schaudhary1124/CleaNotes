import { commonmark, hardbreakFilterNodes } from "@milkdown/kit/preset/commonmark";
import { columnResizingPlugin, gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { codeBlockComponent, codeBlockConfig } from "@milkdown/kit/component/code-block";
import { $prose } from "@milkdown/kit/utils";
import type { Editor } from "@milkdown/kit/core";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import type { XmlFragment, Array as YArray } from "yjs";
import { alignmentSidecarRemark, configureAlignmentSchemas } from "../milkdown/alignmentSchemaExtensions";
import { codeBlockExtensions, codeBlockLanguages } from "../milkdown/codeBlock";
import { codeBlockGrips } from "../milkdown/codeBlockGrips";
import { imageSchemaExt, imageWrapSidecarRemark } from "../milkdown/imageSchemaExtensions";
import { imageView } from "../milkdown/imageView";
import { taskListToggle } from "../milkdown/taskListToggle";
import { tableCellBreakRemark, tableSchemaExtensionPlugins, tableSidecarRemark } from "../milkdown/tableSchemaExtensions";
import { tableGrips } from "../milkdown/tableGrips";
import { tableLineBreak } from "../milkdown/tableLineBreak";
import { textDecorationPlugins } from "../milkdown/textDecorationMarks";
import type { SketchStroke } from "../types";
import { getBrowserSelectionState, type BrowserSelectionState } from "./browserSelectionState";
import { idbAssetStore } from "./idbAssetStore";

/**
 * The browser-guest build's own, deliberately small Milkdown plugin set: full-ish Markdown
 * formatting (commonmark + gfm + alignment/text-decoration/table/code-block support) plus the
 * same Yjs collab-binding pattern src/milkdown/setup.ts uses (ySyncPlugin/yUndoPlugin/
 * yCursorPlugin) - and nothing beyond that. Not registerMilkdownPlugins from that file on
 * purpose: it also wires up voice notes, note-to-note linking (whose click handler imports
 * @tauri-apps/plugin-opener), and image insert/attachment writes through fsNotes.ts - all real
 * desktop features, all out of scope for "edit exactly one note, no vault, no filesystem" (see
 * the implementation plan's constraints). Images *are* wired up (imageSchemaExt/imageView, same
 * as setup.ts) - they're backed by idbAssetStore instead of desktop's fsAssetStore, but the
 * schema and NodeView themselves are the exact same code, shared via imageView.ts's injectable
 * ImageAssetResolver (see its own comment for why that split exists).
 *
 * There's also no markdown-serialization listener registered for its own sake here, unlike the
 * desktop editor: this one has no local file to autosave to. `listener`/`listenerCtx` is
 * registered only because getBrowserSelectionState needs it to drive the toolbar's active/
 * disabled button states - the markdownUpdated hook itself is never used. The Yjs sync in
 * `yXmlFragment` (already hydrated by the time JoinedSession resolves - see yjsBridge.ts) is
 * the only actual content path, both in and out.
 */

export interface MinimalCollabConfig {
  yXmlFragment: XmlFragment;
  canEdit: boolean;
  awareness: Awareness;
  ySketchStrokes?: YArray<SketchStroke>;
  resolveAsset?: (key: string) => Promise<Uint8Array>;
}

export function registerMinimalMilkdownPlugins(
  editor: Editor,
  noteId: string,
  collab: MinimalCollabConfig,
  onSelectionStateChanged?: (state: BrowserSelectionState) => void,
  codeBlockEnabled: boolean = true,
) {
  const withCoreSchema = editor
    .config((ctx) => {
      if (onSelectionStateChanged) {
        ctx
          .get(listenerCtx)
          .updated((updatedCtx) => onSelectionStateChanged(getBrowserSelectionState(updatedCtx)))
          // selectionUpdated fires from inside the plugin's state.apply, before view.state has
          // been reassigned to the new state - read on the next microtask, same reasoning as
          // setup.ts's identical handler.
          .selectionUpdated((updatedCtx) => queueMicrotask(() => onSelectionStateChanged(getBrowserSelectionState(updatedCtx))));
      }
      if (codeBlockEnabled) {
        ctx.update(codeBlockConfig.key, (prev) => ({ ...prev, languages: codeBlockLanguages, extensions: codeBlockExtensions }));
      }
      // Same table-cell hardbreak fix as setup.ts - see its own comment for why "table" needs
      // to come out of the default block-list for tableLineBreak's Enter handling to work.
      ctx.update(hardbreakFilterNodes.key, (prev) => prev.filter((name) => name !== "table"));
      configureAlignmentSchemas(ctx);
      if (!collab.canEdit) {
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
      }
    })
    // Registered before commonmark/gfm - see setup.ts's identical ordering comment (its
    // handleKeyDown needs first crack at plain Enter inside a table cell, ahead of gfm's own
    // tableKeymap).
    .use(tableLineBreak)
    .use(commonmark)
    .use(gfm)
    .use(tableSchemaExtensionPlugins)
    .use(tableSidecarRemark)
    .use(tableCellBreakRemark)
    .use(alignmentSidecarRemark)
    .use(imageSchemaExt)
    .use(imageWrapSidecarRemark)
    .use(textDecorationPlugins)
    .use(columnResizingPlugin)
    .use(tableGrips);

  const withCodeBlock = codeBlockEnabled ? withCoreSchema.use(codeBlockComponent).use(codeBlockGrips(noteId)) : withCoreSchema;

  return withCodeBlock
    .use($prose(() => ySyncPlugin(collab.yXmlFragment)))
    .use($prose(() => yUndoPlugin()))
    .use($prose(() => yCursorPlugin(collab.awareness)))
    .use(listener)
    .use(clipboard)
    .use(trailing)
    .use(cursor)
    .use(imageView({ store: idbAssetStore, fetchRemote: collab.resolveAsset }))
    .use(taskListToggle);
}
