import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Brush,
  Code,
  Crop,
  Highlighter,
  ImagePlus,
  Italic,
  Layers,
  List,
  ListChecks,
  ListOrdered,
  Minus as DividerIcon,
  Pilcrow,
  RemoveFormatting,
  SeparatorHorizontal,
  Strikethrough,
  Underline,
  WrapText,
} from "lucide-react";
import { Editor as MilkdownEditor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { callCommand } from "@milkdown/kit/utils";
import { TextSelection } from "@milkdown/kit/prose/state";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import {
  createCodeBlockCommand,
  insertHrCommand,
  linkSchema,
  toggleEmphasisCommand,
  toggleStrongCommand,
  wrapInHeadingCommand,
} from "@milkdown/kit/preset/commonmark";
import { redoCommand, undoCommand } from "@milkdown/kit/plugin/history";
import { redoCommand as yRedoCommand, undoCommand as yUndoCommand } from "y-prosemirror";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { fsAssetStore, getNoteLook, readSketch, setNoteLook, writeSketch } from "../utils/fsNotes";
import { hashAssetBytes } from "../collab/assetStore";
import { imageSchemaExt, type ImageWrap } from "../milkdown/imageSchemaExtensions";
import type { CollabPluginConfig, EditorSelectionRange, EditorSelectionState } from "../milkdown/setup";
import { getSelectionState, registerMilkdownPlugins } from "../milkdown/setup";
import { setBlockAlign, setTableColumnAlign } from "../milkdown/alignmentCommands";
import { setSelectedImageWrap, toggleSelectedImageCrop } from "../milkdown/imageCommands";
import { IMAGE_CROP_CHANGED_EVENT, NOTE_LOOK_CHANGED_EVENT } from "../milkdown/imageView";
import { liftOutOfList, toggleBulletList, toggleOrderedList, toggleTaskItem } from "../milkdown/listCommands";
import {
  addTableColumn,
  addTableRow,
  deleteCurrentTable,
  deleteTableColumn,
  deleteTableRow,
  insertTable,
  setTableCellBackground,
} from "../milkdown/tableCommands";
import {
  DEFAULT_DECORATION_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  highlightSchema,
  strikethroughSchema,
  toggleTextDecoration,
  underlineSchema,
} from "../milkdown/textDecorationMarks";
import {
  applyMarkToRange,
  classifyGesture,
  expandToWordBoundaries,
  resolveGestureRange,
} from "../milkdown/sketchDecorations";
import { clearFormatting } from "../milkdown/formatCommands";
import { buildNoteLinkHref, describeNoteLinkTarget, parseNoteLinkHref, type NoteLinkTarget } from "../milkdown/noteLinkHref";
import { confirmNoteLinkTrigger, type NoteLinkTriggerChoice, type NoteLinkTriggerInfo } from "../milkdown/noteLinkTrigger";
import { notePinSchema } from "../milkdown/notePin";
import { NOTE_PIN_CLICKED_EVENT, type NotePinClickedDetail } from "../milkdown/notePinView";
import { VOICE_NOTE_CLICKED_EVENT, type VoiceNoteClickedDetail } from "../milkdown/voiceNoteGrips";
import { VoiceNotePopover } from "./VoiceNotePopover";
import { noteLinkChipSchema } from "../milkdown/noteLinkChip";
import { LINK_CLICKED_EVENT, openLinkHref, type LinkClickedDetail } from "../milkdown/noteLinkClick";
import { SketchLayer } from "./SketchLayer";
import { DEFAULT_SKETCH_COLOR, SKETCH_TOOL_SIZES, SketchToolbar } from "./SketchToolbar";
import { filterNoteChoices, NoteLinkResultsList, type NoteLinkChoice } from "./NoteLinkPicker";
import { ToolbarPopover } from "./ToolbarPopover";
import { LinkPopover, NotePinPopover, SelectionLinkToolbar } from "./SelectionLinkToolbar";
import { ToolbarButtonGroup, type ToolbarAction } from "./ToolbarButtonGroup";
import { ALIGN_OPTIONS, TableMenu } from "./TableMenu";
import { LookDropdown } from "./LookDropdown";
import { TextStyleDropdown } from "./TextStyleDropdown";
import type { NoteLook, SketchStroke, SketchTool } from "../types";
import { applyStrokesToYArray, SKETCH_LOCAL_ORIGIN } from "../collab/sketchSync";

type SaveStatus = "idle" | "pending" | "saving" | "saved";

interface EditorProps {
  notePath: string;
  initialContent: string;
  onChange: (content: string) => void;
  onSave: (content: string) => Promise<void>;
  toolbarVisible: boolean;
  sketchMode: boolean;
  onToggleSketchMode: () => void;
  /** Whether the Sketch feature is enabled - hides the toolbar's sketch toggle when off. */
  sketchEnabled: boolean;
  /** Whether the Code Block feature is enabled - hides the toolbar's insert button when off.
   * Existing code blocks in the note still render/edit regardless. */
  codeBlockEnabled: boolean;
  /** Whether the Voice Notes feature is enabled - forwarded to registerMilkdownPlugins, which
   * needs it at construction time (see App.tsx's Editor `key`, which remounts on change). */
  voiceNotesEnabled: boolean;
  /** Every note in the vault, for the "link to a note" picker - not just the current one. */
  noteChoices: NoteLinkChoice[];
  /** Cmd/Ctrl-clicking an internal note:// link calls this with its target. */
  onNavigateToNoteLink: (target: NoteLinkTarget) => void;
  /** Set once, right after navigating here via an anchored (heading or notePin) link, so this
   * mount can scroll to and briefly highlight that target - see the mount effect below. */
  scrollToAnchorId?: string;
  /** Called once this mount has acted on `scrollToAnchorId` (found or not), so the caller can
   * clear its pending state instead of re-triggering on the next unrelated re-render. */
  onScrolledToAnchor?: () => void;
  /** When present, binds this editor to a live collaboration session - see
   * src/collab/yjsBridge.ts and setup.ts's CollabPluginConfig. Fixed at construction like
   * voiceNotesEnabled above (see App.tsx's Editor `key`, which remounts when a session
   * starts/ends since it changes which undo plugin and editable state get registered). */
  collabSession?: CollabPluginConfig;
}

const AUTOSAVE_DELAY_MS = 1000;

/** Remembers each note's scroll position (in its `.milkdown-scroll` container) across tab
 * switches, keyed by notePath - module-level, not component state, because the whole Editor is
 * unmounted and a fresh one remounted every time the active tab changes (see App.tsx's Editor
 * `key`), which would otherwise reset every note back to the top on every visit. */
const scrollPositions = new Map<string, number>();

const WRAP_OPTIONS: {
  wrap: ImageWrap;
  label: string;
  hint: string;
  icon: React.ComponentType<{ size?: number }>;
}[] = [
  { wrap: "inline", label: "In line", hint: "Moves with the text like a character", icon: Pilcrow },
  { wrap: "wrap", label: "Wrap text", hint: "Text flows around the image", icon: WrapText },
  { wrap: "break", label: "Break text", hint: "Text stops above, resumes below", icon: SeparatorHorizontal },
  { wrap: "above", label: "Above text", hint: "Floats over the text - drag it anywhere", icon: Layers },
];

/** Doubles as both the "Insert image" button and, once an image is selected,
 * a wrap-mode picker - mirrors TableMenu's dual-mode popover (insert grid vs.
 * row/column editing) depending on `inTable`. `wrap` is null exactly when
 * the current selection isn't an image (see getSelectedImageWrap), which is
 * also what decides whether clicking opens the picker or just opens the file
 * dialog straight away. */
function ImageMenu({
  wrap,
  onInsert,
  onSetWrap,
}: {
  wrap: ImageWrap | null;
  onInsert: () => void;
  onSetWrap: (wrap: ImageWrap) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const imageSelected = wrap !== null;

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => (imageSelected ? setOpen((v) => !v) : onInsert())}
        title={imageSelected ? "Image text wrapping" : "Insert image"}
        aria-label={imageSelected ? "Image text wrapping" : "Insert image"}
        aria-expanded={imageSelected ? open : undefined}
        aria-pressed={imageSelected}
        className={`btn-ghost h-7 w-7 shrink-0 ${imageSelected ? "bg-accent-soft text-accent" : ""}`}
      >
        <ImagePlus size={14} />
      </button>
      {open && imageSelected && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle w-56 overflow-hidden rounded-lg border py-1 text-sm"
        >
          {WRAP_OPTIONS.map((opt) => (
            <button
              key={opt.wrap}
              type="button"
              className={`hover:bg-surface-hover flex w-full flex-col items-start px-3 py-1.5 text-left ${
                wrap === opt.wrap ? "text-accent bg-accent-soft" : "text-primary"
              }`}
              onClick={() => {
                onSetWrap(opt.wrap);
                setOpen(false);
              }}
            >
              <span>{opt.label}</span>
              <span className="text-tertiary text-xs">{opt.hint}</span>
            </button>
          ))}
        </ToolbarPopover>
      )}
    </div>
  );
}

