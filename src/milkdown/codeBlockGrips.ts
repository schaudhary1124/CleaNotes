import { Plugin } from "@milkdown/kit/prose/state";
import type { PluginView } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { CODE_BLOCK_DEFAULT_FONT_SIZE } from "./codeBlock";
import { isInlineOnlyChange } from "./docChangeScope";

/** Walks up from a position inside a code block's CodeMirror content to the
 * `code_block` node itself, the way tableGrips.ts's resolveRowInfo walks up
 * from a cell to its row. */
function resolveCodeBlockInfo(view: EditorView, blockDom: HTMLElement): { pos: number; node: Node } | null {
  let domPos: number;
  try {
    domPos = view.posAtDOM(blockDom, 0);
  } catch {
    return null;
  }
  const $pos = view.state.doc.resolve(domPos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "code_block") {
      const pos = depth === 0 ? 0 : $pos.before(depth);
      return { pos, node };
    }
  }
  return null;
}

/** Deletes the whole code block. The built-in CodeMirror node view only ever
 * lets Backspace merge a single-line block back into a paragraph (see
 * @milkdown/components' node-view.ts) - there's otherwise no way to remove a
 * code block, especially a multi-line one, since its `stopEvent()` swallows
 * every keyboard event before ProseMirror's own node-selection delete
 * shortcuts ever see it. If this is the document's only block, it's replaced
 * with an empty paragraph instead of deleted outright, since `doc` requires
 * at least one child. */
function deleteCodeBlock(view: EditorView, blockDom: HTMLElement) {
  const info = resolveCodeBlockInfo(view, blockDom);
  if (!info) return;
  const { pos, node } = info;
  const { state } = view;
  const tr =
    state.doc.childCount === 1
      ? state.tr.replaceWith(pos, pos + node.nodeSize, state.schema.nodes.paragraph!.createChecked({}))
      : state.tr.delete(pos, pos + node.nodeSize);
  view.dispatch(tr);
  view.focus();
}

/** Finds the CodeMirror instance backing a code block's DOM, so the search
 * and zoom controls below can drive it directly (`openSearchPanel`,
 * `requestMeasure`) - this plugin only sees the ProseMirror side otherwise,
 * since the CodeMirror editor is owned by @milkdown/components' node view. */
function findCodeMirrorView(blockDom: HTMLElement): CodeMirrorView | null {
  const content = blockDom.querySelector(".cm-content");
  if (!content) return null;
  return CodeMirrorView.findFromDOM(content as HTMLElement);
}

/** Zoom range (px) for the per-block `--cb-font-size` custom property (see
 * codeBlock.ts's theme). Clamped rather than open-ended so a stray flurry of
 * clicks can't shrink code to unreadable or blow it up past the block. */
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 28;
const FONT_STEP = 1;

function currentFontSize(block: HTMLElement): number {
  const raw = parseFloat(block.style.getPropertyValue("--cb-font-size"));
  return Number.isFinite(raw) ? raw : CODE_BLOCK_DEFAULT_FONT_SIZE;
}

function zoomBy(block: HTMLElement, delta: number) {
  const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, currentFontSize(block) + delta));
  block.style.setProperty("--cb-font-size", `${next}px`);
  // The font-size change comes from outside CodeMirror's own update cycle
  // (a plain CSS custom property write), so its cached line-height/width
  // measurements need an explicit nudge to recompute against the new size.
  findCodeMirrorView(block)?.requestMeasure();
}

/** Lucide glyphs, inlined - this file draws its buttons as raw DOM (see
 * CodeBlockGripsView below), not JSX, so there's no React tree to pull the
 * lucide-react components into the way Editor.tsx's toolbar does. Kept
 * visually identical (same paths/stroke) for consistency with the rest of
 * the app's iconography. */
const MAXIMIZE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/></svg>';
const MINIMIZE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/></svg>';
const SEARCH_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.34-4.34"/></svg>';
const ZOOM_IN_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
const ZOOM_OUT_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>';
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const CHEVRON_UP_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
const CHEVRON_DOWN_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const GRIP_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="1"/><circle cx="19" cy="9" r="1"/><circle cx="5" cy="9" r="1"/><circle cx="12" cy="15" r="1"/><circle cx="19" cy="15" r="1"/><circle cx="5" cy="15" r="1"/></svg>';

/** How long the copy button shows its "copied" checkmark before reverting. */
const COPIED_FEEDBACK_MS = 1200;
/** Match count is only informational (see SearchPopup) - capped so a huge
 * pasted file with a one-character query can't walk thousands of matches
 * on every keystroke. */
const MAX_COUNTED_MATCHES = 999;

