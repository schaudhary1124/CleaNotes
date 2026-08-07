import { useCallback, useEffect, useRef, useState } from "react";
import { Editor as MilkdownEditor, defaultValueCtx, editorViewCtx, rootCtx, schemaCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import type { JoinedSession } from "../collab/yjsBridge";
import { usePresence } from "../collab/usePresence";
import { hashAssetBytes } from "../collab/assetStore";
import { applyStrokesToYArray, SKETCH_LOCAL_ORIGIN } from "../collab/sketchSync";
import { imageSchemaExt } from "../milkdown/imageSchemaExtensions";
import { NOTE_LOOK_CHANGED_EVENT } from "../milkdown/imageView";
import { applySettingsToDocument, loadSettings, saveSettings } from "../utils/settings";
import { clampedMarginMm, mmToPx, pageDimensionsMm, verticalMarginPx } from "../utils/pageSizes";
import type { PaginationMetrics } from "../milkdown/paginationLayout";
import type { AppSettings, NoteLook, PageSetup, SketchStroke, SketchTool } from "../types";
import { registerMinimalMilkdownPlugins } from "./minimalMilkdownSetup";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserSettingsPopover } from "./BrowserSettingsPopover";
import { loadNoteLook, saveNoteLook } from "./noteLook";
import { loadPageSetup, savePageSetup } from "./pageSetup";
import { fileToUploadableImage } from "./browserImageUpload";
import { idbAssetStore } from "./idbAssetStore";
import type { BrowserSelectionState } from "./browserSelectionState";
import { SketchLayer } from "../components/SketchLayer";
import { PageBackdrop, type PageRect } from "../components/PageBackdrop";
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

  // --- Fixed-Size page setup: same guest-local-only reasoning as `look` above (see
  // pageSetup.ts's own comment) - a per-viewer print/display preference, not synced content. ---
  const paginated = session.kind === "fixed-size";
  const [pageSetup, setPageSetupState] = useState<PageSetup>(() => loadPageSetup(noteId));
  const sketchWrapperRef = useRef<HTMLDivElement>(null);
  // Fixed-Size notes only: see Editor.tsx's identical ref for the full reasoning.
  const zoomStageRef = useRef<HTMLDivElement>(null);

  function handleChangePageSetup(next: PageSetup) {
    setPageSetupState(next);
    savePageSetup(noteId, next);
  }

  const pageWidthPx = mmToPx(pageDimensionsMm(pageSetup).widthMm);
  const pageHeightPx = mmToPx(pageDimensionsMm(pageSetup).heightMm);
  const pageMarginPx = mmToPx(clampedMarginMm(pageSetup));
  // Top/bottom only - left/right stay on pageMarginPx. See utils/pageSizes.ts's own comment.
  const pageVerticalMarginPx = verticalMarginPx(pageSetup, look);

  // See Editor.tsx's identical zoom state for the full reasoning (`transform: scale`, not CSS
  // `zoom` - the latter reruns text shaping at each zoom level, and isn't reliably reflow-
  // invariant across zoom for a given engine).
  const [zoom, setZoom] = useState(1);
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10));
  const handleZoomIn = () => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10));

  // Real computed page rectangles from milkdown/paginationLayout.ts's live measurement engine -
  // see Editor.tsx's identical state for the full reasoning (starts as a single page-1-sized
  // rectangle so even an empty/short note immediately looks like "one page on a canvas").
  // See Editor.tsx's identical pageRects state for why these are unscaled/logical px (no
  // `* zoom`) - the ancestor's `transform: scale` scales them visually exactly once.
  const [pageRects, setPageRects] = useState<PageRect[]>([{ top: 0, height: pageHeightPx }]);
  // See Editor.tsx's identical pageContentHeightPx for the full reasoning.
  const pageContentHeightPx = pageRects.length ? pageRects[pageRects.length - 1].top + pageRects[pageRects.length - 1].height : pageHeightPx;
  useEffect(() => {
    setPageRects((prev) => (prev.length <= 1 ? [{ top: 0, height: pageHeightPx }] : prev));
  }, [pageHeightPx]);

  // Placeholder until the pageSetup-tracking effect below populates real values - see
  // Editor.tsx's identical ref for the full "ref bridge" reasoning.
  const paginationMetricsRef = useRef<PaginationMetrics>({ usablePageHeightPx: 0, marginTopPx: 0, marginBottomPx: 0, layoutKey: "" });

  // Same disposable-<style>-tag technique as Editor.tsx's handlePrint - see its own comment for
  // why a static `@page { size: var(...) }` rule isn't reliable across browsers, and for why
  // cleanup no longer touches zoom/page-break-position styles at all (index.css's `@media print`
  // handles those declaratively now - a "focus" fallback alongside "afterprint" here is only for
  // the disposable `@page` style tag, a cosmetic head-tag hygiene concern, not anything visible).
  function handlePrint() {
    const { widthMm, heightMm } = pageDimensionsMm(pageSetup);
    const styleEl = document.createElement("style");
    styleEl.textContent = `@page { size: ${widthMm}mm ${heightMm}mm; margin: ${clampedMarginMm(pageSetup)}mm; }`;
    document.head.appendChild(styleEl);

    const cleanup = () => {
      styleEl.remove();
      window.removeEventListener("afterprint", cleanup);
      window.removeEventListener("focus", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.addEventListener("focus", cleanup);
    window.print();
  }

  // --- Sketch mode: ink layer state - mirrors Editor.tsx's, minus that file's Tier-A
  // gesture-to-text-decoration classification (out of scope here) and disk persistence (a guest
  // has no vault entry for this note; the shared array below, via session.shared.ySketchStrokes, is the
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
    const yArr = session.shared.ySketchStrokes;
    setStrokes(yArr.toArray());
    const observer = (_event: unknown, transaction: { origin: unknown }) => {
      if (transaction.origin === SKETCH_LOCAL_ORIGIN) return;
      setStrokes(yArr.toArray());
    };
    yArr.observe(observer);
    return () => yArr.unobserve(observer);
  }, [session.shared.ySketchStrokes]);

  function commitStrokes(next: SketchStroke[]) {
    undoStackRef.current.push(strokes);
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
    setStrokes(next);
    applyStrokesToYArray(session.shared.ySketchStrokes, next);
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
    applyStrokesToYArray(session.shared.ySketchStrokes, prev);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }

  function handleRedo() {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(strokes);
    setStrokes(next);
    applyStrokesToYArray(session.shared.ySketchStrokes, next);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }

  const sketchWidth = SKETCH_TOOL_SIZES[sketchTool][sketchSizeIndex];

  const { get } = useEditor(
    (root) => {
      const editor = MilkdownEditor.make();
      editor.config((ctx) => {
        ctx.set(rootCtx, root);
        // Empty on purpose: session.shared.yXmlFragment is already hydrated with the note's real
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
          yXmlFragment: session.shared.yXmlFragment,
          canEdit,
          awareness: session.awareness,
          ySketchStrokes: session.shared.ySketchStrokes,
          resolveAsset: session.resolveAsset,
        },
        setSelectionState,
        session.features.codeBlock,
        paginated ? { metricsRef: paginationMetricsRef, onLayoutChanged: setPageRects } : undefined,
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

  // Keeps paginationLayout.ts's live metrics ref up to date as PageSetup or `look` changes, and
  // forces a recompute - see Editor.tsx's identical effect for the full reasoning, including why
  // `zoom` is deliberately not a dependency here anymore and why `look` (as `layoutKey`) is.
  useEffect(() => {
    if (!paginated) return;
    paginationMetricsRef.current = {
      usablePageHeightPx: pageHeightPx - 2 * pageVerticalMarginPx,
      marginTopPx: pageVerticalMarginPx,
      marginBottomPx: pageVerticalMarginPx,
      layoutKey: look,
    };
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginated, pageHeightPx, pageVerticalMarginPx, look]);

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
    if (file) {
      e.preventDefault();
      e.stopPropagation();
      void insertImageFile(file);
      return;
    }

    // Plain multi-line text with no text/html (a lorem-ipsum generator, a PDF, a terminal, "paste
    // and match style") arrives at Milkdown's own paste handling (@milkdown/plugin-clipboard) as a
    // raw markdown *source* string, which it runs through the CommonMark parser - and CommonMark
    // joins any run of consecutive non-blank lines with no blank line between them into a single
    // paragraph node. paginationLayout.ts can only inject a page-break margin *before* a top-level
    // block, never inside one (top-level blocks are atomic there by design - see its own comment),
    // so that single oversized paragraph just overflows straight through the page boundary instead
    // of breaking the way the same text typed line-by-line (Enter makes a new paragraph each time)
    // would. Rebuilding one plain paragraph per source line here, before Milkdown's handler ever
    // sees the event, makes a paste land in the same per-line shape typing it would have produced,
    // so the existing per-block pagination logic breaks it across pages correctly. Same fix as
    // Editor.tsx's handleEditorPaste - see its comment for the full reasoning.
    const text = e.clipboardData.getData("text/plain");
    const html = e.clipboardData.getData("text/html");
    if (!html && text.includes("\n")) {
      e.preventDefault();
      e.stopPropagation();
      run((ctx) => {
        const view = ctx.get(editorViewCtx);
        const schema = ctx.get(schemaCtx);
        const paragraphType = schema.nodes.paragraph;
        const lines = text.split(/\r\n|\r|\n/);
        const nodes = lines.map((line) => (line.length > 0 ? paragraphType.create(null, schema.text(line)) : paragraphType.create()));
        const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
      });
    }
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
          paginated={paginated}
          pageSetup={pageSetup}
          onChangePageSetup={handleChangePageSetup}
          onPrint={handlePrint}
          zoom={zoom}
          onZoomOut={handleZoomOut}
          onZoomIn={handleZoomIn}
        />
      )}
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
      <div
        data-paginated={paginated || undefined}
        className={
          paginated
            ? `prose-note flex-1 overflow-auto px-8 py-10 ${sketchMode ? "select-none" : ""} ${look !== "plain" ? `note-look-${look}` : ""}`
            : `prose-note flex-1 overflow-y-auto px-12 py-8 @max-lg:px-6 @max-lg:py-5 @max-sm:px-3 @max-sm:py-3 ${sketchMode ? "select-none" : ""} ${look !== "plain" ? `note-look-${look}` : ""}`
        }
      >
        {/* `.note-content-surface` must be a positioned element (`relative` or `absolute`) - the
            note-look-paper/index-card rule-line background (index.css) is a ::before on exactly
            that class, positioned absolutely against it. Without a positioned ancestor here, that
            ::before falls back to the page's root containing block instead - painting behind the
            title bar/toolbar too, and phased against the wrong top edge so it no longer lines up
            with the actual text baseline. Mirrors Editor.tsx's sketchWrapperRef div. */}
        {paginated ? (
          <div ref={zoomStageRef} className="zoom-stage relative mx-auto" style={{ width: pageWidthPx * zoom, height: pageContentHeightPx * zoom }}>
            <div
              ref={sketchWrapperRef}
              className="note-content-surface absolute left-0 top-0"
              style={{
                width: pageWidthPx,
                minHeight: pageHeightPx,
                paddingLeft: pageMarginPx,
                paddingRight: pageMarginPx,
                paddingTop: pageVerticalMarginPx,
                paddingBottom: pageVerticalMarginPx,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
              }}
              onPasteCapture={handleEditorPaste}
            >
              <PageBackdrop
                pages={pageRects}
                width={pageWidthPx}
                marginPx={pageMarginPx}
                verticalMarginPx={pageVerticalMarginPx}
                look={look}
              />
              <Milkdown />
              <SketchLayer
                className="absolute inset-0"
                active={canEdit && sketchMode}
                strokes={strokes}
                tool={sketchTool}
                color={sketchColor}
                width={sketchWidth}
                onAddStroke={handleAddStroke}
                onEraseStrokes={handleEraseStrokes}
                zoom={zoom}
              />
            </div>
          </div>
        ) : (
          <div ref={sketchWrapperRef} className="note-content-surface relative min-h-full" onPasteCapture={handleEditorPaste}>
            <Milkdown />
            <SketchLayer
              className="absolute inset-0"
              active={canEdit && sketchMode}
              strokes={strokes}
              tool={sketchTool}
              color={sketchColor}
              width={sketchWidth}
              onAddStroke={handleAddStroke}
              onEraseStrokes={handleEraseStrokes}
            />
          </div>
        )}
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