/** Small contextual toolbar anchored directly beneath the selected image,
 * so wrap mode / crop can be changed without reaching for the top toolbar's
 * Insert Image button (ImageMenu above). Mirrors its options but as a
 * compact icon row, and shows/hides itself purely off `imageWrap` - no open
 * state of its own, since image selection is already the trigger.
 *
 * The selected image's NodeView (imageView.ts) is the only thing that knows
 * its own DOM node - it's found here by querying for the `.selected` class
 * it toggles in `selectNode`/`deselectNode`, the same coupling ImageMenu's
 * "wrap" prop already relies on indirectly via getSelectedImageWrap. */
function SelectedImageToolbar({
  imageWrap,
  cropping,
  containerRef,
  onSetWrap,
  onToggleCrop,
}: {
  imageWrap: ImageWrap | null;
  cropping: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  onSetWrap: (wrap: ImageWrap) => void;
  onToggleCrop: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", visibility: "hidden" });

  // Repositions every frame rather than off a fixed set of triggers: the
  // anchor can move for reasons this component has no direct signal for
  // (resize/crop drags mutate the NodeView's DOM straight outside React,
  // switching wrap mode reflows surrounding text, scrolling moves it in the
  // viewport). A rAF loop only runs while an image is actually selected, so
  // the cost is one small layout read per frame in an otherwise rare state.
  useEffect(() => {
    if (imageWrap === null) return;
    let frame: number;
    function place() {
      const anchor = containerRef.current?.querySelector<HTMLElement>(".milkdown-image-view.selected");
      if (!anchor) {
        setStyle((prev) => (prev.visibility === "hidden" ? prev : { position: "fixed", visibility: "hidden" }));
      } else {
        const rect = anchor.getBoundingClientRect();
        const width = popoverRef.current?.offsetWidth ?? 0;
        const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8);
        setStyle({ position: "fixed", top: rect.bottom + 8, left, zIndex: 50 });
      }
      frame = requestAnimationFrame(place);
    }
    place();
    return () => cancelAnimationFrame(frame);
  }, [imageWrap, containerRef]);

  if (imageWrap === null) return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="glass-panel shadow-app-lg border-subtle flex items-center gap-0.5 rounded-lg border p-1"
    >
      {WRAP_OPTIONS.map((opt) => (
        <button
          key={opt.wrap}
          type="button"
          title={`${opt.label} – ${opt.hint}`}
          aria-label={opt.label}
          aria-pressed={imageWrap === opt.wrap}
          onClick={() => onSetWrap(opt.wrap)}
          className={`btn-ghost h-7 w-7 shrink-0 ${imageWrap === opt.wrap ? "bg-accent-soft text-accent" : ""}`}
        >
          <opt.icon size={14} />
        </button>
      ))}
      <div className="divider mx-0.5 h-5 w-px shrink-0" />
      <button
        type="button"
        title="Crop image"
        aria-label="Crop image"
        aria-pressed={cropping}
        onClick={onToggleCrop}
        className={`btn-ghost h-7 w-7 shrink-0 ${cropping ? "bg-accent-soft text-accent" : ""}`}
      >
        <Crop size={14} />
      </button>
    </div>,
    document.body,
  );
}