/** Builds the query SearchPopup drives @codemirror/search with - always
 * plain-text and case-insensitive, matching the "simple find, not a power
 * -user regex tool" brief (see .code-block-search-popup in index.css). */
function buildSearchQuery(search: string, replace: string): SearchQuery {
  return new SearchQuery({ search, replace, caseSensitive: false, literal: true, regexp: false, wholeWord: false });
}

/** Total match count, plus this match's 1-based position among them (0 if
 * the current selection isn't sitting on a match) - the popup shows this as
 * "3 of 7" the way VS Code's find widget does, since a bare total leaves no
 * way to tell which of several identical-looking highlights (see
 * .cm-searchMatch-selected below) Previous/Next just landed on. */
function matchStats(cm: CodeMirrorView, query: SearchQuery): { total: number; current: number } {
  if (!query.valid) return { total: 0, current: 0 };
  const sel = cm.state.selection.main;
  const cursor = query.getCursor(cm.state);
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); total <= MAX_COUNTED_MATCHES && !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === sel.from && next.value.to === sel.to) current = total;
  }
  return { total, current };
}

/** A small draggable find/replace popup for one code block, backed by
 * @codemirror/search's query/highlight/command machinery (see codeBlock.ts's
 * `search({ createPanel })`) but with its own compact DOM instead of that
 * package's default panel - see .code-block-search-popup in index.css for
 * why. Owns its DOM element but not its placement in the document or its
 * lifecycle map - CodeBlockGripsView appends/positions/removes it, the same
 * split TableOverlay uses for its own floating pieces in tableGrips.ts. */
class SearchPopup {
  readonly dom: HTMLElement;
  private findInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private countLabel: HTMLElement;
  private dragHandle: HTMLElement;
  // Once the user drags this popup, it stops following the code block's
  // tools bar (see reposition) - a floating window that's been placed
  // somewhere on purpose shouldn't jump back the next time the block
  // resizes or the doc changes.
  private pinnedPos: { top: number; left: number } | null = null;
  private dragPointerId: number | null = null;
  private dragStart = { x: 0, y: 0, top: 0, left: 0 };

