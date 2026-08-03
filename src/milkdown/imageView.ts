import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import { NodeSelection } from "@milkdown/kit/prose/state";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import type { AssetStore } from "../collab/assetStore";
import type { ImageCrop } from "./imageSchemaExtensions";

/** How an image's bytes get resolved to something displayable - injected rather than imported
 * directly so this NodeView (and the schema plugin it's paired with) can be shared verbatim
 * between the desktop build (backed by fsAssetStore, src/utils/fsNotes.ts) and the browser-guest
 * build (backed by idbAssetStore, src/browser-guest/idbAssetStore.ts) without either one pulling
 * in the other's platform-specific storage - the exact thing that used to keep this file
 * desktop-only (it imported `@tauri-apps/plugin-fs`'s readAttachment directly), see
 * scripts/check-browser-bundle.mjs. */
export interface ImageAssetResolver {
  /** This device's own local cache - checked first, and where a network fetch below gets
   * written once it succeeds, so the same image never has to be re-requested. */
  store: AssetStore;
  /** Best-effort fetch from a connected peer for a key `store` doesn't have - absent when
   * there's no active collab session (nowhere to ask). See hostSession.ts's/yjsBridge.ts's
   * resolveAsset for what backs this. */
  fetchRemote?: (key: string) => Promise<Uint8Array>;
}

const resolvedCache = new Map<string, string>();

function isExternal(src: string): boolean {
  return /^(https?:|data:)/.test(src);
}

function mimeFromExtension(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/jpeg";
  }
}

/** Resolves an image node's `src` (a content hash, or a legacy relative attachment path) to a
 * displayable blob: URL - the local store first, then (if a collab session provides it) a
 * network fetch from whichever peer has it, caching either result the same way Preview.tsx used
 * to. A blob URL rather than a base64 data: URL on purpose: the bytes stay as bytes all the way
 * through (no ~33% base64 inflation sitting in memory for the life of the cache entry), the same
 * efficiency-minded reasoning as keeping asset transfer itself out of the base64-heavy Yjs
 * update stream in the first place (see assetSync.ts). */
async function resolveSrc(src: string, mime: string | null, resolver: ImageAssetResolver): Promise<string> {
  if (!src || isExternal(src)) return src;
  const cached = resolvedCache.get(src);
  if (cached) return cached;
  let bytes = await resolver.store.get(src);
  if (!bytes && resolver.fetchRemote) bytes = await resolver.fetchRemote(src);
  if (!bytes) throw new Error(`Couldn't load image: ${src}`);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime ?? mimeFromExtension(src) }));
  resolvedCache.set(src, url);
  return url;
}

/** Broadcast on the ProseMirror view's DOM by the "Crop image" toolbar
 * button (see imageCommands.ts) - every image NodeView hears it, but only
 * the currently-selected one (`.selected` class) acts on it, the same
 * "selection gates the effect" shape as setSelectedImageWrap. */
export const IMAGE_CROP_TOGGLE_EVENT = "plainotes:image-crop-toggle";
/** Fired back by whichever NodeView enters/exits crop mode, so the toolbar
 * button can mirror its pressed state without any of this living in node
 * attrs (crop-mode-active is transient UI state, not part of the document). */
export const IMAGE_CROP_CHANGED_EVENT = "plainotes:image-crop-changed";
/** Broadcast on the ProseMirror view's DOM (see Editor.tsx's `look`-change effect) whenever the
 * note-look preference finishes loading or changes - every image NodeView hears it and
 * recomputes its ruled-paper alignment compensation (see applyAlignmentFix). Needed because
 * `look` loads asynchronously (starts "plain", then loads the real saved preference from disk -
 * see Editor.tsx), so an image's own "load" event - the normal trigger for that recompute - can
 * easily fire *before* the "paper"/"index-card" class is even on `.prose-note` yet, correctly
 * no-opping at the time but with nothing else left to ever retry it once the class does land. */
export const NOTE_LOOK_CHANGED_EVENT = "plainotes:note-look-changed";

/** Smallest frame dimension (CSS px) a resize handle will shrink an image
 * to - below this the handles themselves would no longer fit on the image. */
const MIN_SIZE = 40;
/** How much room around the container's edge to leave when clamping the max
 * drag size, so the image can't be dragged wider than its column even
 * though `max-width: 100%` alone would just visually cap (not clamp the
 * tracked value), letting the drag desync from the mouse until dragged back
 * past the untracked overflow. */
const CONTAINER_EDGE_MARGIN = 48;
/** A crop can never leave less than this fraction of the image visible along
 * either axis - keeps the crop rect from collapsing to a sliver or flipping
 * inside-out while dragging. */
const MIN_CROP_FRACTION = 0.1;

