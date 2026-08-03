import { useCallback, useState } from "react";
import { Editor as MilkdownEditor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import type { JoinedSession } from "../collab/yjsBridge";
import { usePresence } from "../collab/usePresence";
import { applySettingsToDocument, loadSettings, saveSettings } from "../utils/settings";
import type { AppSettings, NoteLook } from "../types";
import { registerMinimalMilkdownPlugins } from "./minimalMilkdownSetup";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserSettingsPopover } from "./BrowserSettingsPopover";
import { loadNoteLook, saveNoteLook } from "./noteLook";
import type { BrowserSelectionState } from "./browserSelectionState";

interface BrowserEditorProps {
  session: JoinedSession;
  canEdit: boolean;
  noteId: string;
}

const EMPTY_SELECTION_STATE: BrowserSelectionState = {
  bold: false,
  italic: false,
  highlight: false,
  underline: false,
  strikethrough: false,
  blockStyle: "paragraph",
  list: null,
  inTable: false,
  align: "left",
  cellAlign: "left",
};

function BrowserEditorBody({ session, canEdit, noteId }: BrowserEditorProps) {
  const [selectionState, setSelectionState] = useState(EMPTY_SELECTION_STATE);
  const [look, setLook] = useState<NoteLook>(() => loadNoteLook(noteId));

  const { get } = useEditor(
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
      registerMinimalMilkdownPlugins(
        editor,
        noteId,
        { yXmlFragment: session.yXmlFragment, canEdit, awareness: session.awareness },
        setSelectionState,
        session.features.codeBlock,
      );
      return editor;
      // Mounted only once per BrowserEditor instance - the parent (browser-guest/App.tsx) swaps
      // this whole component out for a connecting/offline screen on any disconnect, so a *new*
      // session only ever arrives via a fresh mount, never as a prop change on an
      // already-mounted instance.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [],
  );

  const run = useCallback((action: (ctx: Ctx) => unknown) => get()?.action(action), [get]);

  function handleSelectLook(next: NoteLook) {
    setLook(next);
    saveNoteLook(noteId, next);
  }

  return (
    <>
      {canEdit && (
        <BrowserToolbar
          selectionState={selectionState}
          run={run}
          look={look}
          onSelectLook={handleSelectLook}
          codeBlockEnabled={session.features.codeBlock}
        />
      )}
      <div className={`prose-note flex-1 overflow-y-auto px-6 py-6 ${look !== "plain" ? `note-look-${look}` : ""}`}>
        <Milkdown />
      </div>
    </>
  );
}

/** The browser-guest build's whole editing surface: a title bar with presence avatars and a
 * theme/accent picker, the formatting toolbar, and the Milkdown body bound to the live session.
 * No sidebar, no tabs, no note-switching - there is exactly one note in scope for the lifetime
 * of this page. */
export function BrowserEditor({ session, canEdit, noteId }: BrowserEditorProps) {
  const presence = usePresence(session.awareness);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const loaded = loadSettings();
    applySettingsToDocument(loaded);
    return loaded;
  });

  function handleSettingsChange(next: AppSettings) {
    setSettings(next);
    saveSettings(next);
    applySettingsToDocument(next);
  }

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
          <BrowserSettingsPopover settings={settings} onChange={handleSettingsChange} />
        </div>
      </div>
      <MilkdownProvider>
        <BrowserEditorBody session={session} canEdit={canEdit} noteId={noteId} />
      </MilkdownProvider>
    </div>
  );
}