  constructor(
    private block: HTMLElement,
    onClose: () => void,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "code-block-search-popup";
    // Keeps clicks/drags inside the popup from landing on the code block
    // underneath (which would move the text cursor) or bubbling up into
    // ProseMirror's own mousedown handling.
    this.dom.addEventListener("mousedown", (e) => e.stopPropagation());

    this.dragHandle = document.createElement("div");
    this.dragHandle.className = "search-popup-handle";
    this.dragHandle.innerHTML = GRIP_ICON;
    this.dragHandle.addEventListener("pointerdown", this.onDragStart);
    this.dragHandle.addEventListener("pointermove", this.onDragMove);
    this.dragHandle.addEventListener("pointerup", this.onDragEnd);
    this.dragHandle.addEventListener("pointercancel", this.onDragEnd);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "search-popup-close";
    close.title = "Close";
    close.setAttribute("aria-label", "Close find and replace");
    close.textContent = "×";
    close.addEventListener("click", onClose);
    this.dragHandle.append(close);

    this.findInput = document.createElement("input");
    this.findInput.type = "text";
    this.findInput.placeholder = "Find";
    this.findInput.setAttribute("aria-label", "Find in code block");
    this.findInput.spellcheck = false;

    const prev = this.navButton(CHEVRON_UP_ICON, "Previous match", () => this.withCM(findPrevious));
    const next = this.navButton(CHEVRON_DOWN_ICON, "Next match", () => this.withCM(findNext));

    this.countLabel = document.createElement("span");
    this.countLabel.className = "search-popup-count";

    const findRow = document.createElement("div");
    findRow.className = "search-popup-row";
    findRow.append(this.findInput, prev, next, this.countLabel);

    this.replaceInput = document.createElement("input");
    this.replaceInput.type = "text";
    this.replaceInput.placeholder = "Replace";
    this.replaceInput.setAttribute("aria-label", "Replace with");
    this.replaceInput.spellcheck = false;

    const replaceBtn = this.textButton("Replace", () => this.withCM(replaceNext));
    const replaceAllBtn = this.textButton("All", () => this.withCM(replaceAll));

    const replaceRow = document.createElement("div");
    replaceRow.className = "search-popup-row";
    replaceRow.append(this.replaceInput, replaceBtn, replaceAllBtn);

    this.dom.append(this.dragHandle, findRow, replaceRow);

    this.findInput.addEventListener("input", () => this.commitQuery(true));
    this.replaceInput.addEventListener("input", () => this.commitQuery(false));
    this.findInput.addEventListener("keydown", (e) => this.onFindKeyDown(e, onClose));
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.withCM(replaceNext);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    });
  }

  private navButton(icon: string, label: string, onClick: () => void) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-popup-nav-btn";
    btn.innerHTML = icon;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", onClick);
    return btn;
  }

  private textButton(text: string, onClick: () => void) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-popup-text-btn";
    btn.textContent = text;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", onClick);
    return btn;
  }

  private onFindKeyDown(e: KeyboardEvent, onClose: () => void) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.withCM(e.shiftKey ? findPrevious : findNext);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  private withCM(command: (cm: CodeMirrorView) => unknown) {
    const cm = findCodeMirrorView(this.block);
    if (!cm) return;
    command(cm);
    this.syncAfterCommand(cm);
  }

  /** `selectFirstMatch` is true only when the *find* text just changed (not
   * the replace text) - @codemirror/search's `replaceNext` only replaces the
   * match the selection is already sitting on, and otherwise just silently
   * selects it without replacing anything (see its `isSelectionOfMatch`
   * check). Without this, the Replace button did nothing at all on a fresh
   * query, since typing a query alone never moved the selection onto a
   * match - the first click would only select it, requiring a confusing
   * second click to actually replace. Calling findNext here as soon as the
   * query changes (mirroring VS Code's own find-as-you-type) means a match
   * is already selected by the time the user reaches for Replace. Skipped
   * for replace-text edits so that editing what to replace with doesn't
   * itself jump the selection off whatever match Next/Previous just landed
   * on. */
  private commitQuery(selectFirstMatch: boolean) {
    const cm = findCodeMirrorView(this.block);
    if (!cm) return;
    cm.dispatch({ effects: setSearchQuery.of(buildSearchQuery(this.findInput.value, this.replaceInput.value)) });
    if (selectFirstMatch) findNext(cm);
    this.syncAfterCommand(cm);
  }

  /** Runs after any command that can move the selection to a (possibly new)
   * match - keeps the count label and scroll position in step with it. */
  private syncAfterCommand(cm: CodeMirrorView) {
    this.updateCount(cm);
    this.scrollCurrentMatchIntoView(cm);
  }

  private updateCount(cm: CodeMirrorView) {
    if (!this.findInput.value) {
      this.countLabel.textContent = "";
      return;
    }
    const { total, current } = matchStats(cm, getSearchQuery(cm.state));
    const suffix = total > MAX_COUNTED_MATCHES ? "+" : "";
    this.countLabel.textContent =
      total === 0
        ? "No results"
        : // `current` is 0 right after a replace empties the doc's last match, or
          // any other time the selection isn't sitting on one - falls back to the
          // plain total rather than claiming a position that doesn't exist.
          current === 0
          ? `${total}${suffix} match${total === 1 ? "" : "es"}`
          : `${current} of ${total}${suffix}`;
  }

  /** Centers the current match within the block's own `.cm-scroller` -
   * and *only* that scroller. Native `Element.scrollIntoView()` (and
   * @codemirror/search's own default `scrollToMatch`, disabled in
   * codeBlock.ts for this reason) walks every scrollable ancestor, which
   * here includes the note editor's own page - so jumping to a match would
   * also recenter the whole note under it, jerking the page around on every
   * Previous/Next click instead of just scrolling inside the block.
   * Setting `scrollTop`/`scrollLeft` directly, rather than calling any
   * scroll-into-view API, can't spill over into ancestors the way that
   * would. */
  private scrollCurrentMatchIntoView(cm: CodeMirrorView) {
    const match = cm.dom.querySelector<HTMLElement>(".cm-searchMatch-selected");
    if (!match) return;

    const scroller = cm.scrollDOM;
    const scrollerRect = scroller.getBoundingClientRect();
    const matchRect = match.getBoundingClientRect();

    scroller.scrollTop += matchRect.top + matchRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2);
    if (matchRect.left < scrollerRect.left) {
      scroller.scrollLeft -= scrollerRect.left - matchRect.left;
    } else if (matchRect.right > scrollerRect.right) {
      scroller.scrollLeft += matchRect.right - scrollerRect.right;
    }

    // This popup floats (`position: fixed`, see reposition) over the
    // block's own top edge rather than pushing its content down, so a match
    // centered close to that edge (a short block, or a match near the very
    // top/bottom of the doc) can end up hidden underneath it. Scroll back up
    // a bit more - revealing a little of the preceding lines - until it
    // clears the popup. Re-measured after the above, not combined with it,
    // since centering can itself be what puts the match under the popup.
    const popupRect = this.dom.getBoundingClientRect();
    const matchRectAfter = match.getBoundingClientRect();
    const coveredByPopup =
      matchRectAfter.top < popupRect.bottom &&
      matchRectAfter.bottom > popupRect.top &&
      matchRectAfter.left < popupRect.right &&
      matchRectAfter.right > popupRect.left;
    if (coveredByPopup) scroller.scrollTop -= popupRect.bottom - matchRectAfter.top + 8;
  }

  focus() {
    this.findInput.focus();
    this.findInput.select();
  }

  private onDragStart = (e: PointerEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest(".search-popup-close")) return;
    e.preventDefault();
    this.dragPointerId = e.pointerId;
    this.dragHandle.setPointerCapture(e.pointerId);
    this.dragStart = {
      x: e.clientX,
      y: e.clientY,
      top: parseFloat(this.dom.style.top) || 0,
      left: parseFloat(this.dom.style.left) || 0,
    };
  };

  private onDragMove = (e: PointerEvent) => {
    if (this.dragPointerId !== e.pointerId) return;
    const top = this.dragStart.top + (e.clientY - this.dragStart.y);
    const left = this.dragStart.left + (e.clientX - this.dragStart.x);
    this.pinnedPos = { top, left };
    this.dom.style.top = `${top}px`;
    this.dom.style.left = `${left}px`;
  };

  private onDragEnd = (e: PointerEvent) => {
    if (this.dragPointerId !== e.pointerId) return;
    this.dragHandle.releasePointerCapture(e.pointerId);
    this.dragPointerId = null;
  };

  /** Re-anchors just under `anchorRect` (the tools bar, in viewport
   * coordinates - same rect CodeBlockGripsView positions the toolbar
   * buttons against) unless the user has already dragged this popup
   * somewhere of their own choosing. */
  reposition(anchorRect: DOMRect) {
    if (this.pinnedPos) return;
    const fixed = toFixedRect(this.dom, anchorRect);
    const width = this.dom.offsetWidth || 260;
    this.dom.style.top = `${fixed.top + fixed.height + 6}px`;
    this.dom.style.left = `${fixed.left + fixed.width - width}px`;
  }

  destroy() {
    this.dom.remove();
  }
}