type Dir = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
const DIRS: Dir[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Resize transform-origin per handle: the opposite corner/edge, so scaling
 * during a live drag grows visually toward whichever handle is being
 * dragged (including the "n"/"w" ones, which a flow-anchored box can't
 * otherwise move toward - see the comment on `onResizePointerDown`). */
const RESIZE_ORIGIN: Record<Dir, string> = {
  nw: "100% 100%",
  n: "50% 100%",
  ne: "0% 100%",
  e: "0% 50%",
  se: "0% 0%",
  s: "50% 0%",
  sw: "100% 0%",
  w: "100% 50%",
};
const DIR_CURSOR: Record<Dir, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cropOf(node: ProseNode): ImageCrop {
  return {
    cropLeft: (node.attrs.cropLeft as number) || 0,
    cropTop: (node.attrs.cropTop as number) || 0,
    cropRight: (node.attrs.cropRight as number) || 0,
    cropBottom: (node.attrs.cropBottom as number) || 0,
  };
}

/** A resize/crop handle's pointerdown/up is followed by a synthetic
 * `click` targeting the same handle - `stopPropagation`/`preventDefault` on
 * the pointer event alone doesn't stop it. Left unhandled, its *default
 * action* still runs: the browser drops the caret into the nearest editable
 * text near a click on/around a `contenteditable="false"` island, and
 * ProseMirror's own `selectionchange` listener mirrors that into a
 * TextSelection, silently clearing the image's NodeSelection right after
 * every single resize/crop drag. Also cover `mousedown` for the same
 * "separate compatibility event our stopEvent/stopPropagation don't reach"
 * reason. */
function swallowMouseEvent(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function isCropped(crop: ImageCrop): boolean {
  return crop.cropLeft > 0 || crop.cropTop > 0 || crop.cropRight > 0 || crop.cropBottom > 0;
}

interface ResizeDrag {
  dir: Dir;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  pendingWidth: number;
  pendingHeight: number;
}

/** A crop is edited as fractions of the image's own full (uncropped) size at
 * its current display scale - scale-invariant on purpose (see `ImageCrop`),
 * which is also why `fullWidth`/`fullHeight` stay fixed for the whole
 * session: only the fractions move as the crop handles are dragged, never
 * the underlying scale. */
interface CropSession {
  fullWidth: number;
  fullHeight: number;
  crop: ImageCrop;
}

interface CropDrag {
  dir: Dir;
  startX: number;
  startY: number;
  startCrop: ImageCrop;
}

/** A `wrap: "above"` image is dragged relative to its offsetParent (the
 * note's one positioned ancestor - see the CSS comment on
 * `[data-wrap="above"]`), tracked in that same coordinate space throughout
 * so the live drag and the final committed `x`/`y` agree. `moved` gates
 * whether a plain click (no movement) is left alone to fall through to
 * ProseMirror's own click-to-select handling, vs. an actual drag that needs
 * its trailing synthetic click swallowed (see `onFramePointerUp`). */
interface PositionDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLeft: number;
  startTop: number;
  // Horizontal is clamped to the container's width (there's no horizontal
  // scroll to spill into); vertical is only floored at 0 - dragging below
  // existing content is fine, `.prose-note`'s own overflow-y:auto just grows
  // to include it, the same as a long note naturally would.
  maxLeft: number;
  moved: boolean;
}

/** Below this many CSS px of pointer movement, a pointerdown-then-up on the
 * image body is treated as a plain click (select/no-op) rather than a drag -
 * without this, ProseMirror's native click-to-select would never get a
 * chance to run on a simple click, since even a 1px jitter would otherwise
 * count as "dragged". */
const POSITION_DRAG_THRESHOLD = 4;

/** NodeView for the standard commonmark `image` node: attrs.src stays the
 * relative attachment path (so `![alt](path)` round-trips to disk unchanged),
 * while the displayed <img src> is resolved asynchronously to a data URL.
 *
 * Layout is a `frame` (clips, sized to the committed width/height) around an
 * `img` that's sized/offset from the crop fractions - when uncropped this
 * reduces to the img exactly filling the frame, so the same formula covers
 * both. Until the image has ever been resized or cropped, both stay in their
 * simple, untouched form (frame unsized, img sized by the browser/CSS) so
 * plain images keep their original natural-flow behavior.
 *
 * Resize and crop are both drag interactions that only touch the live DOM
 * (`frame`/`img` inline styles) while dragging, and only round-trip through
 * a ProseMirror transaction once on release - keeps dragging smooth (no
 * transaction/re-render per pointermove) the same way the plain-resize
 * version of this file did. */
class ImageNodeView implements NodeView {
  dom: HTMLElement;
  private frame: HTMLElement;
  private img: HTMLImageElement;
  private resizeHandles = new Map<Dir, HTMLElement>();
  private cropHandles: Map<Dir, HTMLElement> | null = null;
  private scrim: { top: HTMLElement; bottom: HTMLElement; left: HTMLElement; right: HTMLElement } | null = null;
  private cropOutline: HTMLElement | null = null;
  private node: ProseNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private resolver: ImageAssetResolver;
  private resizeDrag: ResizeDrag | null = null;
  private cropDrag: CropDrag | null = null;
  private cropSession: CropSession | null = null;
  private positionDrag: PositionDrag | null = null;
  private suppressNextClick = false;
  private alignRaf: number | null = null;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined, resolver: ImageAssetResolver) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.resolver = resolver;

    this.dom = document.createElement("span");
    this.dom.className = "milkdown-image-view";

    this.frame = document.createElement("span");
    this.frame.className = "image-frame";
    this.dom.appendChild(this.frame);

    this.img = document.createElement("img");
    // Browsers natively drag an <img> on mousedown+move (a ghost-image
    // HTML5 drag-and-drop gesture), which would fire instead of the steady
    // stream of pointermove events the position-drag below needs - has to
    // be off before that can work at all.
    this.img.draggable = false;
    this.frame.appendChild(this.img);

    this.frame.addEventListener("pointerdown", this.onFramePointerDown);
    this.frame.addEventListener("pointermove", this.onFramePointerMove);
    this.frame.addEventListener("pointerup", this.onFramePointerUp);
    this.frame.addEventListener("pointercancel", this.onFramePointerUp);
    this.frame.addEventListener("click", this.onFrameClick);

    for (const dir of DIRS) {
      const handle = document.createElement("span");
      handle.className = `image-resize-handle image-resize-handle-${dir}`;
      handle.contentEditable = "false";
      handle.style.cursor = DIR_CURSOR[dir];
      handle.addEventListener("pointerdown", (event) => this.onResizePointerDown(event, dir));
      handle.addEventListener("pointermove", this.onResizePointerMove);
      handle.addEventListener("pointerup", this.onResizePointerUp);
      handle.addEventListener("pointercancel", this.onResizePointerUp);
      handle.addEventListener("mousedown", swallowMouseEvent);
      handle.addEventListener("click", swallowMouseEvent);
      this.dom.appendChild(handle);
      this.resizeHandles.set(dir, handle);
    }

    this.view.dom.addEventListener(IMAGE_CROP_TOGGLE_EVENT, this.onCropToggleRequested);
    document.addEventListener("keydown", this.onKeyDown);

    // Recomputes alignment once the natural (unsized) image's real dimensions are known - see
    // applyAlignmentFix's own comment for why this has to be event-driven rather than a
    // continuously-observed size, and scheduleAlignmentFix's for why "load" alone (not e.g. a
    // ResizeObserver on `img`) is what's wired up here.
    this.img.addEventListener("load", this.scheduleAlignmentFix);
    // See NOTE_LOOK_CHANGED_EVENT's own comment - closes the race between the note-look
    // preference's async load and this image's own (often faster) "load" event above.
    this.view.dom.addEventListener(NOTE_LOOK_CHANGED_EVENT, this.scheduleAlignmentFix);

    this.applyWrap(node);
    this.applyLayout(node);
    this.applyPosition(node);
    this.renderImg(node);
    this.scheduleAlignmentFix();
  }

  private applyWrap(node: ProseNode) {
    this.dom.dataset.wrap = (node.attrs.wrap as string) || "inline";
  }

  /** note-look-paper/index-card quantize every text line's height to a whole
   * multiple of `--rule` (see index.css) so the ruled background never drifts
   * out from under the text - but an image sitting in flow isn't clamped by
   * `line-height` the way text is: once it's taller than one rule row, its
   * containing block's real height stops being a multiple of `--rule` and
   * every line below permanently desyncs from the background. Rather than
   * resizing the image (which the user explicitly chose), reserve extra
   * bottom space so the image's *total* footprint (its own CSS margin plus
   * this compensation) rounds up to the next rule line, the same "whole
   * multiples of --rule" contract index.css's own text rule already relies on.
   *
   * Applied to `dom` (this NodeView's own root), never to `block` (the containing paragraph):
   * `block` belongs to ProseMirror, not to this NodeView, and `ignoreMutation` below only
   * suppresses its own DOM observer for mutations within `dom`'s subtree - writing to an
   * ancestor it doesn't own is a mutation ProseMirror doesn't know is "expected", so it
   * reconciles by rebuilding the surrounding content, which recreates this NodeView, which
   * reruns this fix, which mutates `block` again - an infinite reconstruct loop (confirmed
   * during development: thousands of rebuilds within a couple of minutes). Compensating on
   * `dom` itself keeps every mutation inside the one boundary ProseMirror already knows to
   * leave alone, while still growing `block`'s rendered height the same way: an inline-level
   * child's own bottom margin is part of the line box its containing paragraph is sized to.
   *
   * Deliberately called only from specific mutation points (initial load, resize-drag release,
   * crop commit/cancel, a remote collaborator's resize landing in `update`, the note-look
   * preference resolving) rather than driven by a live ResizeObserver watching the image's own
   * box. A ResizeObserver here is a real feedback hazard: an unsized image capped by
   * `max-width: 100%` can be narrowed by its own column (e.g. a vertical scrollbar toggling on
   * because this very fix just grew the note's total height), which shrinks the image's
   * rendered height, which this fix would then react to by shrinking the margin, which shrinks
   * the total height, which removes the scrollbar, which widens the column, which grows the
   * image back - an unbounded loop that pins the image's own size in constant flux (breaking
   * click/resize-drag targeting) and fights the user's own scroll position every frame. Firing
   * only at the handful of moments a size change is a deliberate, one-shot user (or synced)
   * action avoids ever entering that loop too. */
  private scheduleAlignmentFix = () => {
    if (this.alignRaf != null) return;
    this.alignRaf = requestAnimationFrame(() => {
      this.alignRaf = null;
      this.applyAlignmentFix();
    });
  };

  private applyAlignmentFix() {
    // `above` images are position:absolute (out of flow) - nothing for them
    // to desync from.
    if (((this.node.attrs.wrap as string) || "inline") === "above") return;
    const block = this.dom.closest<HTMLElement>("p, li, blockquote, h1, h2, h3");
    const proseNote = this.dom.closest<HTMLElement>(".prose-note");
    if (!block || !proseNote) return;
    const gridded = proseNote.classList.contains("note-look-paper") || proseNote.classList.contains("note-look-index-card");
    if (!gridded) {
      if (this.dom.style.marginBottom) this.dom.style.marginBottom = "";
      return;
    }
    const rule = parseFloat(getComputedStyle(proseNote).getPropertyValue("--rule"));
    if (!rule) return;
    // Clear any previous compensation first - both to fall back to the CSS-defined base margin
    // (`.milkdown-image-view`'s `margin: 0.4em 0`, read below) before adding to it, and so a
    // shrink (e.g. cropping the image shorter) doesn't keep stale extra padding.
    this.dom.style.marginBottom = "";
    const baseMarginBottom = parseFloat(getComputedStyle(this.dom).marginBottom) || 0;
    const remainder = block.getBoundingClientRect().height % rule;
    if (remainder >= 0.5) this.dom.style.marginBottom = `${baseMarginBottom + (rule - remainder)}px`;
  }

  /** Positions `dom` from committed `x`/`y` node attrs - only meaningful for
   * `wrap: "above"` (see the CSS comment on `[data-wrap="above"]`); every
   * other mode clears any leftover inline position so it falls back to
   * normal flow/float. Until a `wrap: "above"` image has ever been dragged,
   * `x`/`y` stay null and it renders at its typed ("static") position - the
   * same null-means-untouched shape `layoutFrame` uses for width/height. */
  private applyPosition(node: ProseNode) {
    const wrap = (node.attrs.wrap as string) || "inline";
    const x = wrap === "above" ? (node.attrs.x as number | null) : null;
    const y = wrap === "above" ? (node.attrs.y as number | null) : null;
    this.dom.style.left = x != null ? `${x}px` : "";
    this.dom.style.top = y != null ? `${y}px` : "";
  }

  /** Sizes `frame`/`img` from committed node attrs (or explicit overrides
   * while freezing a natural-flow image into its first resize/crop - see
   * `freezeFrame`). Bypassed entirely while a crop session has the frame
   * showing the crop-preview layout instead (see `enterCropMode`). */
  private layoutFrame(width: number | null, height: number | null, crop: ImageCrop) {
    const cropped = isCropped(crop);
    if (width == null && height == null && !cropped) {
      this.frame.classList.remove("sized");
      this.frame.style.width = "";
      this.frame.style.height = "";
      this.img.style.width = "";
      this.img.style.height = "";
      this.img.style.left = "";
      this.img.style.top = "";
      return;
    }

    this.frame.classList.add("sized");
    const rect = width == null || height == null ? this.frame.getBoundingClientRect() : null;
    const w = width ?? rect!.width;
    const h = height ?? rect!.height;
    this.frame.style.width = `${w}px`;
    this.frame.style.height = `${h}px`;

    const visW = 1 - crop.cropLeft - crop.cropRight;
    const visH = 1 - crop.cropTop - crop.cropBottom;
    const fullW = w / visW;
    const fullH = h / visH;
    this.img.style.width = `${fullW}px`;
    this.img.style.height = `${fullH}px`;
    this.img.style.left = `${-crop.cropLeft * fullW}px`;
    this.img.style.top = `${-crop.cropTop * fullH}px`;
  }

  private applyLayout(node: ProseNode) {
    this.layoutFrame(node.attrs.width as number | null, node.attrs.height as number | null, cropOf(node));
  }

  /** Flips a still-"natural" frame (never resized/cropped) into its explicit
   * sized form, frozen at its current rendered box, so a resize or crop
   * drag always has a stable, known-size starting point to scale from. */
  private freezeFrame(): DOMRect {
    if (!this.frame.classList.contains("sized")) {
      const rect = this.frame.getBoundingClientRect();
      this.layoutFrame(rect.width, rect.height, cropOf(this.node));
    }
    return this.frame.getBoundingClientRect();
  }

  private renderImg(node: ProseNode) {
    this.img.alt = (node.attrs.alt as string) ?? "";
    this.img.title = (node.attrs.title as string) ?? "";
    const src = (node.attrs.src as string) ?? "";
    if (!src || isExternal(src)) {
      this.img.src = src;
      return;
    }
    const mime = (node.attrs.mime as string | null | undefined) ?? null;
    resolveSrc(src, mime, this.resolver)
      .then((resolved) => {
        this.img.src = resolved;
      })
      .catch(() => {
        this.img.alt = `Couldn't load image: ${src}`;
      });
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    const srcChanged = node.attrs.src !== this.node.attrs.src;
    this.node = node;
    this.applyWrap(node);
    // While a resize or crop is live, the DOM is ahead of whatever's still
    // committed to the node - don't stomp it back to the stale attrs on
    // every incidental update.
    if (!this.resizeDrag && !this.cropSession) {
      this.applyLayout(node);
      // Covers a remote collaborator's resize/crop landing here via Yjs - this device's own
      // resize/crop already schedules this itself at the point that drag/session ends.
      this.scheduleAlignmentFix();
    }
    if (!this.positionDrag) this.applyPosition(node);
    if (srcChanged) {
      this.renderImg(node);
    } else {
      this.img.alt = (node.attrs.alt as string) ?? "";
      this.img.title = (node.attrs.title as string) ?? "";
    }
    return true;
  }

  selectNode() {
    this.dom.classList.add("selected");
  }

  deselectNode() {
    this.dom.classList.remove("selected");
    // Clicking elsewhere is exactly the "click away" gesture that commits a
    // crop in Google Docs too - don't strand the user mid-crop just because
    // their selection moved off the image.
    if (this.cropSession) this.commitCrop();
  }

  destroy() {
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("pointerdown", this.onDocPointerDownDuringCrop, true);
    this.view.dom.removeEventListener(IMAGE_CROP_TOGGLE_EVENT, this.onCropToggleRequested);
    this.view.dom.removeEventListener(NOTE_LOOK_CHANGED_EVENT, this.scheduleAlignmentFix);
    this.restoreTextSelection();
    this.clearSelectionGuard();
    this.img.removeEventListener("load", this.scheduleAlignmentFix);
    if (this.alignRaf != null) cancelAnimationFrame(this.alignRaf);
  }

  // Dragging a handle starts its gesture on a `contenteditable="false"`
  // island; browsers still sometimes carry that mousedown into a native
  // text-selection drag as the pointer crosses the editable content next to
  // it, which then lands a real DOM selection inside a paragraph - and
  // ProseMirror mirrors *that* into a TextSelection via its own
  // `selectionchange` listener, silently clearing the image's NodeSelection
  // out from under the drag. Suppressing `mousedown`/preventDefault alone
  // doesn't stop it; hard-disabling text selection for the drag's duration
  // does.
  private restoreUserSelect: string | null = null;

  private disableTextSelection() {
    this.restoreUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
  }

  private restoreTextSelection() {
    if (this.restoreUserSelect === null) return;
    document.body.style.userSelect = this.restoreUserSelect;
    this.restoreUserSelect = null;
  }

  private pendingSelectionGuard: (() => void) | null = null;

  /** A resize/crop drag ends on a `contenteditable="false"` handle, which
   * isn't a valid caret target - a few ms after `pointerup`/`click` (neither
   * of which this can be intercepted through: `preventDefault` on both was
   * tried and doesn't stop it), the browser drops the native caret into the
   * nearest real text anyway, and ProseMirror's `selectionchange` listener
   * mirrors that into a TextSelection, clearing the image's NodeSelection.
   * Rather than fight *why* the browser does this, just watch for that one
   * stray `selectionchange` and put the NodeSelection straight back. */
  private guardSelectionAfterDrag(pos: number) {
    this.clearSelectionGuard();
    const handler = () => {
      this.clearSelectionGuard();
      const { state } = this.view;
      if (state.selection instanceof NodeSelection && state.selection.from === pos) return;
      if (!state.doc.nodeAt(pos)) return;
      this.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
    };
    this.pendingSelectionGuard = handler;
    document.addEventListener("selectionchange", handler);
    // Safety net in case no stray selectionchange ever follows this drag.
    window.setTimeout(() => this.clearSelectionGuard(), 500);
  }

  private clearSelectionGuard() {
    if (!this.pendingSelectionGuard) return;
    document.removeEventListener("selectionchange", this.pendingSelectionGuard);
    this.pendingSelectionGuard = null;
  }

  // --- Resize (8 handles: corners keep aspect ratio, edges are free) -----

  private onResizePointerDown = (event: PointerEvent, dir: Dir) => {
    if (this.cropSession) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.freezeFrame();
    const container = this.dom.closest<HTMLElement>(".prose-note");
    const maxWidth = Math.max(MIN_SIZE, (container?.clientWidth ?? window.innerWidth) - CONTAINER_EDGE_MARGIN);
    const maxHeight = Math.max(MIN_SIZE, window.innerHeight - CONTAINER_EDGE_MARGIN);
    this.resizeDrag = {
      dir,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      minWidth: MIN_SIZE,
      minHeight: MIN_SIZE,
      maxWidth,
      maxHeight,
      pendingWidth: rect.width,
      pendingHeight: rect.height,
    };
    this.dom.classList.add("resizing");
    // A flow-anchored box (inline/floated, not absolutely positioned) can
    // only ever grow its bottom-right edge in CSS - its top-left corner is
    // pinned by document flow. Scaling from the *opposite* corner/edge via
    // `transform` sidesteps that: the transform is paint-only (no reflow),
    // so it can visually grow toward an "n"/"w" handle during the drag
    // without actually moving the box's flow position, and gets swapped for
    // real committed width/height (which do reflow) on pointerup.
    this.frame.style.transformOrigin = RESIZE_ORIGIN[dir];
    this.disableTextSelection();
    this.resizeHandles.get(dir)!.setPointerCapture(event.pointerId);
  };

  private onResizePointerMove = (event: PointerEvent) => {
    const drag = this.resizeDrag;
    if (!drag) return;
    const { dir, startX, startY, startWidth, startHeight, minWidth, minHeight, maxWidth, maxHeight } = drag;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const growX = dir.includes("w") ? -dx : dir.includes("e") ? dx : 0;
    const growY = dir.includes("n") ? -dy : dir.includes("s") ? dy : 0;

    let newWidth = startWidth;
    let newHeight = startHeight;
    if (dir.length === 2) {
      // Corner: preserve aspect ratio, driven by whichever axis moved more.
      const aspect = startWidth / startHeight;
      if (Math.abs(growX) >= Math.abs(growY)) {
        newWidth = clamp(startWidth + growX, minWidth, maxWidth);
        newHeight = clamp(newWidth / aspect, minHeight, maxHeight);
        newWidth = newHeight * aspect;
      } else {
        newHeight = clamp(startHeight + growY, minHeight, maxHeight);
        newWidth = clamp(newHeight * aspect, minWidth, maxWidth);
        newHeight = newWidth / aspect;
      }
    } else if (dir === "e" || dir === "w") {
      newWidth = clamp(startWidth + growX, minWidth, maxWidth);
    } else {
      newHeight = clamp(startHeight + growY, minHeight, maxHeight);
    }

    drag.pendingWidth = newWidth;
    drag.pendingHeight = newHeight;
    this.frame.style.transform = `scale(${newWidth / startWidth}, ${newHeight / startHeight})`;
  };

  private onResizePointerUp = (event: PointerEvent) => {
    const drag = this.resizeDrag;
    if (!drag) return;
    event.preventDefault();
    this.resizeDrag = null;
    this.dom.classList.remove("resizing");
    this.frame.style.transform = "";
    this.frame.style.transformOrigin = "";
    this.restoreTextSelection();
    this.resizeHandles.get(drag.dir)!.releasePointerCapture(event.pointerId);

    const width = Math.round(drag.pendingWidth);
    const height = Math.round(drag.pendingHeight);
    // Bake the scaled preview into real (reflow-affecting) dimensions ahead
    // of the transaction round-trip, so there's no visible snap back to the
    // pre-drag size while `update` is still pending.
    this.layoutFrame(width, height, cropOf(this.node));
    this.scheduleAlignmentFix();
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width, height }));
    this.guardSelectionAfterDrag(pos);
  };

  // --- Position drag (wrap: "above" only - free placement anywhere in the
  // note; see the CSS comment on `[data-wrap="above"]` for the positioning
  // model) ------------------------------------------------------------

  private onFramePointerDown = (event: PointerEvent) => {
    if (this.resizeDrag || this.cropSession) return;
    if ((this.node.attrs.wrap as string) !== "above") return;
    // Only once selected - otherwise a plain click on an unselected image
    // would arm a drag before the user ever meant to move it. The threshold
    // in `onFramePointerMove` still leaves a plain click-to-reselect (no
    // movement) alone to fall through to ProseMirror's own handling below.
    if (!this.dom.classList.contains("selected")) return;
    const container = this.dom.offsetParent as HTMLElement | null;
    if (!container) return;
    const rect = this.dom.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    this.positionDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: rect.left - containerRect.left,
      startTop: rect.top - containerRect.top,
      maxLeft: Math.max(0, container.clientWidth - rect.width),
      moved: false,
    };
    // Deliberately no preventDefault/stopPropagation/setPointerCapture yet -
    // that's held off until the first pointermove past the threshold, so an
    // actual no-movement click passes straight through to ProseMirror's own
    // mousedown-based node selection, same as clicking any other image.
  };

  private onFramePointerMove = (event: PointerEvent) => {
    const drag = this.positionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved) {
      if (Math.abs(dx) < POSITION_DRAG_THRESHOLD && Math.abs(dy) < POSITION_DRAG_THRESHOLD) return;
      drag.moved = true;
      this.dom.classList.add("dragging-position");
      this.disableTextSelection();
      this.frame.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
    this.dom.style.left = `${clamp(drag.startLeft + dx, 0, drag.maxLeft)}px`;
    this.dom.style.top = `${Math.max(0, drag.startTop + dy)}px`;
  };

  private onFramePointerUp = (event: PointerEvent) => {
    const drag = this.positionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.positionDrag = null;
    if (!drag.moved) return;
    event.preventDefault();
    event.stopPropagation();
    this.suppressNextClick = true;
    this.dom.classList.remove("dragging-position");
    this.restoreTextSelection();
    this.frame.releasePointerCapture(event.pointerId);

    const x = Math.round(parseFloat(this.dom.style.left) || 0);
    const y = Math.round(parseFloat(this.dom.style.top) || 0);
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, x, y }));
    this.guardSelectionAfterDrag(pos);
  };

  /** The pointerup that ends a real drag is followed by a synthetic click on
   * `frame` (the same browser behavior `swallowMouseEvent` documents for the
   * resize/crop handles) - left unswallowed, it'd land inside `frame`, which
   * (unlike those handles) is ordinary editable-region content, so
   * ProseMirror would process it as a genuine click and could move the
   * selection right after the drag just committed it. */
  private onFrameClick = (event: MouseEvent) => {
    if (!this.suppressNextClick) return;
    this.suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // --- Crop (non-destructive: stores insets, never touches image bytes) --

  private onCropToggleRequested = () => {
    if (!this.dom.classList.contains("selected")) return;
    if (this.cropSession) this.commitCrop();
    else this.enterCropMode();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.cropSession) {
      event.preventDefault();
      this.cancelCrop();
    }
  };

  private onDocPointerDownDuringCrop = (event: PointerEvent) => {
    if (!this.cropSession) return;
    if (this.dom.contains(event.target as Node)) return;
    this.commitCrop();
  };

  private ensureCropHandles(): Map<Dir, HTMLElement> {
    if (this.cropHandles) return this.cropHandles;
    const map = new Map<Dir, HTMLElement>();
    for (const dir of DIRS) {
      const handle = document.createElement("span");
      handle.className = `image-crop-handle image-crop-handle-${dir}`;
      handle.contentEditable = "false";
      handle.style.cursor = DIR_CURSOR[dir];
      handle.addEventListener("pointerdown", (event) => this.onCropPointerDown(event, dir));
      handle.addEventListener("pointermove", this.onCropPointerMove);
      handle.addEventListener("pointerup", this.onCropPointerUp);
      handle.addEventListener("pointercancel", this.onCropPointerUp);
      handle.addEventListener("mousedown", swallowMouseEvent);
      handle.addEventListener("click", swallowMouseEvent);
      this.dom.appendChild(handle);
      map.set(dir, handle);
    }
    this.cropHandles = map;
    return map;
  }

  private ensureScrim() {
    if (this.scrim) return this.scrim;
    const make = (suffix: string) => {
      const el = document.createElement("span");
      el.className = `image-crop-scrim image-crop-scrim-${suffix}`;
      this.frame.appendChild(el);
      return el;
    };
    this.scrim = { top: make("top"), bottom: make("bottom"), left: make("left"), right: make("right") };
    return this.scrim;
  }

  private ensureCropOutline(): HTMLElement {
    if (this.cropOutline) return this.cropOutline;
    const el = document.createElement("span");
    el.className = "image-crop-outline";
    this.frame.appendChild(el);
    this.cropOutline = el;
    return el;
  }

  private enterCropMode() {
    if (this.cropSession) return;
    const rect = this.freezeFrame();
    const crop = cropOf(this.node);
    const visW = 1 - crop.cropLeft - crop.cropRight;
    const visH = 1 - crop.cropTop - crop.cropBottom;
    let fullWidth = rect.width / visW;
    let fullHeight = rect.height / visH;
    // The reconstructed full (pre-crop) extent can come out wider/taller than
    // what actually fits on screen - e.g. crop away half the image, then
    // resize the now-smaller visible portion back up near the column's max
    // width; `rect.width / visW` then reconstructs a "full" image bigger than
    // the column itself. Clamp it the same way a resize drag is clamped (see
    // `onResizePointerDown`), so crop mode can't render its frame/handles
    // past the edge of the note column the way it did unclamped.
    const container = this.dom.closest<HTMLElement>(".prose-note");
    const maxWidth = Math.max(MIN_SIZE, (container?.clientWidth ?? window.innerWidth) - CONTAINER_EDGE_MARGIN);
    const maxHeight = Math.max(MIN_SIZE, window.innerHeight - CONTAINER_EDGE_MARGIN);
    if (fullWidth > maxWidth || fullHeight > maxHeight) {
      const scale = Math.min(maxWidth / fullWidth, maxHeight / fullHeight);
      fullWidth *= scale;
      fullHeight *= scale;
    }
    this.cropSession = { fullWidth, fullHeight, crop };

    this.dom.classList.add("cropping");
    this.frame.classList.add("crop-preview");
    // Expand the frame back out to the image's full (uncropped) extent at
    // the current scale, so the previously-trimmed edges are visible again
    // (dimmed via the scrim) for the user to re-adjust.
    this.frame.style.width = `${this.cropSession.fullWidth}px`;
    this.frame.style.height = `${this.cropSession.fullHeight}px`;
    this.img.style.width = `${this.cropSession.fullWidth}px`;
    this.img.style.height = `${this.cropSession.fullHeight}px`;
    this.img.style.left = "0px";
    this.img.style.top = "0px";

    this.ensureScrim();
    this.ensureCropOutline();
    this.ensureCropHandles();
    this.renderCropOverlay();

    document.addEventListener("pointerdown", this.onDocPointerDownDuringCrop, true);
    this.dispatchCropChanged(true);
  }

  private renderCropOverlay() {
    if (!this.cropSession) return;
    const { crop } = this.cropSession;
    const scrim = this.ensureScrim();
    scrim.top.style.height = `${crop.cropTop * 100}%`;
    scrim.bottom.style.height = `${crop.cropBottom * 100}%`;
    scrim.left.style.top = `${crop.cropTop * 100}%`;
    scrim.left.style.bottom = `${crop.cropBottom * 100}%`;
    scrim.left.style.width = `${crop.cropLeft * 100}%`;
    scrim.right.style.top = `${crop.cropTop * 100}%`;
    scrim.right.style.bottom = `${crop.cropBottom * 100}%`;
    scrim.right.style.width = `${crop.cropRight * 100}%`;

    const outline = this.ensureCropOutline();
    outline.style.left = `${crop.cropLeft * 100}%`;
    outline.style.top = `${crop.cropTop * 100}%`;
    outline.style.right = `${crop.cropRight * 100}%`;
    outline.style.bottom = `${crop.cropBottom * 100}%`;

    const { fullWidth: fw, fullHeight: fh } = this.cropSession;
    const leftPx = crop.cropLeft * fw;
    const rightPx = (1 - crop.cropRight) * fw;
    const topPx = crop.cropTop * fh;
    const bottomPx = (1 - crop.cropBottom) * fh;
    const midX = (leftPx + rightPx) / 2;
    const midY = (topPx + bottomPx) / 2;
    const positions: Record<Dir, [number, number]> = {
      nw: [leftPx, topPx],
      n: [midX, topPx],
      ne: [rightPx, topPx],
      e: [rightPx, midY],
      se: [rightPx, bottomPx],
      s: [midX, bottomPx],
      sw: [leftPx, bottomPx],
      w: [leftPx, midY],
    };
    for (const [dir, handle] of this.ensureCropHandles()) {
      const [x, y] = positions[dir];
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
    }
  }

  private onCropPointerDown = (event: PointerEvent, dir: Dir) => {
    if (!this.cropSession) return;
    event.preventDefault();
    event.stopPropagation();
    this.cropDrag = { dir, startX: event.clientX, startY: event.clientY, startCrop: { ...this.cropSession.crop } };
    this.disableTextSelection();
    this.cropHandles!.get(dir)!.setPointerCapture(event.pointerId);
  };

  private onCropPointerMove = (event: PointerEvent) => {
    const drag = this.cropDrag;
    if (!drag || !this.cropSession) return;
    const { fullWidth, fullHeight } = this.cropSession;
    const dx = (event.clientX - drag.startX) / fullWidth;
    const dy = (event.clientY - drag.startY) / fullHeight;
    const next = { ...drag.startCrop };
    if (drag.dir.includes("w")) {
      next.cropLeft = clamp(drag.startCrop.cropLeft + dx, 0, 1 - drag.startCrop.cropRight - MIN_CROP_FRACTION);
    }
    if (drag.dir.includes("e")) {
      next.cropRight = clamp(drag.startCrop.cropRight - dx, 0, 1 - drag.startCrop.cropLeft - MIN_CROP_FRACTION);
    }
    if (drag.dir.includes("n")) {
      next.cropTop = clamp(drag.startCrop.cropTop + dy, 0, 1 - drag.startCrop.cropBottom - MIN_CROP_FRACTION);
    }
    if (drag.dir.includes("s")) {
      next.cropBottom = clamp(drag.startCrop.cropBottom - dy, 0, 1 - drag.startCrop.cropTop - MIN_CROP_FRACTION);
    }
    this.cropSession.crop = next;
    this.renderCropOverlay();
  };

  private onCropPointerUp = (event: PointerEvent) => {
    if (!this.cropDrag) return;
    event.preventDefault();
    this.cropDrag = null;
    this.restoreTextSelection();
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    // No transaction is dispatched here (a crop handle drag only updates the
    // in-progress `cropSession` - see `commitCrop` for when it's finally
    // written out), but the same stray-selectionchange risk applies, and
    // here it's worse than just losing a highlight: `deselectNode` treats
    // any deselection as "committed", which would silently end the crop
    // session after adjusting just one handle.
    const pos = this.getPos();
    if (pos !== undefined) this.guardSelectionAfterDrag(pos);
  };

  private exitCropMode() {
    if (!this.cropSession) return;
    this.cropSession = null;
    this.cropDrag = null;
    this.dom.classList.remove("cropping");
    this.frame.classList.remove("crop-preview");
    document.removeEventListener("pointerdown", this.onDocPointerDownDuringCrop, true);
    this.dispatchCropChanged(false);
  }

  private commitCrop() {
    const session = this.cropSession;
    if (!session) return;
    const { fullWidth, fullHeight, crop } = session;
    const width = Math.round(fullWidth * (1 - crop.cropLeft - crop.cropRight));
    const height = Math.round(fullHeight * (1 - crop.cropTop - crop.cropBottom));
    this.exitCropMode();
    this.layoutFrame(width, height, crop);
    this.scheduleAlignmentFix();
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width, height, ...crop }),
    );
  }

  private cancelCrop() {
    this.exitCropMode();
    this.applyLayout(this.node);
    this.scheduleAlignmentFix();
  }

  private dispatchCropChanged(cropping: boolean) {
    // Bubbles so Editor.tsx's toolbar (which has no direct reference to the
    // ProseMirror view's DOM node) can pick it up with a plain `document`
    // listener, mirroring its pressed state without any of this living in
    // node attrs.
    this.view.dom.dispatchEvent(new CustomEvent(IMAGE_CROP_CHANGED_EVENT, { detail: { cropping }, bubbles: true }));
  }

  // Keep the handles' pointer interactions from being reinterpreted by
  // ProseMirror (e.g. as a drag-to-reorder gesture on the node).
  stopEvent(event: Event): boolean {
    const target = event.target;
    for (const handle of this.resizeHandles.values()) if (handle === target) return true;
    if (this.cropHandles) for (const handle of this.cropHandles.values()) if (handle === target) return true;
    if (this.positionDrag?.moved && (target === this.frame || target === this.img)) return true;
    return false;
  }

  // The layout/drag code above mutates `frame`/`img` directly outside of
  // `update`; tell ProseMirror's DOM observer not to try to reconcile them.
  ignoreMutation(): boolean {
    return true;
  }
}

/** Same "config in, plugin out" factory shape as codeBlockGrips/voiceNoteGrips (setup.ts) - see
 * ImageAssetResolver's own comment for why the resolver is threaded in here rather than imported
 * directly. */
export function imageView(resolver: ImageAssetResolver) {
  return $view(imageSchema.node, () => {
    return ((node, view, getPos) => new ImageNodeView(node, view, getPos, resolver)) as NodeViewConstructor;
  });
}
