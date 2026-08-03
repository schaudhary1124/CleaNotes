import { useCallback, useEffect, useRef, useState } from "react";
import { Editor as MilkdownEditor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import type { JoinedSession } from "../collab/yjsBridge";
import { usePresence } from "../collab/usePresence";
import { hashAssetBytes } from "../collab/assetStore";
import { applyStrokesToYArray, SKETCH_LOCAL_ORIGIN } from "../collab/sketchSync";
import { imageSchemaExt } from "../milkdown/imageSchemaExtensions";
import { NOTE_LOOK_CHANGED_EVENT } from "../milkdown/imageView";
import { applySettingsToDocument, loadSettings, saveSettings } from "../utils/settings";
import type { AppSettings, NoteLook, SketchStroke, SketchTool } from "../types";
import { registerMinimalMilkdownPlugins } from "./minimalMilkdownSetup";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserSettingsPopover } from "./BrowserSettingsPopover";
import { loadNoteLook, saveNoteLook } from "./noteLook";
import { fileToUploadableImage } from "./browserImageUpload";
import { idbAssetStore } from "./idbAssetStore";
import type { BrowserSelectionState } from "./browserSelectionState";
import { SketchLayer } from "../components/SketchLayer";
import { DEFAULT_SKETCH_COLOR, SKETCH_TOOL_SIZES, SketchToolbar } from "../components/SketchToolbar";

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
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Sketch mode: ink layer state - mirrors Editor.tsx's, minus that file's Tier-A
  // gesture-to-text-decoration classification (out of scope here) and disk persistence (a guest
  // has no vault entry for this note; the shared array below, via session.ySketchStrokes, is the
  // only copy that exists on this device - see hostSession.ts, which is what actually persists it
  // to the owner's `.sketch.json`). ---
  const [sketchMode, setSketchMode] = useState(false);
  const [strokes, setStrokes] = useState<SketchStroke[]>([]);
  const [sketchTool, setSketchTool] = useState<SketchTool>("pen");
  const [sketchColor, setSketchColor] = useState(DEFAULT_SKETCH_COLOR);
  const [sketchSizeIndex, setSketchSizeIndex] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undoStackRef = useRef<SketchStroke[][]>([]);
  const redoStackRef = useRef<SketchStroke[][]>([]);

  // Seeds `strokes` from the shared array (already populated by the time JoinedSession resolves -
  // see yjsBridge.ts) and mirrors every later remote change into it too - same pattern as
  // Editor.tsx's identical effect, see SKETCH_LOCAL_ORIGIN's own comment for why local edits
  // don't loop back through here.
  useEffect(() => {
    const yArr = session.ySketchStrokes;
    setStrokes(yArr.toArray());
    const observer = (_event: unknown, transaction: { origin: unknown }) => {
      if (transaction.origin === SKETCH_LOCAL_ORIGIN) return;
      setStrokes(yArr.toArray());
    };
    yArr.observe(observer);
    return () => yArr.unobserve(observer);
  }, [session.ySketchStrokes]);

  function commitStrokes(next: SketchStroke[]) {
    undoStackRef.current.push(strokes);
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
    setStrokes(next);
    applyStrokesToYArray(session.ySketchStrokes, next);
  }

  function handleAddStroke(stroke: SketchStroke) {
    commitStrokes([...strokes, stroke]);
  }

  function handleEraseStrokes(ids: string[]) {
    const idSet = new Set(ids);
    commitStrokes(strokes.filter((s) => !idSet.has(s.id)));
  }

  function handleClearSketch() {
    commitStrokes([]);
  }

  function handleUndo() {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(strokes);
    setStrokes(prev);
    applyStrokesToYArray(session.ySketchStrokes, prev);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }

  function handleRedo() {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(strokes);
    setStrokes(next);
    applyStrokesToYArray(session.ySketchStrokes, next);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }

  const sketchWidth = SKETCH_TOOL_SIZES[sketchTool][sketchSizeIndex];

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
        {
          yXmlFragment: session.yXmlFragment,
          canEdit,
          awareness: session.awareness,
          ySketchStrokes: session.ySketchStrokes,
          resolveAsset: session.resolveAsset,
        },
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

  // Tells every image NodeView to recompute its ruled-paper alignment compensation whenever
  // `look` changes - mirrors Editor.tsx's identical effect (see NOTE_LOOK_CHANGED_EVENT's own
  // comment in imageView.ts). `look` itself loads synchronously here (loadNoteLook reads
  // localStorage, not an async disk read - see noteLook.ts), so this doesn't close that exact
  // race Editor.tsx has; it's here so switching "Paper"/"Index card" mid-session (handleSelectLook
  // below) still recomputes already-mounted images, the same as it does on desktop.
  useEffect(() => {
    run((ctx) => {
      ctx.get(editorViewCtx).dom.dispatchEvent(new CustomEvent(NOTE_LOOK_CHANGED_EVENT));
    });
  }, [look, run]);

  // Freezes text editing while sketch mode is active - same reasoning as Editor.tsx's identical
  // effect (the ink canvas already owns pointer input; leaving text editing live underneath it
  // would fight the canvas for clicks/selection).
  useEffect(() => {
    run((ctx) => {
      ctx.get(editorViewCtx).setProps({ editable: () => !sketchMode });
    });
    if (sketchMode) window.getSelection()?.removeAllRanges();
  }, [sketchMode, run]);

  function handleSelectLook(next: NoteLook) {
    setLook(next);
    saveNoteLook(noteId, next);
  }

  async function insertImageFile(file: File) {
    try {
      const { bytes, mime } = await fileToUploadableImage(file);
      const hash = await hashAssetBytes(bytes);
      await idbAssetStore.put(hash, bytes);
      run((ctx) => {
        const view = ctx.get(editorViewCtx);
        const node = imageSchemaExt.type(ctx).create({ src: hash, alt: file.name, mime });
        view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Couldn't attach that image");
      setTimeout(() => setUploadError(null), 4000);
    }
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void insertImageFile(file);
  }

  // Same capture-phase + stopPropagation reasoning as Editor.tsx's handleEditorPaste: without
  // this, a pasted image falls through to the browser's native contenteditable paste, which has
  // no sensible image representation to insert here and (per the "image.png" text this was
  // filed against) sometimes drops in the clipboard's plain-text filename fallback instead.
  function handleEditorPaste(e: React.ClipboardEvent) {
    const file = Array.from(e.clipboardData.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    void insertImageFile(file);
  }

  return (
    <>
      {canEdit && sketchMode && (
        <SketchToolbar
          tool={sketchTool}
          onToolChange={setSketchTool}
          color={sketchColor}
          onColorChange={setSketchColor}
          sizeIndex={sketchSizeIndex}
          onSizeIndexChange={setSketchSizeIndex}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClear={handleClearSketch}
          onExit={() => setSketchMode(false)}
        />
      )}
      {canEdit && !sketchMode && (
        <BrowserToolbar
          selectionState={selectionState}
          run={run}
          look={look}
          onSelectLook={handleSelectLook}
          codeBlockEnabled={session.features.codeBlock}
          onInsertImage={() => fileInputRef.current?.click()}
          uploadError={uploadError}
          onToggleSketchMode={() => setSketchMode(true)}
        />
      )}
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
      <div
        className={`prose-note flex-1 overflow-y-auto px-12 py-8 @max-lg:px-6 @max-lg:py-5 @max-sm:px-3 @max-sm:py-3 ${sketchMode ? "select-none" : ""} ${look !== "plain" ? `note-look-${look}` : ""}`}
      >
        {/* Must be `.prose-note`'s direct child and `position: relative` - the note-look-paper/
            index-card rule-line background (index.css) is a ::before on exactly this element,
            positioned absolutely against it. Without a positioned ancestor here, that ::before
            falls back to the page's root containing block instead - painting behind the title
            bar/toolbar too, and phased against the wrong top edge so it no longer lines up with
            the actual text baseline. Mirrors Editor.tsx's sketchWrapperRef div. */}
        <div className="relative min-h-full" onPasteCapture={handleEditorPaste}>
          <Milkdown />
          <SketchLayer
            active={canEdit && sketchMode}
            strokes={strokes}
            tool={sketchTool}
            color={sketchColor}
            width={sketchWidth}
            onAddStroke={handleAddStroke}
            onEraseStrokes={handleEraseStrokes}
          />
        </div>
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
    <div className="flex h-full w-full flex-col">
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