/** Gap (px) kept between the tools bar's right edge and whichever button
 * ends up outermost, matching the original delete-button-only spacing. */
const EDGE_GAP = 10;
/** Gap (px) between adjacent floating buttons. */
const BTN_GAP = 4;

const EXPANDED_CLASS = "cb-expanded";

/** Remembers which code block (by its doc position - stable as long as the note's content
 * hasn't changed, which holds across a plain tab switch) was expanded per note, keyed by
 * notePath - so switching tabs away and back restores it. Module-level (not per-view state)
 * because the whole Editor, and with it this plugin's view, is destroyed and recreated on every
 * tab switch (see App.tsx's Editor `key`); a view-local field would never survive that. */
const expandedBlockPositions = new Map<string, number>();

interface BlockButtons {
  del: HTMLButtonElement;
  expand: HTMLButtonElement;
  copy: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  search: HTMLButtonElement;
  /** Pending revert-to-copy-icon timer, if a "copied" checkmark is showing. */
  copyResetTimer: number | undefined;
}

/** Finds the nearest ancestor that becomes the CSS containing block for one
 * of `el`'s `position: fixed` descendants, instead of the viewport - i.e.
 * any ancestor with a `transform`, `perspective`, `filter`, or
 * `backdrop-filter` other than `none`, a `will-change` naming one of those,
 * or a `contain` of `paint`/`layout`/`strict`/`content`. Returns null if no
 * such ancestor exists, meaning the viewport is the containing block (the
 * common case). See expandedRectTarget's doc comment for why this matters
 * here specifically. */
function findFixedContainingBlock(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.transform !== "none" ||
      style.perspective !== "none" ||
      style.filter !== "none" ||
      style.backdropFilter !== "none" ||
      /transform|perspective|filter/.test(style.willChange) ||
      /paint|layout|strict|content/.test(style.contain)
    ) {
      return node;
    }
  }
  return null;
}

/** Converts a viewport-relative rect into the coordinate space `el` is
 * actually positioned in once it becomes `position: fixed` - relative to
 * `findFixedContainingBlock(el)` when that returns an ancestor, unchanged
 * (viewport-relative) otherwise. Used for both the expanded code block
 * itself and its floating buttons, which share the same ancestor chain (see
 * expandedRectTarget's doc comment) and so the same containing block once
 * either one is fixed. */
function toFixedRect(el: HTMLElement, rect: DOMRect): DOMRect {
  const containingBlock = findFixedContainingBlock(el);
  if (!containingBlock) return rect;

  const cbRect = containingBlock.getBoundingClientRect();
  const cbStyle = getComputedStyle(containingBlock);
  const cbBorderLeft = parseFloat(cbStyle.borderLeftWidth) || 0;
  const cbBorderTop = parseFloat(cbStyle.borderTopWidth) || 0;
  return new DOMRect(
    rect.left - cbRect.left - cbBorderLeft,
    rect.top - cbRect.top - cbBorderTop,
    rect.width,
    rect.height,
  );
}

