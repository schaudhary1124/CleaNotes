import type { MutableRefObject } from "react";
import { Editor } from "../components/Editor";
import type { HostedSession } from "../collab/hostSession";
import type { NoteLinkTarget } from "../milkdown/noteLinkHref";
import { broadcastNoteSaved } from "../utils/noteSync";
import { updateNoteInBacklinksIndex } from "../utils/backlinksIndex";
import { updateNoteInIndex } from "../utils/searchIndex";
import { writeNote } from "../utils/fsNotes";
import type { AppSettings, NoteSummary } from "../types";

/** Prop bag shared by every registered edit-view component (see registry.tsx) - App.tsx builds
 * one of these per render and hands it to whichever component NOTE_KIND_EDIT_VIEWS[kind] maps
 * to, so adding a new kind never requires touching App.tsx's render branch itself again. */
export interface NoteKindViewProps {
  note: NoteSummary;
  reloadToken: number;
  settings: AppSettings;
  activeContent: string;
  activeContentRef: MutableRefObject<string>;
  savedContentRef: MutableRefObject<string>;
  activeCollabSession: HostedSession | null;
  toolbarVisible: boolean;
  sketchMode: boolean;
  onToggleSketchMode: () => void;
  allNotes: NoteSummary[];
  onNavigateToNoteLink: (target: NoteLinkTarget) => Promise<void>;
  pendingScrollAnchor: { path: string; anchorId: string } | null;
  onScrolledToAnchor: () => void;
}

/** Renders Default and Fixed-Size notes - the same Milkdown-backed <Editor>, since Fixed-Size is
 * a runtime pagination mode on top of Default rather than a forked component (see Editor.tsx's
 * `pagination` prop). Extracted verbatim from App.tsx's old inline render branch so the kind
 * registry (registry.tsx) has a real component to point "default"/"fixed-size" at. */
export function DefaultKindView({
  note,
  reloadToken,
  settings,
  activeContent,
  activeContentRef,
  savedContentRef,
  activeCollabSession,
  toolbarVisible,
  sketchMode,
  onToggleSketchMode,
  allNotes,
  onNavigateToNoteLink,
  pendingScrollAnchor,
  onScrolledToAnchor,
}: NoteKindViewProps) {
  return (
    <Editor
      key={`${note.path}:${reloadToken}:${settings.features.voiceNotes}:${activeCollabSession ? "collab" : "solo"}`}
      notePath={note.path}
      initialContent={activeContent}
      onChange={(value) => {
        // Not setActiveContent: that's a useState setter, and calling it on every keystroke
        // re-renders all of App (including Sidebar/Header) for no rendering purpose -
        // activeContent's only JSX use is initialContent above, which just seeds a freshly-keyed
        // Editor mount. Every "read the live value" consumer already goes through
        // activeContentRef, so updating it directly here keeps them correct without the
        // unnecessary re-render.
        activeContentRef.current = value;
      }}
      onSave={async (content) => {
        await writeNote(note.path, content);
        savedContentRef.current = content;
        updateNoteInIndex(note.path, content);
        updateNoteInBacklinksIndex(note.path, content);
        await broadcastNoteSaved(note.path, content);
      }}
      toolbarVisible={toolbarVisible}
      sketchMode={sketchMode}
      onToggleSketchMode={onToggleSketchMode}
      sketchEnabled={settings.features.sketch}
      codeBlockEnabled={settings.features.codeBlock}
      voiceNotesEnabled={settings.features.voiceNotes}
      voiceNoteCountdown={settings.voiceNoteCountdown}
      paginated={note.kind === "fixed-size"}
      noteChoices={allNotes}
      onNavigateToNoteLink={onNavigateToNoteLink}
      scrollToAnchorId={pendingScrollAnchor?.path === note.path ? pendingScrollAnchor.anchorId : undefined}
      onScrolledToAnchor={onScrolledToAnchor}
      collabSession={
        // Narrowed rather than asserted: KindSharedTypes is a union across every collaborative
        // kind (see collab/kindSharedTypes.ts), and a Whiteboard session carries no yXmlFragment
        // at all. Only this component's own kinds can produce the text half, so anything else
        // means the note's kind changed underneath a running session - in which case falling back
        // to a non-collaborative editor is strictly better than crashing the note open.
        activeCollabSession && activeCollabSession.shared.kind !== "whiteboard"
          ? {
              yXmlFragment: activeCollabSession.shared.yXmlFragment,
              canEdit: true,
              awareness: activeCollabSession.awareness,
              ySketchStrokes: activeCollabSession.shared.ySketchStrokes,
              resolveAsset: activeCollabSession.resolveAsset,
            }
          : undefined
      }
    />
  );
}
