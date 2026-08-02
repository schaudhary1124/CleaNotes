import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { $prose } from "@milkdown/kit/utils";
import type { Editor } from "@milkdown/kit/core";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import type { XmlFragment } from "yjs";

export interface MinimalCollabConfig {
  yXmlFragment: XmlFragment;
  canEdit: boolean;
  awareness: Awareness;
}

/**
 * The browser-guest build's own, deliberately small Milkdown plugin set: basic Markdown
 * formatting (commonmark + gfm) plus the same Yjs collab-binding pattern src/milkdown/setup.ts
 * uses (ySyncPlugin/yUndoPlugin/yCursorPlugin) - and nothing else. Not registerMilkdownPlugins
 * from that file on purpose: it also wires up voice notes, note-to-note linking (whose click
 * handler imports @tauri-apps/plugin-opener), table grips, and attachment writes through
 * fsNotes.ts - all real desktop features, all out of scope for "edit exactly one note, no vault,
 * no filesystem" (see the implementation plan's constraints).
 *
 * There's also no markdown-serialization listener here at all, unlike the desktop editor: this
 * one has no local file to autosave to. The Yjs sync in `yXmlFragment` (already hydrated with
 * the note's real content by the time JoinedSession resolves - see yjsBridge.ts) is the only
 * content path in both directions.
 */
export function registerMinimalMilkdownPlugins(editor: Editor, collab: MinimalCollabConfig) {
  return editor
    .config((ctx) => {
      // Read-only for a Viewer, or if the owner has the note locked - same UX-only signal as
      // setup.ts's identical check; the real enforcement lives entirely on the owner's device
      // (see yjsBridge.ts's hostSession, which never applies/rebroadcasts an inbound update from
      // a non-editor regardless of what this device's own UI allows).
      if (!collab.canEdit) {
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
      }
    })
    .use(commonmark)
    .use(gfm)
    .use($prose(() => ySyncPlugin(collab.yXmlFragment)))
    .use($prose(() => yUndoPlugin()))
    .use($prose(() => yCursorPlugin(collab.awareness)))
    .use(clipboard)
    .use(trailing)
    .use(cursor);
}