/** Per-editor overlay: one set of floating tool buttons per code block -
 * remove, expand/collapse ("make this code block fill the note"), copy,
 * zoom out, zoom in, and find/replace - floated in place of the tools bar's
 * Copy button (hidden via CSS - see index.css). Lives in the Milkdown mount
 * div (a sibling of `editorView.dom`, not a child of it) rather than
 * actually replacing the Copy button in the DOM, because that button
 * belongs to the vendored `codeBlockComponent`'s own Vue tree, which would
 * just re-render over any node inserted into it directly - same reasoning
 * as TableOverlay in tableGrips.ts. */
class CodeBlockGripsView implements PluginView {
  private view: EditorView;
  private host: HTMLElement | null = null;
  private buttons = new Map<HTMLElement, BlockButtons>();
  // At most one search popup per block, but unlike expandedBlock, several
  // blocks can each have their own open at once - they don't conflict the
  // way two fullscreen blocks would.
  private searchPopups = new Map<HTMLElement, SearchPopup>();
  // At most one code block is expanded at a time - expanding a second one
  // collapses whichever was already expanded first (see setExpanded).
  private expandedBlock: HTMLElement | null = null;
  private resizeObserver = new ResizeObserver(() => this.repositionAll());
  // The tools bar this positions against doesn't exist yet at mount time -
  // CodeMirror (and the Vue-rendered `.tools` bar inside it) only
  // initializes once the block scrolls into view (see node-view.ts's
  // IntersectionObserver), asynchronously and after this view's first
  // repositionAll() call. A block's own outer size never changes when that
  // happens (its height is fixed by CSS), so ResizeObserver never fires for
  // it - this instead watches the block's subtree directly for that mount.
  private mutationObserver = new MutationObserver(() => {
    this.repositionAll();
    // The mutation this fires for (CodeMirror/the Vue-rendered `.tools` bar replacing the
    // placeholder - see this field's own comment above) can land before the browser has actually
    // finished layout for that newly-inserted content, most noticeably right after a fresh mount
    // (e.g. switching back to a tab whose note has a code block: the async IntersectionObserver
    // mount above and this note's own Editor mount land close together, and the immediate
    // repositionAll() call above can read stale metrics for exactly one frame in that race) -
    // a plain click was enough to "fix" it because *any* later transaction re-runs repositionAll
    // once layout has caught up. Doing that follow-up pass ourselves, once layout has actually
    // settled, means a click is never required: repositionAll is cheap and idempotent, so the
    // redundant call in the already-fine case costs nothing.
    requestAnimationFrame(() => this.repositionAll());
  });
  // Restoring expandedBlockPositions only makes sense once, right at mount - re-checking on
  // every later sync() (e.g. after a doc-changing edit) risks matching a since-deleted block's
  // old position against an unrelated new one that happens to land at the same offset.
  private hasAttemptedExpandRestore = false;

  constructor(
    view: EditorView,
    private notePath: string,
  ) {
    this.view = view;
    this.sync();
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("keydown", this.onKeyDown);
  }

  update(view: EditorView, prevState: EditorView["state"]) {
    this.view = view;
    // See voiceNoteGrips.ts's identical gate: `doc !== prevState.doc` is true on every
    // keystroke, but sync() re-queries the whole rendered DOM for code blocks -
    // isInlineOnlyChange skips that unless a code block could actually have been added/removed.
    if (view.state.doc !== prevState.doc && !isInlineOnlyChange(prevState.doc, view.state.doc)) {
      this.sync();
    } else {
      this.repositionAll();
    }
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    this.buttons.forEach((btns) => {
      if (btns.copyResetTimer !== undefined) window.clearTimeout(btns.copyResetTimer);
      btns.del.remove();
      btns.expand.remove();
      btns.copy.remove();
      btns.zoomIn.remove();
      btns.zoomOut.remove();
      btns.search.remove();
    });
    this.buttons.clear();
    this.searchPopups.forEach((popup) => popup.destroy());
    this.searchPopups.clear();
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("keydown", this.onKeyDown);
  }