function NoteEditor({
  notePath,
  initialContent,
  onChange,
  onSave,
  toolbarVisible,
  sketchMode,
  onToggleSketchMode,
  sketchEnabled,
  codeBlockEnabled,
  voiceNotesEnabled,
  noteChoices,
  onNavigateToNoteLink,
  scrollToAnchorId,
  onScrolledToAnchor,
  collabSession,
}: EditorProps) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The current selection, only while it's a genuine highlighted text range - drives
  // SelectionLinkToolbar. See setup.ts's reportSelectionRange for exactly what qualifies.
  const [selectionRange, setSelectionRange] = useState<EditorSelectionRange | null>(null);
  // Set by notePinView.ts's click handler (see the NOTE_PIN_CLICKED_EVENT listener below) -
  // which pin's popover (if any) is open.
  const [pinPopover, setPinPopover] = useState<NotePinClickedDetail | null>(null);
  // Set by voiceNoteGrips.ts's click handler on an occupied line's pill - which voice note's
  // popover (if any) is open. Same NodeView/PluginView -> React bridge shape as pinPopover.
  const [voiceNotePopover, setVoiceNotePopover] = useState<VoiceNoteClickedDetail | null>(null);
  // Set by noteLinkClick.ts's/noteLinkChipView.ts's plain-click handling (see the
  // LINK_CLICKED_EVENT listener below) - which link's LinkPopover (if any) is open.
  const [linkPopover, setLinkPopover] = useState<LinkClickedDetail | null>(null);
  // The `[[` trigger: null while inactive, or the ProseMirror plugin's reported query/coords/
  // highlighted row while the user is mid-trigger - see noteLinkTrigger.ts.
  const [noteLinkTrigger, setNoteLinkTrigger] = useState<NoteLinkTriggerInfo | null>(null);
  // Kept in sync with the trigger's filtered results (see the effect below) so the plugin's own
  // keyboard handling can read the current list synchronously, without a second callback.
  const noteLinkResultsRef = useRef<NoteLinkTriggerChoice[]>([]);
  const [selectionState, setSelectionState] = useState<EditorSelectionState>({
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
    imageWrap: null,
  });
  const latestContentRef = useRef(initialContent);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The note's own `.milkdown-scroll` pane - see the scroll-restore effect below and
  // scrollPositions' own comment for why this needs to be tracked/restored manually.
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Crop-mode-active lives in the selected image's NodeView, not in node
  // attrs (see imageView.ts) - mirrored here purely so the toolbar's Crop
  // button can show a pressed state, via the bubbling custom event the
  // NodeView fires whenever it enters/exits crop mode.
  const [imageCropping, setImageCropping] = useState(false);
  useEffect(() => {
    const onCropChanged = (event: Event) => {
      setImageCropping((event as CustomEvent<{ cropping: boolean }>).detail?.cropping ?? false);
    };
    document.addEventListener(IMAGE_CROP_CHANGED_EVENT, onCropChanged);
    return () => document.removeEventListener(IMAGE_CROP_CHANGED_EVENT, onCropChanged);
  }, []);
  useEffect(() => {
    if (selectionState.imageWrap === null) setImageCropping(false);
  }, [selectionState.imageWrap]);

  // Bubbles up from notePinView.ts's click handler on the pin glyph itself - see its own comment
  // for why this is a DOM CustomEvent rather than something threaded through Milkdown's ctx.
  useEffect(() => {
    const onPinClicked = (event: Event) => {
      setPinPopover((event as CustomEvent<NotePinClickedDetail>).detail);
    };
    document.addEventListener(NOTE_PIN_CLICKED_EVENT, onPinClicked);
    return () => document.removeEventListener(NOTE_PIN_CLICKED_EVENT, onPinClicked);
  }, []);

  // Bubbles up from voiceNoteGrips.ts's click handler on an occupied line's pill - same shape as
  // onPinClicked above.
  useEffect(() => {
    const onVoiceNoteClicked = (event: Event) => {
      setVoiceNotePopover((event as CustomEvent<VoiceNoteClickedDetail>).detail);
    };
    document.addEventListener(VOICE_NOTE_CLICKED_EVENT, onVoiceNoteClicked);
    return () => document.removeEventListener(VOICE_NOTE_CLICKED_EVENT, onVoiceNoteClicked);
  }, []);

  // Bubbles up from a plain click on either link shape - real link-marked text (noteLinkClick.ts)
  // or a pasted link-chip glyph (noteLinkChipView.ts) - both fire the same event so one popover
  // here covers both. See LinkPopover's own comment for why they share one component.
  useEffect(() => {
    const onLinkClicked = (event: Event) => {
      setLinkPopover((event as CustomEvent<LinkClickedDetail>).detail);
    };
    document.addEventListener(LINK_CLICKED_EVENT, onLinkClicked);
    return () => document.removeEventListener(LINK_CLICKED_EVENT, onLinkClicked);
  }, []);

  const debouncedSave = useDebouncedCallback(async (value: string) => {
    setStatus("saving");
    await onSave(value);
    if (latestContentRef.current === value) {
      setStatus("saved");
    }
  }, AUTOSAVE_DELAY_MS);

  function handleChange(value: string) {
    latestContentRef.current = value;
    onChange(value);
    setStatus("pending");
    debouncedSave(value);
  }

  const { get } = useEditor((root) => {
    const editor = MilkdownEditor.make();
    editor.config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, initialContent);
    });
    registerMilkdownPlugins(
      editor,
      notePath,
      handleChange,
      setSelectionState,
      onNavigateToNoteLink,
      setNoteLinkTrigger,
      noteLinkResultsRef,
      setSelectionRange,
      voiceNotesEnabled,
      collabSession,
    );
    return editor;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    (action: (ctx: Ctx) => unknown) => {
      get()?.action(action);
    },
    [get],
  );

  // Keeps the plugin's synchronous read of "current results" up to date as the trigger's query
  // changes - the plugin itself can't call React hooks, so this is the other half of the
  // ref bridge described in noteLinkTrigger.ts.
  useEffect(() => {
    noteLinkResultsRef.current = noteLinkTrigger ? filterNoteChoices(noteChoices, noteLinkTrigger.query) : [];
  }, [noteChoices, noteLinkTrigger]);

  function chooseNoteLinkTriggerResult(choice: NoteLinkTriggerChoice) {
    run((ctx) => confirmNoteLinkTrigger(ctx, choice));
  }

  // Runs once per mount: if we navigated here via an anchored link (a heading, or a notePin
  // planted via "Copy link to this point"), scroll to and briefly highlight that target.
  // Best-effort - if the id doesn't resolve (e.g. the heading/pin was renamed or removed since
  // the link was created), this silently does nothing rather than erroring; see
  // noteLinkHref.ts's module comment for that accepted tradeoff.
  useEffect(() => {
    if (!scrollToAnchorId) return;
    const scrollToTarget = () => {
      const target = document.getElementById(scrollToAnchorId);
      if (!target) return false;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("note-link-highlight-flash");
      setTimeout(() => target.classList.remove("note-link-highlight-flash"), 1600);
      return true;
    };
    // Milkdown's own view usually mounts before this effect runs, but one rAF retry covers the
    // rare case where the target's layout isn't settled yet on the first attempt.
    if (!scrollToTarget()) requestAnimationFrame(scrollToTarget);
    onScrolledToAnchor?.();
    // notePath is stable for the lifetime of this component (Editor is remounted per-note via a
    // `key` prop in App) - scrollToAnchorId/onScrolledToAnchor are only meant to be consumed
    // once, right at this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Runs once per mount: restores this note's scroll position from wherever the user last left
  // it (see scrollPositions), so switching tabs away and back - or going Home and back - doesn't
  // dump them back at the top. Skipped when scrollToAnchorId is set, since that effect above is
  // about to scroll (and smoothly animate) to a specific target instead - restoring a stale
  // position here first would just fight it.
  useEffect(() => {
    if (scrollToAnchorId) return;
    const saved = scrollPositions.get(notePath);
    if (saved === undefined) return;
    const restore = () => {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = saved;
    };
    restore();
    // Milkdown's own view usually mounts before this effect runs, but one rAF retry covers the
    // rare case where the content's layout isn't settled yet on the first attempt (same reasoning
    // as the scrollToAnchorId effect above).
    requestAnimationFrame(restore);
    // notePath is stable for the lifetime of this component (Editor is remounted per-note via a
    // `key` prop in App) - only meant to run once, right at this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Note look: visual skin, independent of content ------------------
  const [look, setLook] = useState<NoteLook>("plain");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const value = await getNoteLook(notePath);
      if (cancelled) return;
      setLook(value);
    })();
    return () => {
      cancelled = true;
    };
    // notePath is stable for the lifetime of this component (Editor is
    // remounted per-note via a `key` prop in App), so this only runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelectLook(next: NoteLook) {
    setLook(next);
    setNoteLook(notePath, next);
  }

  // Tells every image NodeView to recompute its ruled-paper alignment compensation whenever
  // `look` changes - most importantly the very first time it resolves from "plain" (this state's
  // initial value, before the effect above's async disk read lands) to the note's real saved
  // preference. See NOTE_LOOK_CHANGED_EVENT's own comment in imageView.ts for the race this
  // closes: an image's own "load" event (its normal trigger for this) can easily fire before
  // that async read finishes, correctly no-opping against the still-default "plain" look with
  // nothing left to retry it once the real class actually lands.
  useEffect(() => {
    run((ctx) => {
      ctx.get(editorViewCtx).dom.dispatchEvent(new CustomEvent(NOTE_LOOK_CHANGED_EVENT));
    });
  }, [look, run]);

  // --- Sketch mode: ink layer state -----------------------------------
  const [strokes, setStrokes] = useState<SketchStroke[]>([]);
  const [sketchTool, setSketchTool] = useState<SketchTool>("pen");
  const [sketchColor, setSketchColor] = useState(DEFAULT_SKETCH_COLOR);
  const [sketchSizeIndex, setSketchSizeIndex] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // A stroke either becomes freeform ink (undo/redo by snapshotting `strokes`)
  // or gets classified into a text decoration mark (undo/redo by delegating
  // to ProseMirror's own history, since that's what actually applied the
  // change - see handleAddStroke). The sketch toolbar's undo button needs to
  // reverse either kind of action in the order they happened, so both share
  // one stack tagged by which mechanism undoes them. Note this only tracks
  // actions taken while sketch mode is on - a text edit made in between two
  // sketch actions (only possible by leaving and re-entering sketch mode,
  // since editing is disabled while it's active) isn't in this stack, and
  // undoing a "mark" entry after one would undo that edit instead via
  // ProseMirror's history. Accepted as a narrow edge case.
  type SketchAction = { kind: "ink"; strokes: SketchStroke[] } | { kind: "mark" };
  const undoStackRef = useRef<SketchAction[]>([]);
  const redoStackRef = useRef<SketchAction[]>([]);
  // Guards against the async sketch load clobbering ink the user has
  // already drawn in the (rare) case they start drawing before it resolves.
  const hasUserEditedRef = useRef(false);

  useEffect(() => {
    // A collab session's ySketchStrokes (seeded from this same file - see hostSession.ts) is the
    // source of truth instead while one's active - see the effect below.
    if (collabSession?.ySketchStrokes) return;
    let cancelled = false;
    (async () => {
      const data = await readSketch(notePath);
      if (cancelled || hasUserEditedRef.current) return;
      setStrokes(data?.strokes ?? []);
    })();
    return () => {
      cancelled = true;
    };
    // notePath is stable for the lifetime of this component (Editor is
    // remounted per-note via a `key` prop in App), so this only runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seeds `strokes` from the shared array the moment a collab session provides one (already
  // populated by then - see hostSession.ts's/yjsBridge.ts's own seeding/snapshot-catch-up), and
  // mirrors every later remote change (a collaborator's own stroke, most commonly) into it too.
  // Keyed on the array's own identity, not just "a session exists": a resync (see
  // yjsBridge.ts's JoinedSession.generation) swaps in an entirely fresh one.
  useEffect(() => {
    const yArr = collabSession?.ySketchStrokes;
    if (!yArr) return;
    setStrokes(yArr.toArray());
    const observer = (_event: unknown, transaction: { origin: unknown }) => {
      if (transaction.origin === SKETCH_LOCAL_ORIGIN) return; // already applied locally below
      setStrokes(yArr.toArray());
    };
    yArr.observe(observer);
    return () => yArr.unobserve(observer);
  }, [collabSession?.ySketchStrokes]);

  const debouncedSaveSketch = useDebouncedCallback((next: SketchStroke[]) => {
    writeSketch(notePath, { version: 1, strokes: next });
  }, AUTOSAVE_DELAY_MS);

  // Local-only notes persist by writing the whole sidecar file (debounced); a collab session
  // persists the same way but through the shared Y.Array instead (see applyStrokesToYArray) -
  // the owner's own hostSession.ts is what actually writes that back to disk, keeping exactly one
  // writer for the file regardless of whether the strokes originated locally or from a guest.
  function persistStrokes(next: SketchStroke[]) {
    if (collabSession?.ySketchStrokes) applyStrokesToYArray(collabSession.ySketchStrokes, next);
    else debouncedSaveSketch(next);
  }

  function commitStrokes(next: SketchStroke[]) {
    hasUserEditedRef.current = true;
    undoStackRef.current.push({ kind: "ink", strokes });
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
    setStrokes(next);
    persistStrokes(next);
  }

  const sketchWidth = SKETCH_TOOL_SIZES[sketchTool][sketchSizeIndex];

  // The canvas (SketchLayer) is an `absolute inset-0` child of this same
  // wrapper, so its rect shares the exact origin this ref measures - no
  // separate ref/imperative handle into SketchLayer needed.
  const sketchWrapperRef = useRef<HTMLDivElement>(null);

  // Tier A (see textDecorationMarks.ts/sketchDecorations.ts): a gesture that
  // geometrically reads as a highlight/underline over real text becomes a
  // real ProseMirror mark instead of raster ink, so it reflows with the text
  // forever. Anything that doesn't pass the geometry check - or that misses
  // the classifier's `wrapperRect`/`resolveGestureRange` preconditions -
  // falls through unchanged to today's freeform ink. Strikethrough isn't a
  // gesture here (mid-line pen strokes were too easily confused with plain
  // ink) - it's a normal edit-mode toolbar toggle instead, alongside manual
  // highlight/underline toggles for text that isn't sketched over at all.
  function handleAddStroke(stroke: SketchStroke) {
    const wrapperRect = sketchWrapperRef.current?.getBoundingClientRect();
    if (wrapperRect) {
      let handledAsDecoration = false;
      run((ctx) => {
        const view = ctx.get(editorViewCtx);
        const resolved = resolveGestureRange(view, stroke.points, wrapperRect.left, wrapperRect.top);
        if (!resolved) return;
        const kind = classifyGesture(stroke.points, stroke.tool, resolved.line);
        if (kind === "freeform") return;

        // Word-boundary snapping only makes sense for underline - see
        // expandToWordBoundaries's doc comment for why highlight keeps the
        // raw resolved range (partial-word highlights are intentional).
        const { from, to } =
          kind === "underline" ? expandToWordBoundaries(view.state.doc, resolved.from, resolved.to) : resolved;
        const markType = kind === "highlight" ? highlightSchema.type(ctx) : underlineSchema.type(ctx);
        applyMarkToRange(ctx, from, to, markType, { color: stroke.color });
        handledAsDecoration = true;
      });
      if (handledAsDecoration) {
        undoStackRef.current.push({ kind: "mark" });
        redoStackRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
        return;
      }
    }
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
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    if (entry.kind === "ink") {
      redoStackRef.current.push({ kind: "ink", strokes });
      setStrokes(entry.strokes);
      persistStrokes(entry.strokes);
    } else {
      redoStackRef.current.push({ kind: "mark" });
      // Milkdown's history plugin isn't registered while collaborating - see setup.ts's
      // CollabPluginConfig, which swaps it for y-prosemirror's own undo/redo instead.
      if (collabSession) {
        run((ctx) => {
          const view = ctx.get(editorViewCtx);
          yUndoCommand(view.state, view.dispatch, view);
        });
      } else {
        run((ctx) => callCommand(undoCommand.key)(ctx));
      }
    }
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }

  function handleRedo() {
    const entry = redoStackRef.current.pop();
    if (!entry) return;
    if (entry.kind === "ink") {
      undoStackRef.current.push({ kind: "ink", strokes });
      setStrokes(entry.strokes);
      persistStrokes(entry.strokes);
    } else {
      undoStackRef.current.push({ kind: "mark" });
      if (collabSession) {
        run((ctx) => {
          const view = ctx.get(editorViewCtx);
          yRedoCommand(view.state, view.dispatch, view);
        });
      } else {
        run((ctx) => callCommand(redoCommand.key)(ctx));
      }
    }
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }

  // Freeze text editing while sketch mode is active - the ink canvas already
  // sits above the editor and captures pointer events, this is defense in
  // depth so keyboard input can't sneak through while drawing. `editable`
  // only blocks *editing* though, not native text selection - a stray
  // click-drag (e.g. starting on the toolbar and dragging in, or landing in
  // the note's own padding just outside the canvas) could still leave a
  // native selection behind that sketch mode's own pointer handling has no
  // way to clear, since `window.getSelection()` is independent of it. The
  // `select-none` class below stops new ones; this clears anything already
  // selected the moment sketch mode turns on.
  useEffect(() => {
    run((ctx) => {
      ctx.get(editorViewCtx).setProps({ editable: () => !sketchMode });
    });
    if (sketchMode) window.getSelection()?.removeAllRanges();
  }, [sketchMode, run]);

  // Most toolbar actions dispatch a transaction directly against the editor
  // view rather than through Milkdown's command layer, which doesn't fire the
  // listener plugin's update hooks - so selectionState has to be refreshed
  // manually right after, the same way the old runMarkCommand did for marks.
  const runAndSync = useCallback(
    (action: (ctx: Ctx) => unknown, focus = true) => {
      run((ctx) => {
        action(ctx);
        setSelectionState(getSelectionState(ctx));
        if (focus) ctx.get(editorViewCtx).focus();
      });
    },
    [run],
  );

  // Clicking below/around the last line should focus the editor and place the
  // cursor at the nearest valid position, the way Google Docs does, instead of
  // requiring a precise click directly on a line of text.
  const focusNearestPosition = useCallback(
    (clientX: number, clientY: number) => {
      run((ctx) => {
        const view = ctx.get(editorViewCtx);
        const rect = view.dom.getBoundingClientRect();
        if (rect.height === 0) return;
        const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1);
        const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
        const coords = view.posAtCoords({ left: x, top: y });
        const pos = coords ? coords.pos : view.state.doc.content.size;
        const selection = TextSelection.near(view.state.doc.resolve(pos), -1);
        view.dispatch(view.state.tr.setSelection(selection));
        view.focus();
      });
    },
    [run],
  );

  // Content-addressed rather than writeAttachment's old per-note uuid-named file: keying by the
  // bytes' own hash is what lets this same image, synced back and forth with a collaborator (see
  // assetSync.ts), dedupe onto one file instead of a fresh copy per device/session, and lets a
  // guest with no filesystem of their own (browserImageUpload.ts) store it the identical way.
  async function insertImageFile(file: File) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await hashAssetBytes(bytes);
      await fsAssetStore.put(hash, bytes);
      run((ctx) => {
        const view = ctx.get(editorViewCtx);
        const node = imageSchemaExt.type(ctx).create({ src: hash, alt: file.name, mime: file.type || "image/jpeg" });
        view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Couldn't attach that image");
      setTimeout(() => setUploadError(null), 4000);
    }
  }

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    insertImageFile(file);
  }

  // Pastes an actual image (e.g. a screenshot, or one copied from a browser
  // or Preview) the same way the file-picker path does; anything else in the
  // clipboard (text/markdown) is left alone for Milkdown's own clipboard
  // plugin to handle. Wired up as `onPasteCapture` (not `onPaste`) and calls
  // stopPropagation, not just preventDefault: ProseMirror's own paste
  // handling is a plain bubble-phase listener on the editor's DOM node
  // (prosemirror-view registers it with no capture flag), and its fallback
  // for an unrecognized paste is to let the browser's native contenteditable
  // paste run - which inserts the image itself as a second, parallel
  // `<img src="blob:...">` node alongside the one this handler inserts via
  // writeAttachment, since a blob: URL is never a valid note-relative
  // attachment path. Handling this in the capture phase on an ancestor runs
  // before the event ever reaches that bubble-phase listener, so
  // stopPropagation here keeps it from running at all for image pastes -
  // non-image paste events fall through untouched to continue their normal
  // capture/bubble path into Milkdown's own handling.
  function handleEditorPaste(e: React.ClipboardEvent) {
    const file = Array.from(e.clipboardData.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    if (file) {
      e.preventDefault();
      e.stopPropagation();
      insertImageFile(file);
      return;
    }

    // A bare note:// link (e.g. one copied via "Copy link to this point") pasted with nothing
    // selected has no text for "Add link" to attach a mark to - becomes a noteLinkChip glyph
    // instead of raw URL text. Scoped to hrefs whose note still exists in the vault, so a
    // stale/renamed link falls through to an ordinary text paste rather than planting a dead
    // glyph; scoped to the *whole* pasted string (not a substring) so pasting a link alongside
    // other copied text is left to Milkdown's normal paste handling.
    const text = e.clipboardData.getData("text/plain").trim();
    const target = text ? parseNoteLinkHref(text) : null;
    if (!target || !noteChoices.some((n) => n.path === target.path)) return;
    e.preventDefault();
    e.stopPropagation();
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      const node = noteLinkChipSchema.type(ctx).create({ href: text, linkTitle: describeNoteLinkTarget(target) });
      view.dispatch(view.state.tr.replaceSelectionWith(node));
    });
  }

  const emphasisGroup: ToolbarAction[] = [
    {
      icon: Bold,
      label: "Bold",
      action: () => runAndSync((ctx) => callCommand(toggleStrongCommand.key)(ctx)),
      isActive: selectionState.bold,
    },
    {
      icon: Italic,
      label: "Italic",
      action: () => runAndSync((ctx) => callCommand(toggleEmphasisCommand.key)(ctx)),
      isActive: selectionState.italic,
    },
  ];

  const decorationGroup: ToolbarAction[] = [
    {
      icon: Highlighter,
      label: "Highlight",
      action: () =>
        runAndSync((ctx) => toggleTextDecoration(ctx, highlightSchema.type(ctx), { color: DEFAULT_HIGHLIGHT_COLOR })),
      isActive: selectionState.highlight,
    },
    {
      icon: Underline,
      label: "Underline",
      action: () =>
        runAndSync((ctx) => toggleTextDecoration(ctx, underlineSchema.type(ctx), { color: DEFAULT_DECORATION_COLOR })),
      isActive: selectionState.underline,
    },
    {
      icon: Strikethrough,
      label: "Strikethrough",
      action: () =>
        runAndSync((ctx) =>
          toggleTextDecoration(ctx, strikethroughSchema.type(ctx), { color: DEFAULT_DECORATION_COLOR }),
        ),
      isActive: selectionState.strikethrough,
    },
  ];

  const clearFormattingButton: ToolbarAction = {
    icon: RemoveFormatting,
    label: "Clear formatting",
    action: () => runAndSync((ctx) => clearFormatting(ctx)),
  };

  // Milkdown's list_item schema requires a paragraph as its first child, so
  // headings can't be wrapped into a list item (see listCommands.ts) -
  // disable the buttons on a heading line instead of letting them no-op.
  const listDisabled = selectionState.blockStyle !== "paragraph";
  const listGroup: ToolbarAction[] = [
    {
      icon: List,
      label: "Bullet list",
      action: () => runAndSync(toggleBulletList),
      isActive: selectionState.list === "bullet",
      disabled: listDisabled,
    },
    {
      icon: ListOrdered,
      label: "Numbered list",
      action: () => runAndSync(toggleOrderedList),
      isActive: selectionState.list === "ordered",
      disabled: listDisabled,
    },
    {
      icon: ListChecks,
      label: "Checklist",
      action: () => runAndSync(toggleTaskItem),
      isActive: selectionState.list === "task",
      disabled: listDisabled,
    },
  ];

  const alignGroup: ToolbarAction[] = ALIGN_OPTIONS.map(({ align, label, icon }) => ({
    icon,
    label,
    action: () => runAndSync((ctx) => setBlockAlign(ctx, align)),
    isActive: selectionState.align === align,
  }));

  const dividerButton: ToolbarAction = {
    icon: DividerIcon,
    label: "Divider",
    action: () => runAndSync((ctx) => callCommand(insertHrCommand.key)(ctx)),
  };

  const codeBlockButton: ToolbarAction = {
    icon: Code,
    label: "Code block",
    action: () => runAndSync((ctx) => callCommand(createCodeBlockCommand.key)(ctx)),
  };

  // "Copy link to this point" (SelectionLinkToolbar): plants a notePin at the selection's end
  // and copies a link to it. Reads the live selection at call time rather than a range captured
  // when the toolbar first appeared - safe because the toolbar's own buttons preventDefault on
  // mousedown (see SelectionLinkToolbar.tsx), which keeps ProseMirror's selection untouched even
  // though DOM focus itself never has to leave the editor for this one (unlike Add Link's popover
  // input, which does, and which applyPickedLink below relies on the same guarantee for).
  //
  // Also collapses the selection to right after the new pin (so the highlighted text doesn't
  // stay selected once its point has a pin) and clicks the pin's own DOM node - the NodeView's
  // click handler is what actually opens NotePinPopover (see notePinView.ts), and reusing it here
  // means the popover opens anchored and wired to `remove` exactly the way a manual click would.
  async function copyLinkToPoint() {
    const id = crypto.randomUUID();
    let planted = false;
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { to, empty } = state.selection;
      if (empty) return;
      const node = notePinSchema.type(ctx).create({ id });
      const tr = state.tr.insert(to, node);
      tr.setSelection(TextSelection.near(tr.doc.resolve(to + node.nodeSize)));
      view.dispatch(tr);
      planted = true;
    });
    if (!planted) return;
    document.getElementById(`note-pin-${id}`)?.click();
    await navigator.clipboard.writeText(buildNoteLinkHref(notePath, { pinId: id }));
  }

  // "Add link" (SelectionLinkToolbar -> NoteLinkQuickPicker): applies an already-built href
  // (searched for, or pasted verbatim) to the selection active when the toolbar appeared. Safe to
  // read `state.selection` fresh here even though the popover's own <input> now holds DOM focus -
  // that input lives outside the ProseMirror view's DOM (portaled to document.body), so
  // ProseMirror's selectionchange listener never mirrors it into `state.selection`.
  function applyPickedLink(href: string, markTitle: string) {
    runAndSync((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to, empty } = state.selection;
      if (empty) return;
      const mark = linkSchema.type(ctx).create({ href, title: markTitle });
      view.dispatch(state.tr.addMark(from, to, mark));
    });
  }

  return (
    <div className="relative flex h-full flex-col" data-note-editor-root>
      {toolbarVisible && sketchMode && (
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
          onExit={onToggleSketchMode}
        />
      )}
      {toolbarVisible && !sketchMode && (
        <div className="border-subtle flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
          {sketchEnabled && (
            <>
              <button
                type="button"
                onClick={onToggleSketchMode}
                title="Sketch on this note"
                aria-label="Toggle sketch mode"
                aria-pressed={sketchMode}
                className="btn-ghost h-7 w-7 shrink-0"
              >
                <Brush size={14} />
              </button>
              <div className="divider mx-1 h-5 w-px shrink-0" />
            </>
          )}
          <TextStyleDropdown
            blockStyle={selectionState.blockStyle}
            onSelect={(style) =>
              runAndSync((ctx) => {
                liftOutOfList(ctx);
                callCommand(wrapInHeadingCommand.key, style === "paragraph" ? 0 : style)(ctx);
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
            onClick={clearFormattingButton.action}
            title={clearFormattingButton.label}
            aria-label={clearFormattingButton.label}
            className="btn-ghost h-7 w-7 shrink-0"
          >
            <clearFormattingButton.icon size={14} />
          </button>
          <TableMenu
            inTable={selectionState.inTable}
            cellAlign={selectionState.cellAlign}
            onInsert={(row, col) => runAndSync((ctx) => insertTable(ctx, row, col))}
            onAddRow={() => runAndSync(addTableRow)}
            onAddColumn={() => runAndSync(addTableColumn)}
            onDeleteRow={() => runAndSync(deleteTableRow)}
            onDeleteColumn={() => runAndSync(deleteTableColumn)}
            onDeleteTable={() => runAndSync(deleteCurrentTable)}
            onSetCellColor={(color) => runAndSync((ctx) => setTableCellBackground(ctx, color))}
            onSetCellAlign={(align) => runAndSync((ctx) => setTableColumnAlign(ctx, align))}
          />
          <button
            type="button"
            onClick={dividerButton.action}
            title={dividerButton.label}
            aria-label={dividerButton.label}
            className="btn-ghost h-7 w-7 shrink-0"
          >
            <dividerButton.icon size={14} />
          </button>
          <ImageMenu
            wrap={selectionState.imageWrap}
            onInsert={() => fileInputRef.current?.click()}
            onSetWrap={(wrap) => runAndSync((ctx) => setSelectedImageWrap(ctx, wrap))}
          />
          {selectionState.imageWrap !== null && (
            <button
              type="button"
              onClick={() => runAndSync((ctx) => toggleSelectedImageCrop(ctx))}
              title="Crop image"
              aria-label="Crop image"
              aria-pressed={imageCropping}
              className={`btn-ghost h-7 w-7 shrink-0 ${imageCropping ? "bg-accent-soft text-accent" : ""}`}
            >
              <Crop size={14} />
            </button>
          )}
          {codeBlockEnabled && (
            <button
              type="button"
              onClick={codeBlockButton.action}
              title={codeBlockButton.label}
              aria-label={codeBlockButton.label}
              className="btn-ghost h-7 w-7 shrink-0"
            >
              <codeBlockButton.icon size={14} />
            </button>
          )}
          <div className="divider mx-1 h-5 w-px shrink-0" />
          <LookDropdown look={look} onSelect={handleSelectLook} />
          {uploadError && <span className="text-danger ml-2 shrink-0 text-xs">{uploadError}</span>}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageChange}
        className="hidden"
      />

      <div
        ref={scrollContainerRef}
        onScroll={(e) => scrollPositions.set(notePath, e.currentTarget.scrollTop)}
        className={`prose-note milkdown-scroll h-full flex-1 overflow-y-auto px-12 py-8 @max-lg:px-6 @max-lg:py-5 @max-sm:px-3 @max-sm:py-3 ${sketchMode ? "select-none" : ""} ${look !== "plain" ? `note-look-${look}` : ""}`}
      >
        <div
          ref={sketchWrapperRef}
          className="relative min-h-full"
          onPasteCapture={handleEditorPaste}
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            focusNearestPosition(e.clientX, e.clientY);
          }}
        >
          <Milkdown />
          <SketchLayer
            className="absolute inset-0"
            active={sketchMode}
            strokes={strokes}
            tool={sketchTool}
            color={sketchColor}
            width={sketchWidth}
            onAddStroke={handleAddStroke}
            onEraseStrokes={handleEraseStrokes}
          />
        </div>
      </div>

      <SelectedImageToolbar
        imageWrap={sketchMode ? null : selectionState.imageWrap}
        cropping={imageCropping}
        containerRef={sketchWrapperRef}
        onSetWrap={(wrap) => runAndSync((ctx) => setSelectedImageWrap(ctx, wrap))}
        onToggleCrop={() => runAndSync((ctx) => toggleSelectedImageCrop(ctx))}
      />

      <div className="text-tertiary pointer-events-none absolute bottom-5 right-7 text-xs transition-opacity duration-300 @max-sm:bottom-2 @max-sm:right-3">
        {status === "saving" && "Saving…"}
        {status === "saved" && "Saved"}
        {status === "pending" && "Editing…"}
      </div>

      <SelectionLinkToolbar
        range={sketchMode ? null : selectionRange}
        notes={noteChoices}
        onCopyLinkToPoint={copyLinkToPoint}
        onApplyLink={applyPickedLink}
      />

      {pinPopover && (
        <NotePinPopover
          notePath={notePath}
          pinId={pinPopover.id}
          anchorRef={{ current: pinPopover.element }}
          onRemove={pinPopover.remove}
          onClose={() => setPinPopover(null)}
        />
      )}

      {voiceNotePopover && (
        <VoiceNotePopover
          voiceSrc={voiceNotePopover.voiceSrc}
          voiceDur={voiceNotePopover.voiceDur}
          anchorRef={{ current: voiceNotePopover.element }}
          onAppend={voiceNotePopover.startAppend}
          onRemove={voiceNotePopover.remove}
          onClose={() => setVoiceNotePopover(null)}
        />
      )}

      {linkPopover && (
        <LinkPopover
          href={linkPopover.href}
          markTitle={linkPopover.markTitle}
          anchorRef={{ current: linkPopover.element }}
          notes={noteChoices}
          onOpen={() => {
            openLinkHref(linkPopover.href, onNavigateToNoteLink);
            setLinkPopover(null);
          }}
          onApplyEdit={(href, markTitle) => {
            linkPopover.applyEdit(href, markTitle);
            setLinkPopover(null);
          }}
          onRemove={linkPopover.remove}
          onClose={() => setLinkPopover(null)}
        />
      )}

      {noteLinkTrigger &&
        createPortal(
          <div
            style={{ position: "fixed", left: noteLinkTrigger.coords.left, top: noteLinkTrigger.coords.top + 4, zIndex: 50 }}
            className="glass-surface shadow-app-lg w-64 rounded-xl p-1.5"
          >
            <NoteLinkResultsList
              results={filterNoteChoices(noteChoices, noteLinkTrigger.query)}
              activeIndex={noteLinkTrigger.activeIndex}
              onHoverIndex={() => {}}
              onChoose={chooseNoteLinkTriggerResult}
              emptyMessage="No matching notes."
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

export function Editor(props: EditorProps) {
  return (
    <MilkdownProvider>
      <NoteEditor {...props} />
    </MilkdownProvider>
  );
}
