import { Editor as MilkdownEditor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import type { JoinedSession } from "../collab/yjsBridge";
import { usePresence } from "../collab/usePresence";
import { registerMinimalMilkdownPlugins } from "./minimalMilkdownSetup";

interface BrowserEditorProps {
  session: JoinedSession;
  canEdit: boolean;
}

function MilkdownBody({ session, canEdit }: BrowserEditorProps) {
  useEditor(
    (root) => {
      const editor = MilkdownEditor.make();
      editor.config((ctx) => {
        ctx.set(rootCtx, root);
        // Empty on purpose: session.yXmlFragment is already hydrated with the note's real
        // content by the time JoinedSession resolves (see that field's own doc comment in
        // yjsBridge.ts) - ySyncPlugin (registered below) binds to that, not to this default.
        // Mirrors SharedNoteView.tsx's identical initialContent="" for the desktop guest view,
        // for exactly the same reason - never bind a live editor to a doc that might still be
        // empty (see the implementation plan's data-loss history for why this matters).
        ctx.set(defaultValueCtx, "");
      });
      registerMinimalMilkdownPlugins(editor, { yXmlFragment: session.yXmlFragment, canEdit, awareness: session.awareness });
      return editor;
      // Mounted only once per BrowserEditor instance - the parent (App.tsx) swaps this whole
      // component out for a connecting/offline screen on any disconnect, so a *new* session only
      // ever arrives via a fresh mount, never as a prop change on an already-mounted instance.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [],
  );

  return <Milkdown />;
}

/** The browser-guest build's whole editing surface: a title bar with presence avatars, and the
 * Milkdown body bound to the live session. No sidebar, no tabs, no note-switching - there is
 * exactly one note in scope for the lifetime of this page. */
export function BrowserEditor({ session, canEdit }: BrowserEditorProps) {
  const presence = usePresence(session.awareness);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      <div className="border-subtle flex items-center justify-between border-b px-6 py-3">
        <p className="text-primary truncate text-sm font-semibold">{session.title}</p>
        <div className="flex items-center gap-2">
          {!canEdit && <span className="text-tertiary text-xs">View only</span>}
          {presence.length > 0 && (
            <div className="flex items-center gap-1" title={presence.map((p) => p.name).join(", ")}>
              {presence.map((p) => (
                <div
                  key={p.clientId}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                  style={{ backgroundColor: p.color }}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="prose-note flex-1 overflow-y-auto px-6 py-6">
        <MilkdownProvider>
          <MilkdownBody session={session} canEdit={canEdit} />
        </MilkdownProvider>
      </div>
    </div>
  );
}