  private onWindowResize = () => {
    if (this.expandedBlock) this.repositionAll();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !this.expandedBlock) return;
    e.preventDefault();
    this.setExpanded(this.expandedBlock, false);
  };

  private makeButton(className: string, icon: string, title: string, ariaLabel: string, onClick: () => void) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `code-block-tool-btn ${className}`;
    btn.innerHTML = icon;
    btn.title = title;
    btn.setAttribute("aria-label", ariaLabel);
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", onClick);
    return btn;
  }

  private copyCode(block: HTMLElement, btns: BlockButtons) {
    const cm = findCodeMirrorView(block);
    const text = cm ? cm.state.doc.toString() : (block.querySelector(".cm-content")?.textContent ?? "");
    navigator.clipboard.writeText(text).then(() => {
      if (btns.copyResetTimer !== undefined) window.clearTimeout(btns.copyResetTimer);
      btns.copy.innerHTML = CHECK_ICON;
      btns.copy.classList.add("copied");
      btns.copyResetTimer = window.setTimeout(() => {
        btns.copy.innerHTML = COPY_ICON;
        btns.copy.classList.remove("copied");
        btns.copyResetTimer = undefined;
      }, COPIED_FEEDBACK_MS);
    });
  }

  /** Opens or closes this block's find/replace popup (see SearchPopup).
   * Unlike setExpanded, opening one never closes another block's - see the
   * searchPopups field's own comment. */
  private toggleSearchPopup(block: HTMLElement) {
    if (this.searchPopups.has(block)) {
      this.closeSearchPopup(block);
      return;
    }
    const cm = findCodeMirrorView(block);
    if (!cm || !this.host) return;
    // Turns on @codemirror/search's match-highlight decorations and mounts
    // its (CSS-hidden, see index.css) placeholder panel - see codeBlock.ts's
    // `createPanel` for why an empty panel still has to exist here.
    openSearchPanel(cm);
    const popup = new SearchPopup(block, () => this.closeSearchPopup(block));
    this.host.append(popup.dom);
    this.searchPopups.set(block, popup);
    const toolsRect = (block.querySelector(".tools") ?? block).getBoundingClientRect();
    popup.reposition(toolsRect);
    popup.focus();
  }

  private closeSearchPopup(block: HTMLElement) {
    const popup = this.searchPopups.get(block);
    if (!popup) return;
    const cm = findCodeMirrorView(block);
    if (cm) closeSearchPanel(cm);
    popup.destroy();
    this.searchPopups.delete(block);
  }

  private sync() {
    const host = this.view.dom.parentElement;
    if (!host) return;
    if (host !== this.host) {
      this.host = host;
      if (!host.style.position) host.style.position = "relative";
    }

    const current = new Set(Array.from(this.view.dom.querySelectorAll(".milkdown-code-block")) as HTMLElement[]);
    for (const [block, btns] of this.buttons) {
      if (!current.has(block)) {
        if (this.expandedBlock === block) this.setExpanded(block, false);
        this.closeSearchPopup(block);
        if (btns.copyResetTimer !== undefined) window.clearTimeout(btns.copyResetTimer);
        btns.del.remove();
        btns.expand.remove();
        btns.copy.remove();
        btns.zoomIn.remove();
        btns.zoomOut.remove();
        btns.search.remove();
        this.resizeObserver.unobserve(block);
        this.buttons.delete(block);
      }
    }
    current.forEach((block) => {
      if (this.buttons.has(block)) return;

      const del = this.makeButton("code-block-delete-btn", "×", "Remove", "Remove code block", () =>
        deleteCodeBlock(this.view, block),
      );
      del.textContent = "×";

      const expand = this.makeButton(
        "code-block-expand-btn",
        MAXIMIZE_ICON,
        "Expand to fill the note",
        "Expand code block to fill the note",
        () => this.setExpanded(block, block !== this.expandedBlock),
      );

      const btns: BlockButtons = {
        del,
        expand,
        copy: this.makeButton("code-block-copy-btn", COPY_ICON, "Copy code", "Copy code block contents", () =>
          this.copyCode(block, btns),
        ),
        zoomIn: this.makeButton(
          "code-block-zoom-btn",
          ZOOM_IN_ICON,
          "Zoom in",
          "Increase code block font size",
          () => zoomBy(block, FONT_STEP),
        ),
        zoomOut: this.makeButton(
          "code-block-zoom-btn",
          ZOOM_OUT_ICON,
          "Zoom out",
          "Decrease code block font size",
          () => zoomBy(block, -FONT_STEP),
        ),
        search: this.makeButton(
          "code-block-search-btn",
          SEARCH_ICON,
          "Find and replace",
          "Find and replace in code block",
          () => this.toggleSearchPopup(block),
        ),
        copyResetTimer: undefined,
      };

      host.append(del, expand, btns.copy, btns.zoomIn, btns.zoomOut, btns.search);
      this.buttons.set(block, btns);
      this.resizeObserver.observe(block);
      this.mutationObserver.observe(block, { childList: true, subtree: true });
    });

    if (!this.hasAttemptedExpandRestore) {
      this.hasAttemptedExpandRestore = true;
      this.restoreExpandedBlock();
    }

    this.repositionAll();
  }

  /** Re-expands whichever block was expanded the last time this note was open (see
   * expandedBlockPositions), if any - matched by doc position since blocks have no other
   * stable identity across a fresh Milkdown mount. */
  private restoreExpandedBlock() {
    const savedPos = expandedBlockPositions.get(this.notePath);
    if (savedPos === undefined) return;
    for (const block of this.buttons.keys()) {
      const info = resolveCodeBlockInfo(this.view, block);
      if (info && info.pos === savedPos) {
        this.setExpanded(block, true);
        return;
      }
    }
  }

  /** Toggles a code block between its normal in-flow size and filling the
   * whole note editor pane (toolbar included - see Editor.tsx's
   * `data-note-editor-root`). Implemented as a CSS class plus custom
   * properties carrying that pane's live rect (see .cb-expanded in
   * index.css) rather than reparenting the block's DOM: this node's `dom`
   * is a ProseMirror NodeView, and moving it out from under `view.dom`
   * would leave ProseMirror's own view-desc tree out of sync with the real
   * DOM (see deleteCodeBlock's doc comment for the same NodeView-fragility
   * concern). `position: fixed` escapes the note's scroll/overflow
   * clipping without any of that risk. */
  private setExpanded(block: HTMLElement, expand: boolean) {
    if (expand && this.expandedBlock && this.expandedBlock !== block) {
      this.setExpanded(this.expandedBlock, false);
    }

    const btns = this.buttons.get(block);
    block.classList.toggle(EXPANDED_CLASS, expand);
    if (btns) {
      btns.expand.innerHTML = expand ? MINIMIZE_ICON : MAXIMIZE_ICON;
      btns.expand.title = expand ? "Collapse" : "Expand to fill the note";
      btns.expand.setAttribute("aria-label", expand ? "Collapse code block" : "Expand code block to fill the note");
    }

    if (expand) {
      this.expandedBlock = block;
      const info = resolveCodeBlockInfo(this.view, block);
      if (info) expandedBlockPositions.set(this.notePath, info.pos);
    } else {
      if (this.expandedBlock === block) {
        this.expandedBlock = null;
        expandedBlockPositions.delete(this.notePath);
      }
      block.style.removeProperty("--cb-rect-top");
      block.style.removeProperty("--cb-rect-left");
      block.style.removeProperty("--cb-rect-width");
      block.style.removeProperty("--cb-rect-height");
    }
    this.repositionAll();
  }

  /** The note editor's own root (toolbar + note area, not just the visible
   * viewport) - see Editor.tsx. Falls back to the whole page if a code
   * block somehow renders outside it.
   *
   * Expressed via toFixedRect in the coordinate space `block` will actually
   * be `position: fixed` against, which is *not* always the viewport:
   * App.tsx wraps the editor pane in a `<main>` with `.glass-panel`'s
   * `backdrop-filter`, and a `backdrop-filter` ancestor becomes the
   * containing block for fixed descendants instead of the viewport (same
   * rule as `transform`/`filter`/`perspective`/`contain`). That ancestor
   * (`<main>`) also has `overflow: hidden`, so getting this wrong doesn't
   * just misplace the expanded block - it gets clipped to a smaller,
   * offset box. */
  private expandedRectTarget(block: HTMLElement): DOMRect {
    const container = block.closest<HTMLElement>("[data-note-editor-root]") ?? document.body;
    return toFixedRect(block, container.getBoundingClientRect());
  }

  /** Reserves extra bottom margin on a code block so its *total* footprint (it varies with the
   * user's own native resize-drag, unlike hr's fixed 2px - see index.css's own comment on the
   * `margin-top: 0` rule this builds on) rounds up to the next `--rule` line, the same
   * "whole-multiples-of-rule" contract imageView.ts's applyAlignmentFix already keeps for images.
   * Mutates the block's own element only (never an ancestor) for the identical reason that one
   * documents: this is called from repositionAll, already proven safe to run from here (it
   * already sets other style/custom-property values directly on tracked blocks, e.g.
   * setExpanded's `--cb-rect-*`), so staying inside that same boundary avoids reopening that
   * class of bug rather than introducing a new one. */
  private applyGridAlignment(block: HTMLElement, isExpanded: boolean) {
    if (isExpanded) {
      // Fixed-position and out of flow while expanded (see .cb-expanded in index.css) - nothing
      // to stay aligned with until it collapses back into flow.
      if (block.style.marginBottom) block.style.marginBottom = "";
      return;
    }
    const proseNote = block.closest<HTMLElement>(".prose-note");
    if (!proseNote) return;
    const gridded = proseNote.classList.contains("note-look-paper") || proseNote.classList.contains("note-look-index-card");
    if (!gridded) {
      if (block.style.marginBottom) block.style.marginBottom = "";
      return;
    }
    const rule = parseFloat(getComputedStyle(proseNote).getPropertyValue("--rule"));
    if (!rule) return;
    // Clear any previous compensation first - both to fall back to the CSS base margin-bottom
    // (0.8em, read below) before adding to it, and so a shrink (the user dragging the block
    // shorter) doesn't keep stale extra padding from a taller previous size.
    block.style.marginBottom = "";
    const baseMarginBottom = parseFloat(getComputedStyle(block).marginBottom) || 0;
    // Unlike imageView.ts's applyAlignmentFix - which measures the image's *containing
    // paragraph*, whose own rendered height already includes the image's margin because an
    // inline-block child's margins contribute to its parent's line-box height - a code block is
    // a block-level sibling with no such wrapper, and getBoundingClientRect() never includes an
    // element's own margin regardless. baseMarginBottom has to be added in by hand here so the
    // remainder is computed against the block's *actual total* footprint, not just its border box.
    const remainder = (block.getBoundingClientRect().height + baseMarginBottom) % rule;
    if (remainder >= 0.5) block.style.marginBottom = `${baseMarginBottom + (rule - remainder)}px`;
  }

  private repositionAll() {
    if (!this.host) return;

    if (this.expandedBlock) {
      const rect = this.expandedRectTarget(this.expandedBlock);
      this.expandedBlock.style.setProperty("--cb-rect-top", `${rect.top}px`);
      this.expandedBlock.style.setProperty("--cb-rect-left", `${rect.left}px`);
      this.expandedBlock.style.setProperty("--cb-rect-width", `${rect.width}px`);
      this.expandedBlock.style.setProperty("--cb-rect-height", `${rect.height}px`);
    }

    const hostRect = this.host.getBoundingClientRect();
    this.buttons.forEach((btns, block) => {
      const isExpanded = block === this.expandedBlock;
      this.applyGridAlignment(block, isExpanded);
      // Anchor to the tools bar itself (not the block) so the buttons land
      // exactly in the Copy button's old slot regardless of the tools bar's
      // padding/height, which are set in CSS rather than known here.
      const toolsRect = (block.querySelector(".tools") ?? block).getBoundingClientRect();

      // The delete button is irrelevant mid-edit (and its usual
      // host-relative math would place it back at the block's old in-flow
      // slot while the block itself is fixed) - hidden whenever expanded.
      // Search/zoom/copy stay available while expanded, same as the
      // remaining expand button, which switches to "collapse".
      btns.del.style.display = isExpanded ? "none" : "";
      const visible = isExpanded
        ? [btns.expand, btns.copy, btns.zoomIn, btns.zoomOut, btns.search]
        : [btns.del, btns.expand, btns.copy, btns.zoomIn, btns.zoomOut, btns.search];

      // While expanded, the block itself is `position: fixed` (see
      // .cb-expanded in index.css), so `toolsRect` is already a viewport
      // rect - each visible button switches to `fixed` too, positioned
      // against whatever ancestor actually forms its containing block (see
      // toFixedRect's doc comment), which isn't necessarily the viewport.
      const fixedToolsRect = isExpanded ? toFixedRect(btns.expand, toolsRect) : null;

      let offset = EDGE_GAP;
      for (const btn of visible) {
        btn.style.position = isExpanded ? "fixed" : "absolute";
        btn.style.zIndex = isExpanded ? "31" : "";
        const rect = btn.getBoundingClientRect();
        if (fixedToolsRect) {
          btn.style.top = `${fixedToolsRect.top + (fixedToolsRect.height - rect.height) / 2}px`;
          btn.style.left = `${fixedToolsRect.left + fixedToolsRect.width - offset - rect.width}px`;
        } else {
          btn.style.top = `${toolsRect.top - hostRect.top + (toolsRect.height - rect.height) / 2}px`;
          btn.style.left = `${toolsRect.right - hostRect.left - offset - rect.width}px`;
        }
        offset += rect.width + BTN_GAP;
      }

      // toolsRect works as the popup's anchor whether or not the block is
      // expanded - reposition() itself is a no-op once the user has dragged
      // it (see SearchPopup.pinnedPos), same "anchor until placed" idea as
      // the expand button switching to `position: fixed` above.
      this.searchPopups.get(block)?.reposition(toolsRect);
    });
  }
}

export function codeBlockGrips(notePath: string) {
  return $prose(() => new Plugin({ view: (view) => new CodeBlockGripsView(view, notePath) }));
}
