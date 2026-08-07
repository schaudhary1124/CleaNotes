import { editorViewOptionsCtx } from "@milkdown/kit/core";
import type { EditorState } from "@milkdown/kit/prose/state";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { PluginView } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/**
 * Live pagination for Fixed-Size notes: measures real rendered block heights and reserves real
 * space between "pages" via a `[data-page-start-gap]` widget Decoration immediately before the
 * block that starts each new page (a real, `user-select: none` sibling `<div>`, not `margin-top`
 * on the block itself - see Pass 1's `appliedMargin` comment below for why the block's own margin
 * can't be used) - no document mutation, nothing synced over Yjs, nothing added to undo history. See the
 * implementation plan's Phase 1 §1.2 for why this technique (view-only, measured, per-viewer) was
 * chosen over inserting real page-break nodes into the document, and §1.3 for the algorithm.
 *
 * Decoration-based, not (as an earlier version of this file was) writing `dom.style.marginTop`
 * directly onto the rendered block from the PluginView: ProseMirror's DOM observer treats any
 * style/attribute mutation it didn't itself produce as a foreign change to the contentEditable
 * region, and discards it - rebuilding that node's DOM from the model - the moment *any* later
 * transaction touches the document, even one editing a completely different block. That made the
 * direct-write version look correct for a moment and then silently lose every margin as soon as
 * the user kept typing. Decorations don't have this problem: they're computed as part of the
 * document state itself (`props.decorations`), so whatever they produce *is* what ProseMirror
 * renders - never something to "correct". See noteLinkTrigger.ts for the same
 * state+apply+decorations shape already proven elsewhere in this codebase.
 *
 * Measurement is always taken at the page's true native size, regardless of the on-screen zoom
 * the user has picked (Editor.tsx's/BrowserEditor.tsx's `zoom` state, applied via `transform:
 * scale` on the ancestor with the `note-content-surface` class) - `recompute` below reads
 * `offsetTop`/`offsetHeight`, not `getBoundingClientRect()`, specifically because the former are
 * unaffected by `transform` on any ancestor (a *layout* value) while the latter isn't (a *paint*
 * value) - see its own comment at the read site for why that distinction is what lets every block
 * share one consistent, zoom-independent coordinate space with no extra work. Two earlier versions
 * took a harder road to the same goal, worth knowing about before reinventing either: first,
 * reading the zoomed/screen values via `getBoundingClientRect()` and dividing back out by the
 * current zoom factor - reasoned at the time to be safe since `transform` (unlike CSS `zoom`,
 * which this file's own git history shows was tried and rejected first) is a pure linear scale
 * with no re-shaping of text at different zoom levels, but reading *through* a live transform and
 * mathematically reversing it still left recompute dependent on exactly how precisely a given
 * engine's `getBoundingClientRect` composes with a live `transform` at read time, which turned out
 * to leave a small residual (an intentionally boundary-hugging test document occasionally broke a
 * page a line earlier or later depending on zoom, even after removing every other zoom-dependent
 * term). Second, keeping `getBoundingClientRect()` but temporarily neutralizing the transform
 * (`style.transform = "none"`) for the read and restoring it after - closer, but still paint-based
 * measurement riding on a synchronous style-mutate/read/restore dance around every single
 * recompute, purely to work around `getBoundingClientRect` being sensitive to something the actual
 * layout never needed to know about in the first place. `offsetTop`/`offsetHeight` were always the
 * more direct fix: layout values were never affected by `transform` to begin with, so there is
 * nothing to neutralize, restore, or divide back out - every recompute, at every zoom, already
 * reads the exact same geometry a `transform: none` element would have, without a dedicated
 * read path to get that guarantee.
 */

export interface PaginationMetrics {
  /** Height available for actual content on one page, i.e. page height minus top+bottom
   * margins - see utils/pageSizes.ts's pageDimensionsMm/mmToPx for how callers derive this. */
  usablePageHeightPx: number;
  marginTopPx: number;
  marginBottomPx: number;
  /** Opaque string included in the change-detection signature below purely to force a recompute -
   * not read for any numeric value itself, unlike the three fields above. Covers factors outside
   * page geometry that still change each block's *rendered* height and so need the exact same
   * "please remeasure" treatment: today that's just the active note look, since Paper/Index Card
   * force text onto a `line-height: var(--rule)` grid (index.css) that plain/Grid don't use, so
   * switching look changes every block's height purely via CSS with no ProseMirror transaction of
   * any kind involved - not a doc edit, not a selection change, not a page-dimension/margin change,
   * so nothing else here would ever notice. Without this, switching look after the fact leaves
   * every page's break sitting wherever the *previous* look's line-height put it, which reads as a
   * huge, look-dependent blank gap at the bottom of every page whose look was switched after its
   * content was last edited (only the look active at the last real edit ends up correctly fitted -
   * exactly the "index card looks right, the rest don't" symptom this field exists to fix). */
  layoutKey: string;
}

/** One page's rectangle, in the paginated content wrapper's own local coordinate space - see
 * components/PageBackdrop.tsx's identically-shaped `PageRect` (not imported directly: milkdown/
 * doesn't otherwise depend on components/, kept consistent here via structural typing instead). */
export interface ComputedPageRect {
  top: number;
  height: number;
}

/** Cosmetic-only spacing between two page rectangles - not part of PaginationMetrics/PageSetup
 * since it's a fixed constant of the visual design, not a user-configurable page dimension.
 * Exported so components/PageBackdrop.tsx can center its page-gap divider within this same gap
 * without a second, driftable copy of the constant. */
export const INTER_PAGE_GAP_PX = 32;

interface MeasuredBlock {
  pos: number;
  nodeSize: number;
  flowHeight: number;
  isManualBreak: boolean;
  dom: HTMLElement;
  /** This block's own rendered height with any previously-injected `data-inline-page-start`
   * split margins (see computeIntraBlockSplits below) subtracted back out - the intra-block
   * analogue of `appliedMargin` above, and for the same reason: without subtracting it, a
   * split block's measured height would include gaps *this plugin itself* injected last
   * recompute, inflating every subsequent recompute's height reading by that same gap again. */
  naturalOwnHeight: number;
  /** Only `paragraph`/`heading` - plain inline-content textblocks - are safe to split mid-block
   * (see computeIntraBlockSplits). Tables, lists, code blocks (CodeMirror-rendered, not plain
   * DOM text), images, etc. keep the old atomic/non-splittable behavior below. */
  isSplittableTextblock: boolean;
}

interface IntraBlockSplit {
  /** ProseMirror doc position where this line - and the ones after it, up to the next split (or
   * the block's end) - should be pushed down to the top of a fresh page. */
  pos: number;
  gapPx: number;
}

/** `computeIntraBlockSplits`' return value distinguishes two very different "there's nothing to
 * split" outcomes that a bare `null` used to conflate: `kind: "fits"` means the block's real
 * content, measured the exact same staleness-immune way as an actual split would be (see the
 * function's own top comment), already fits inside the capacity it was asked about - callers
 * should treat the block as fitting, not defer it. Plain `null` (see the function's return type)
 * still means "genuinely couldn't determine a line grid to work with at all" (too short a range,
 * no text, zero-height line box, etc.) - the only case where a caller falling back to some other
 * measure of the block's height is actually necessary. */
interface IntraBlockFitsResult {
  kind: "fits";
  /** This block's real, currently-rendered natural height, in px - `lineRects.length *
   * lineHeightPx` at the point this was decided, i.e. derived from the same text-node-only walk
   * `lineRects` itself comes from (see that computation's own comment for why that's immune to
   * whatever stale widgets might still be sitting in the DOM at this point) - not `naturalOwnHeight`
   * (offsetHeight minus summed current widget margins), which - measured a different way, from a
   * different signal - isn't guaranteed to agree with this even though both are nominally "the same
   * number," and did visibly disagree by a full line right after a compounding edit landed a second
   * split exactly at a page's own remaining-capacity boundary (see git history for the exact drift). */
  naturalHeightPx: number;
}

interface IntraBlockSplitsResult {
  kind: "splits";
  splits: IntraBlockSplit[];
  linesPerPageChunk: number;
  totalLines: number;
  lineHeightPx: number;
  lastLineIndex: number;
}

type IntraBlockSplitResult = IntraBlockSplitsResult | IntraBlockFitsResult;

/** For a single top-level textblock (paragraph/heading) whose own rendered height already
 * exceeds one page, finds the visual line boundaries that cross each page edge - the intra-block
 * analogue of the ordinary between-block `margin-top` push in `recompute` below, so a paragraph
 * too long for one page flows across pages the way a real word processor does (break at whichever
 * *line* crosses the boundary, mid-sentence if that's where it falls) instead of overflowing
 * straight through it. Line-wrap points (which characters land on which visual line) are exactly
 * as zoom-independent as this file's own top-of-file comment already establishes `offsetTop`/
 * `offsetHeight` to be - a `transform: scale()` zoom repaints pixels without touching layout, so
 * it can't move a character from one wrapped line to another - but *finding* those wrap points
 * has no non-paint API, so this reads `getClientRects()` (paint-space) purely for **ordinal**
 * comparisons within one single snapshot (line 4 comes after line 3), never converting a
 * paint-space pixel into the layout-space `usablePageHeightPx` world the way the file's own
 * history says was tried and abandoned for the *between*-block case - the actual gap size below
 * is computed from `lineHeightPx` (a computed-style value, exactly as zoom-independent as
 * `offsetHeight`), never from a raw client-rect delta.
 */
function computeIntraBlockSplits(
  view: EditorView,
  dom: HTMLElement,
  usablePageHeightPx: number,
  marginTopPx: number,
  marginBottomPx: number,
  // Capacity of the *first* chunk only, in px - defaults to a full page for a block that starts
  // exactly at a page top (the original caller, below), but a block that overflows mid-page (the
  // second call site, in `recompute`'s pass 2) passes however much room is actually left on the
  // page it's continuing, so it fills the remainder of the current page before rolling onto fresh
  // ones - every chunk after the first is always a full `usablePageHeightPx` either way.
  firstChunkHeightPx: number = usablePageHeightPx,
): IntraBlockSplitResult | null {
  if (!(usablePageHeightPx > 0) || !(firstChunkHeightPx > 0)) return null;
  const fontSizePx = parseFloat(getComputedStyle(dom).fontSize) || 16;
  // getComputedStyle always resolves "normal" to a used px value in every modern engine, but
  // fall back to the standard ~1.2x-of-font-size approximation rather than trust that blindly.
  const lineHeightPx = parseFloat(getComputedStyle(dom).lineHeight) || fontSizePx * 1.2;
  if (!(lineHeightPx > 0)) return null;

  // A previous version of this measurement took one `Range.getClientRects()` over the whole
  // block (`wholeRange.selectNodeContents(dom)`) - simpler, but a widget this same function
  // itself injected on an *earlier* recompute (still physically in the DOM at this point - Pass 3
  // hasn't dispatched this cycle's fresh decorations yet) sits inline between two text nodes, and
  // its own empty `display: block` box contributes a spurious extra "line" entry into that range's
  // rects, right in the middle of the real ones - every `lineRects[N]` after it then points one
  // line later than it should, silently shifting every split after the first stale widget crossed
  // by exactly one line-height, stacking again on every further stale widget crossed after that -
  // exactly the drift a report described as a page break landing progressively further from a
  // page's own ruled-line grid the deeper into a block it fell (invisible on Plain/Grid, which
  // have no ruled grid to visibly drift off of - only ever seen on Paper/Index Card). An earlier
  // attempt at a fix removed the block's own widgets from the live DOM before measuring and put
  // them back immediately after - reverted, since ProseMirror's view watches the DOM for foreign
  // mutations (that's how it supports things like browser spellcheck), and a remove-then-reinsert -
  // even net-zero, even fully synchronous - still produces real MutationRecords once that
  // observer's callback runs, which measurably destabilized *other*, already-correct pagination
  // decisions elsewhere in the same document. Walking text nodes individually (below) sidesteps
  // both problems at once: it never touches the DOM, and a widget - having no text content -
  // never contributes a rect in the first place, since only text nodes are ever asked for one.
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);
  const totalChars = textNodes.reduce((sum, t) => sum + t.data.length, 0);
  if (totalChars === 0) return null;

  const rawLineRects: DOMRect[] = [];
  for (const t of textNodes) {
    const r = document.createRange();
    r.selectNodeContents(t);
    rawLineRects.push(...Array.from(r.getClientRects()));
  }
  // Two adjacent text-node fragments that both land on the same wrapped line (this app's own text
  // is frequently assembled across several separate insertions - paste, undo/redo coalescing
  // boundaries, ordinary fast typing - see the widget-vs-inline-decoration comment further down
  // for the same fragmentation) each contribute their own rect above; merge any whose `top` is
  // within rounding distance of the previous one into a single line, so a single wrapped line
  // spanning a fragment boundary is still counted as exactly one line, not two.
  rawLineRects.sort((a, b) => a.top - b.top);
  const lineRects: DOMRect[] = [];
  for (const r of rawLineRects) {
    const previous = lineRects[lineRects.length - 1];
    if (previous && Math.abs(previous.top - r.top) < 0.5) continue;
    lineRects.push(r);
  }
  if (lineRects.length < 2) return null;

  // `linesPerPageChunk` (every chunk after the first, always a *full* page) is clamped to at
  // least 1 as a degenerate-page-size safety net - a full page is practically always taller than
  // one line, so this never actually engages, but forward progress genuinely must never be zero
  // there or the caller's while loop could stall. `firstChunkLines` (the first chunk only, whose
  // capacity is however much room happens to be left on a page already in progress) has no such
  // floor: unlike a full page, "less than one line's worth of room left" is an ordinary, common
  // case (see the second callsite below, always mid-page by construction) - and forcing it to 1
  // anyway doesn't make that missing 9px of room appear, it just tells the search to place a line
  // there that doesn't actually fit, which a later recompute pass then measures back out as not
  // having fit after all and answers differently, converging to a working layout only after
  // several passes' worth of visible flicker instead of getting it right on the first one.
  const linesPerPageChunk = Math.max(1, Math.floor(usablePageHeightPx / lineHeightPx));
  const firstChunkLines = Math.max(0, Math.floor(firstChunkHeightPx / lineHeightPx));
  // Nothing at all fits in the room that's left - not this function's problem to solve: the
  // caller's ordinary whole-block push (a single node-level margin, already well-exercised) is the
  // right tool for "defer entirely," not an inline widget landing at this block's own position 0,
  // which - being *inside* the block it's deferring, at the very position that block's own content
  // starts - has no natural block-level margin to collapse against the way the ordinary push does,
  // and measurably didn't land in the same place as an equivalent whole-block push would have.
  if (firstChunkLines === 0) return null;
  if (firstChunkLines >= lineRects.length) return { kind: "fits", naturalHeightPx: lineRects.length * lineHeightPx };

  // Only text nodes are walked - an inline atom (e.g. a noteLinkChip) inside an otherwise huge
  // paragraph has no character offset of its own, so a split that would ideally land exactly on
  // one is instead found via whichever nearby real text resolves the same target line; in the
  // rare case none does, findLineStart below returns null and that one split is simply skipped
  // (that segment overflows the way the whole block used to, not a regression).
  function locate(globalOffset: number): { node: Text; offset: number } | null {
    let remaining = globalOffset;
    for (let i = 0; i < textNodes.length; i++) {
      const t = textNodes[i];
      if (remaining < t.data.length) return { node: t, offset: remaining };
      if (remaining === t.data.length) {
        // Exactly at this fragment's own end - prefer the *next* fragment's start (offset 0)
        // over this one's end, when there is one. This exact boundary is where every existing
        // widget decoration sits (a widget splits what would render as one continuous text run
        // into two fragments, so a fragment always ends right where a widget begins) - resolving
        // to the end of the fragment *before* the widget, instead of the start of the one
        // *after* it, is what made rectTopAt's Range measurement (a couple lines below, via
        // this same `locate`) collapse to a zero-width point: `endOffset = min(offset+1,
        // node.data.length)` degenerates to `offset` itself right when `offset` already equals
        // `node.data.length`, and a collapsed Range's own rect sits on the *pre-push* side of
        // the boundary - measurably ~183px too early with a widget's real gap in front of it,
        // which read back as "one line short" for every split this block computed afterward
        // (see git history for the exact drift a report walked through). A fragment's own start
        // is never collapsed this way (it always has at least one real character after it to
        // measure, since only non-empty text nodes are ever walked into `textNodes` above).
        const next = textNodes[i + 1];
        if (next) return { node: next, offset: 0 };
        return { node: t, offset: t.data.length };
      }
      remaining -= t.data.length;
    }
    const last = textNodes[textNodes.length - 1];
    return last ? { node: last, offset: last.data.length } : null;
  }

  function rectTopAt(globalOffset: number): number | null {
    const loc = locate(globalOffset);
    if (!loc) return null;
    const r = document.createRange();
    const endOffset = Math.min(loc.offset + 1, loc.node.data.length);
    r.setStart(loc.node, loc.offset);
    r.setEnd(loc.node, endOffset > loc.offset ? endOffset : loc.offset);
    const rects = r.getClientRects();
    return rects.length ? rects[0].top : null;
  }

  // Binary search for the first character offset whose own rect lands on (or after) the target
  // line's top - i.e. the first character of that line, wherever within the text it falls.
  function findLineStart(targetTop: number): number | null {
    let lo = 0;
    let hi = totalChars;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const top = rectTopAt(mid);
      if (top === null) {
        hi = mid;
        continue;
      }
      if (top >= targetTop - 0.5) hi = mid;
      else lo = mid + 1;
    }
    return lo < totalChars ? lo : null;
  }

  // Under normal wrapping the browser only ever breaks a line at a word boundary, so
  // findLineStart's result *should* already be one - but the character exactly at that boundary
  // is usually the collapsed whitespace the previous word wrapped on, and different engines
  // report that collapsed character's own zero-width rect as belonging to either side of the
  // wrap inconsistently, which can throw the binary search off by the one or two characters that
  // used to show up as a word getting visibly cut in half at the injected page break. Walking
  // back to the nearest actual word start makes the result immune to exactly which side of that
  // ambiguous collapsed character the search happened to land on - the found word always ends up
  // whole on one side of the split or the other, never divided.
  const fullText = textNodes.map((t) => t.data).join("");
  function snapToWordStart(globalOffset: number): number {
    let i = globalOffset;
    while (i > 0 && !/\s/.test(fullText[i - 1])) i--;
    return i;
  }

  // Reverse lookup: which entry in `lineRects` a given Y position actually falls on. Needed
  // because `snapToWordStart` can walk a position back onto an *earlier* visual line than the one
  // `findLineStart` originally targeted (whenever the target line's first word turns out to start
  // partway into what looked like the right offset) - the line a split *actually* lands on, not
  // the line index the search merely aimed for, is what every downstream "how many lines are in
  // this chunk" calculation needs to stay accurate.
  function lineIndexForTop(top: number): number {
    let idx = 0;
    for (let i = 0; i < lineRects.length; i++) {
      if (lineRects[i].top <= top + 0.5) idx = i;
      else break;
    }
    return idx;
  }

  // Adaptive, not a fixed `for (lineIdx = chunk; lineIdx < total; lineIdx += chunk)` loop - an
  // earlier version was exactly that, and it had a real failure mode: if one target line's snap
  // collided with the previous split (see snapToWordStart's own comment - happens when the whole
  // target line is one unbroken "word"), it just `continue`d to the *next multiple* of
  // linesPerPageChunk, silently abandoning that boundary rather than placing it anywhere - which
  // left that chunk spanning two pages' worth of lines instead of one. The caller derives how much
  // of the block's own final page is used from `lastLineIndex` (the true line index of the last
  // split that actually landed, whatever it was) - assuming instead that every chunk was exactly
  // `linesPerPageChunk` lines, when a split had silently gone missing, made that seed height
  // *exceed* `usablePageHeightPx` outright (a chunk measured as taller than a page has room for),
  // corrupting every calculation fed by it downstream - this is the exact mechanism behind a
  // report of a page break landing far short of (or overshooting well past) where it should.
  // Retrying the very next line instead of jumping a whole `linesPerPageChunk` ahead means a
  // collision costs at most a few lines of slop on one chunk, never an entire dropped boundary.
  const splits: IntraBlockSplit[] = [];
  let previousGlobalOffset = 0;
  let lastLineIndex = 0;
  let targetLineIndex = firstChunkLines;
  while (targetLineIndex < lineRects.length) {
    const rawOffset = findLineStart(lineRects[targetLineIndex].top);
    if (rawOffset === null) break;
    const globalOffset = snapToWordStart(rawOffset);
    // A snap that lands at or before the previous split (possible only if one "word" - e.g. an
    // unbroken long URL - itself spans the whole target line) has nowhere valid to go for *this*
    // line - try the next one instead of abandoning the boundary outright.
    if (globalOffset <= previousGlobalOffset) {
      targetLineIndex += 1;
      continue;
    }
    const loc = locate(globalOffset);
    if (!loc) break;
    const pmPos = view.posAtDOM(loc.node, loc.offset);
    // The line this split *actually* landed on, not the target the search aimed for - snapToWordStart
    // (see its own comment) can walk the split back onto an earlier line than `targetLineIndex`
    // whenever the target line's first word starts mid-target-line, so this needs computing before
    // `remaining` below can use it, not just for `targetLineIndex`'s own next iteration.
    const actualTop = rectTopAt(globalOffset);
    const actualLineIndex = actualTop === null ? targetLineIndex : lineIndexForTop(actualTop);
    // Same shape as the between-block gap at the overflow branch below: remaining room on the
    // page being left (approximated from the line grid, not a raw paint measurement - see this
    // function's own comment), plus both pages' margins and the cosmetic inter-page gap.
    // The first split closes out whatever capacity/line-count this block actually opened with (a
    // full page, or less if it started mid-page) - every split after that always closes a full
    // page, same as before this function took a distinct first-chunk size at all. Sized from
    // `actualLineIndex - lastLineIndex` (how many lines this chunk *really* holds), not the
    // planned `firstChunkLines`/`linesPerPageChunk` - a chunk that landed one line short of its
    // target (the snapToWordStart case above) really does have one more line's worth of room
    // unused at its bottom than the plan assumed, and crediting the plan's count instead of the
    // real one undershoots this chunk's own gap by exactly that missing line - which, since every
    // later split's position is measured from this one, doesn't stay a one-chunk rounding error:
    // it silently shifts *every* later page in this same block one rule-line too high, stacking
    // by that same amount again on every chunk after it that also fell short. This is what made a
    // paragraph spanning several pages drift further out of alignment with each page's own ruled
    // background the deeper into it a page break fell - invisible on Plain/Grid (no ruled grid to
    // drift off of) and only ever visible on Paper/Index Card, exactly as reported.
    const linesInThisChunk = actualLineIndex - lastLineIndex;
    const chunkCapacityPx = splits.length === 0 ? firstChunkHeightPx : usablePageHeightPx;
    const remaining = Math.max(0, chunkCapacityPx - linesInThisChunk * lineHeightPx);
    const gapPx = Math.round(remaining + marginBottomPx + INTER_PAGE_GAP_PX + marginTopPx);
    splits.push({ pos: pmPos, gapPx });
    previousGlobalOffset = globalOffset;
    lastLineIndex = actualLineIndex;
    targetLineIndex = lastLineIndex + linesPerPageChunk;
  }
  if (splits.length === 0) return null;
  return { kind: "splits", splits, linesPerPageChunk, totalLines: lineRects.length, lineHeightPx, lastLineIndex };
}

interface PaginationPluginState {
  decorations: DecorationSet;
}

const paginationKey = new PluginKey<PaginationPluginState>("paginationLayout");

class PaginationLayoutView implements PluginView {
  private view: EditorView;
  private metricsRef: { current: PaginationMetrics };
  private onLayoutChanged: (pages: ComputedPageRect[]) => void;
  private tailPaddingApplied = false;
  private rafId: number | null = null;
  private lastSignature = "";
  private lastMetricsSignature = "";

  constructor(view: EditorView, metricsRef: { current: PaginationMetrics }, onLayoutChanged: (pages: ComputedPageRect[]) => void) {
    this.view = view;
    this.metricsRef = metricsRef;
    this.onLayoutChanged = onLayoutChanged;
    this.lastMetricsSignature = this.metricsSignature();
    this.schedule();
  }

  // Selection changes (arrow keys, clicks) are deliberately *not* a trigger here - pagination is
  // purely a function of document content and page geometry (usablePageHeightPx/margins/layoutKey
  // in PaginationMetrics), nothing about where the cursor happens to be. An earlier version also
  // reserved extra room on whichever block held the cursor, specifically so typing right up to a
  // page boundary wouldn't visually jump the moment a wrapped line crossed it - but that reserved
  // room only existed while editing was in progress (`pendingDocEdit`/`isEditTriggered`, since
  // removed) and got released the moment the cursor moved on, which meant every page break near
  // that reservation visibly shifted twice per edit: once when typing granted it, again when
  // navigating away released it. Confirmed live as a real, reproducible "type = one line count,
  // click elsewhere = a different one" flicker - worse than the jump it was meant to prevent.
  // Removing the reservation entirely removes both: pagination now only ever recomputes for (and
  // only ever changes because of) an actual content or page-geometry change.
  update(view: EditorView, prevState?: EditorView["state"]) {
    this.view = view;
    const metricsSignature = this.metricsSignature();
    const metricsChanged = metricsSignature !== this.lastMetricsSignature;
    this.lastMetricsSignature = metricsSignature;
    const docChanged = prevState ? !view.state.doc.eq(prevState.doc) : true;
    if (!docChanged && !metricsChanged) return;
    this.schedule();
  }

  destroy() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.tailPaddingApplied) {
      this.view.dom.style.paddingBottom = "";
      this.tailPaddingApplied = false;
    }
  }

  private schedule() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.recompute();
    });
  }

  private metricsSignature() {
    const { usablePageHeightPx, marginTopPx, marginBottomPx, layoutKey } = this.metricsRef.current;
    return `${usablePageHeightPx}|${marginTopPx}|${marginBottomPx}|${layoutKey}`;
  }

  private recompute() {
    const { usablePageHeightPx, marginTopPx, marginBottomPx } = this.metricsRef.current;
    const fullPageHeight = usablePageHeightPx + marginTopPx + marginBottomPx;

    // Pass 1: measure every top-level block (read-only) - batched separately from the writes in
    // pass 3 so reading a later block's rect is never forced to flush a reflow from a write we
    // just made to an earlier one. Same "read pass, then write pass" reasoning as
    // voiceNoteGrips.ts's repositionAll.
    const measured = [] as {
      pos: number;
      nodeSize: number;
      dom: HTMLElement;
      top: number;
      height: number;
      naturalOwnHeight: number;
      appliedMargin: number;
      isManualBreak: boolean;
      isSplittableTextblock: boolean;
    }[];
    this.view.state.doc.forEach((node, offset) => {
      const dom = this.view.nodeDOM(offset);
      if (dom instanceof HTMLElement) {
        // Read straight off the live DOM, not the decoration spec this plugin itself wrote (an
        // earlier version did that, reasoning it "can't" be stale since this plugin is the only
        // writer) - changed on a hypothesis worth recording even though it isn't independently
        // confirmed: reported symptom was every single edit - typing, bold, italic, highlight,
        // anything that dispatches a transaction - alternating a page's break point back and forth,
        // which content-driven causes (real height changes, the removed overflowReserve heuristic)
        // can't explain, since those depend on *what* changed, not merely *that* something did.
        // `Decoration.node` isn't guaranteed to survive `DecorationSet.map` through every
        // transaction unscathed - ProseMirror can drop or misalign a node decoration when the
        // mapping can't confidently prove the node at that position is still the *same* node, in
        // principle even for edits that never touch that node's own boundaries. If the spec lookup
        // ever desyncs from what's actually painted, even for one recompute, that single wrong
        // appliedMargin read inflates flowHeight by the *entire* previous margin, large enough to
        // flip a page's break point - and since this recompute's own dispatch immediately
        // re-establishes a (correctly value-matching) decoration afterward, the discrepancy would
        // vanish just as fast as it appeared, only to recur on the next edit. Reading the DOM
        // directly removes the possibility outright: there's no separate bookkeeping to desync from
        // reality, `getComputedStyle` always reports whatever margin is actually painted right now.
        // The gap itself lives on a `[data-page-start-gap]` widget div immediately before this
        // block, not on the block's own `margin-top` (an earlier version used the latter) - a
        // block-owned margin is still part of that block's own selectable box, and Chromium/WebKit
        // paint `::selection` clear across an entirely-selected block's margin, which read as a
        // huge highlighted band standing in for every page gap the moment a selection (or Cmd/
        // Ctrl+A) spanned a page break. A widget sibling can carry `user-select: none` - which a
        // fraction of one element's own margin never could - so it's excluded from the selection
        // paint outright, the same trick `.page-break`'s own `user-select: none` (index.css) already
        // relies on for the manual page-break node. Reading the sibling's own `offsetHeight` (not
        // `getComputedStyle().marginTop`, now that there's no margin to read) needs no
        // `data-page-start`-on-`dom` guard the way the margin version did: a plain paragraph never
        // has a `[data-page-start-gap]` element as its immediately-preceding sibling unless this
        // plugin put one there, so there's nothing else to misread as pagination-injected space.
        // `data-page-start` itself stays on the block (see Pass 3 below) purely as the print
        // `break-before: page` target.
        const gapSibling = dom.previousElementSibling;
        const appliedMargin =
          gapSibling instanceof HTMLElement && gapSibling.hasAttribute("data-page-start-gap")
            ? gapSibling.offsetHeight
            : 0;
        // Subtract back out any `data-inline-page-start` gaps this plugin injected into *this*
        // block's own content last recompute - see MeasuredBlock.naturalOwnHeight's own comment.
        let inlineGapsPx = 0;
        dom.querySelectorAll<HTMLElement>("[data-inline-page-start]").forEach((el) => {
          inlineGapsPx += parseFloat(getComputedStyle(el).marginTop) || 0;
        });
        measured.push({
          pos: offset,
          nodeSize: node.nodeSize,
          dom,
          // `offsetTop`/`offsetHeight`, not `getBoundingClientRect()`: the former are *layout*
          // values (relative to `offsetParent`), the latter a *paint*-time one - `transform:
          // scale(zoom)` on `.note-content-surface` (Editor.tsx's/BrowserEditor.tsx's `zoom`
          // state) changes what a rect reads without changing layout at all, which is exactly why
          // an earlier version of this file had to neutralize that transform before every single
          // `getBoundingClientRect()` read and restore it after - a dance this sidesteps
          // entirely, since offset* was already immune to it. All measured blocks share the same
          // `offsetParent` (direct siblings under `view.dom`), so the *deltas* pass 2 actually
          // uses (next.top - block.top, i.e. flowHeight) stay correct regardless of which
          // ancestor that offsetParent happens to be.
          top: dom.offsetTop,
          height: dom.offsetHeight,
          naturalOwnHeight: dom.offsetHeight - inlineGapsPx,
          appliedMargin,
          isManualBreak: node.type.name === "pageBreak",
          isSplittableTextblock: node.type.name === "paragraph" || node.type.name === "heading",
        });
      }
    });
    const blocks: MeasuredBlock[] = measured.map((block, i) => {
      const next = measured[i + 1];
      // Subtract the *next* block's own previously-injected marginTop (`appliedMargin`) - that's
      // the part of `next.top` that isn't natural content flow - and *this* block's own
      // currently-rendered inline-split gaps (`block.height - block.naturalOwnHeight`, the same
      // `inlineGapsPx` naturalOwnHeight itself already subtracts out). Both quantities are last
      // cycle's decision, still physically painted in the DOM at the moment Pass 1 reads it (this
      // recompute's own Pass 3 hasn't dispatched fresh decisions yet) - measuring `next.top -
      // block.top` raw, uncorrected for either, silently re-admits whatever gap this block or its
      // successor used to need back into "the distance between them", which reads as "doesn't fit"
      // for content that, freshly measured on its own, obviously does. This is what let a
      // paragraph split land right at an old gap's own anchor and strand the rest of the page
      // blank even after the block-starts-a-fresh-page case below already got this same fix -
      // fixing it once here, for every block, closes the whole class instead of the one shape of
      // it that happened to get noticed. Do not touch `block.top` itself: wherever this block
      // currently sits (including any push it received to start its own page) is still the
      // correct reference point for measuring the gap to whatever follows it.
      const ownInflationPx = block.height - block.naturalOwnHeight;
      const flowHeight =
        next
          ? Math.max(0, next.top - next.appliedMargin - block.top - ownInflationPx)
          : block.naturalOwnHeight + (parseFloat(getComputedStyle(block.dom).marginBottom) || 0);
      return {
        pos: block.pos,
        nodeSize: block.nodeSize,
        flowHeight,
        isManualBreak: block.isManualBreak,
        dom: block.dom,
        naturalOwnHeight: block.naturalOwnHeight,
        isSplittableTextblock: block.isSplittableTextblock,
      };
    });

    // Pass 2: pure arithmetic over the measured heights - no DOM access, so this part alone is
    // cheap to re-run and easy to reason about independent of layout timing.
    const pages: ComputedPageRect[] = [{ top: 0, height: fullPageHeight }];
    const marginAssignments = new Map<number, { nodeSize: number; gapPx: number }>();
    const inlineSplitAssignments: { pos: number; gapPx: number }[] = [];
    let usedHeight = 0;
    let pageTop = 0;
    // Set right after processing the manual page_break node itself (which renders wherever it
    // naturally falls on its own page) so the block immediately following it always starts a
    // fresh page, regardless of remaining space - see the plan's §1.3 step 3.
    let forceBreakNext = false;
    let pendingUnrenderedGapsPx = 0;
    for (const block of blocks) {
      // usedHeight is already whole-px (see below); round this block's own contribution into the
      // comparison too, for the same reason.
      const overflow = usedHeight > 0 && (forceBreakNext || Math.round(usedHeight + block.flowHeight) > usablePageHeightPx);

      // A splittable textblock that doesn't fit in whatever's left of the current page (and isn't
      // right after a manual break, which always wants a fully fresh page regardless): rather than
      // deferring the *whole* block to a new page - wasting all the room still left on this one -
      // let it fill that remaining room and roll the rest onto as many further pages as it needs,
      // the same line-boundary treatment the `usedHeight === 0` branch below already gives a block
      // that happens to start exactly at a page top. Without this, splitting a long paragraph in
      // two (e.g. pressing Enter partway through one that already spanned several pages) stranded
      // every line after the cursor on a fresh page even though most of the current page was still
      // blank - the second half was only ever measured as "doesn't fit, so push the entire thing
      // forward," never as "starts mid-page but is still splittable."
      if (overflow && !forceBreakNext && block.isSplittableTextblock) {
        const remainingFirstPagePx = Math.max(0, usablePageHeightPx - usedHeight);
        const splitResult = computeIntraBlockSplits(
          this.view,
          block.dom,
          usablePageHeightPx,
          marginTopPx,
          marginBottomPx,
          remainingFirstPagePx,
        );
        if (splitResult?.kind === "splits") {
          for (const split of splitResult.splits) {
            inlineSplitAssignments.push({ pos: split.pos, gapPx: split.gapPx });
            pageTop += fullPageHeight + INTER_PAGE_GAP_PX;
            pages.push({ top: pageTop, height: fullPageHeight });
          }
          const linesOnLastChunk = splitResult.totalLines - splitResult.lastLineIndex;
          const ownMarginBottomPx = parseFloat(getComputedStyle(block.dom).marginBottom) || 0;
          usedHeight = Math.round(Math.max(0, linesOnLastChunk) * splitResult.lineHeightPx + ownMarginBottomPx);
          if (block.isManualBreak) forceBreakNext = true;
          continue;
        }
        // `kind: "fits"` means the block's real content, measured the same staleness-immune way an
        // actual split would be, already fits in the room that's left - not a genuine overflow at
        // all (see IntraBlockFitsResult's own comment for why this is trusted over
        // `block.naturalOwnHeight`, which measures the same thing a different way and isn't
        // guaranteed to agree with it - confirmed disagreeing by a full line right after a
        // compounding edit landed a second split exactly at a page's own remaining-capacity
        // boundary). Bare `null` is the only case that really means "couldn't find a usable line
        // grid at all" and needs the whole-block push below.
        if (splitResult?.kind === "fits") {
          const ownMarginBottomPx = parseFloat(getComputedStyle(block.dom).marginBottom) || 0;
          usedHeight = Math.round(usedHeight + splitResult.naturalHeightPx + ownMarginBottomPx);
          if (block.isManualBreak) forceBreakNext = true;
          continue;
        }
        // Genuinely doesn't fit and can't be split - fall through to the ordinary whole-block push
        // below, exactly as if this branch didn't exist.
      }

      if (overflow) {
        // Remaining space on the page being left, plus its bottom margin, the cosmetic gap, and
        // the new page's own top margin - pushes this block down to exactly the new page's
        // first content line.
        const remaining = Math.max(0, usablePageHeightPx - usedHeight);
        marginAssignments.set(block.pos, {
          nodeSize: block.nodeSize,
          gapPx: Math.round(remaining + marginBottomPx + INTER_PAGE_GAP_PX + marginTopPx + pendingUnrenderedGapsPx),
        });
        pageTop += fullPageHeight + INTER_PAGE_GAP_PX;
        pages.push({ top: pageTop, height: fullPageHeight });
        usedHeight = 0;
        forceBreakNext = false;
        pendingUnrenderedGapsPx = 0;
      }

      // usedHeight === 0 here means this block starts a fresh page (either just pushed to one
      // above, or it's simply the first block on the page it's already on) - the only case where
      // a block's own height, not just its combined flowHeight with neighbors, can matter on its
      // own. If a block *doesn't* start fresh and didn't trigger the overflow push above, its
      // whole flowHeight (which is always >= its own content height) already fit in whatever
      // room was left, so naturalOwnHeight can't exceed a page there either.
      if (usedHeight === 0 && block.isSplittableTextblock && block.naturalOwnHeight > usablePageHeightPx) {
        const splitResult = computeIntraBlockSplits(this.view, block.dom, usablePageHeightPx, marginTopPx, marginBottomPx);
        // This branch's own gate above (`naturalOwnHeight > usablePageHeightPx`) can be stale the
        // same way the overflow branch's fallback used to be (see IntraBlockFitsResult's own
        // comment) - if the block's real content turns out to already fit once measured the
        // staleness-immune way, trust that over the gate that let this branch run in the first
        // place, rather than force a split search that has nothing to find.
        if (splitResult?.kind === "fits") {
          const ownMarginBottomPx = parseFloat(getComputedStyle(block.dom).marginBottom) || 0;
          usedHeight = Math.round(splitResult.naturalHeightPx + ownMarginBottomPx);
          if (block.isManualBreak) forceBreakNext = true;
          continue;
        }
        if (splitResult?.kind === "splits") {
          for (const split of splitResult.splits) {
            inlineSplitAssignments.push({ pos: split.pos, gapPx: split.gapPx });
            pageTop += fullPageHeight + INTER_PAGE_GAP_PX;
            pages.push({ top: pageTop, height: fullPageHeight });
          }
          // Height left over on the block's own final internal page, so whatever follows this
          // block picks up from the right spot - same role `usedHeight` always plays, just
          // seeded from the line grid instead of a flowHeight accumulation for this one block.
          // Deliberately *not* `block.flowHeight - block.naturalOwnHeight` here: flowHeight is
          // measured all the way to the next sibling's rendered top, which - now that this block
          // actually has real gaps rendered inside it - already has every one of those internal
          // gaps baked into it, not just the one trailing gap to the next sibling. Subtracting
          // naturalOwnHeight back out doesn't isolate that trailing gap, it leaves the *sum of
          // every internal gap* still mixed in, wildly inflating the seed and making everything
          // after this block think the page is far more full than it visually is. Read this
          // block's own trailing margin directly instead, the same simplification the last-block
          // case above already makes (own height + own marginBottom, ignoring the next block's
          // marginTop collapsing into it).
          // `totalLines - lastLineIndex`, not `totalLines - splits.length * linesPerPageChunk` -
          // the latter assumes every chunk landed at an exact multiple of linesPerPageChunk, which
          // no longer holds once a collision has shifted a split a few lines off that grid (see
          // computeIntraBlockSplits's own comment) - `lastLineIndex` is the *true* line index of
          // whichever split actually landed last, so this always reflects the real remainder.
          const linesOnLastChunk = splitResult.totalLines - splitResult.lastLineIndex;
          const ownMarginBottomPx = parseFloat(getComputedStyle(block.dom).marginBottom) || 0;
          usedHeight = Math.round(Math.max(0, linesOnLastChunk) * splitResult.lineHeightPx + ownMarginBottomPx);
          if (block.isManualBreak) forceBreakNext = true;
          continue;
        }
      }

      // Quantized to a whole px on every accumulation - defensive hygiene, not compensating for
      // zoom anymore (measurement is zoom-independent by construction now, see this file's
      // top-of-file comment): a document whose content happens to land within a fraction of a px
      // of `usablePageHeightPx` is a coin flip for the `>` comparison below regardless, and this
      // keeps that flip stable and reproducible run to run instead of riding on float precision.
      usedHeight = Math.round(usedHeight + block.flowHeight);
      if (usedHeight > usablePageHeightPx) {
        // Non-splittable atomic content (tables, lists, images, code blocks - anything that isn't
        // a plain paragraph/heading, see isSplittableTextblock) taller than one page: an accepted
        // limitation, since there's no line grid to inject a visual gap into partway through an
        // atomic node. Still track the consumed pages so later page guides and trailing space
        // stay accurate, the same as before this file could split anything.
        const pagesSpannedWithinBlock = Math.floor(usedHeight / usablePageHeightPx);
        if (pagesSpannedWithinBlock > 0) {
          for (let i = 0; i < pagesSpannedWithinBlock; i++) {
            pageTop += fullPageHeight + INTER_PAGE_GAP_PX;
            pages.push({ top: pageTop, height: fullPageHeight });
          }
          usedHeight -= pagesSpannedWithinBlock * usablePageHeightPx;
          pendingUnrenderedGapsPx += pagesSpannedWithinBlock * (marginBottomPx + INTER_PAGE_GAP_PX + marginTopPx);
        }
      }
      if (block.isManualBreak) forceBreakNext = true;
    }

    const remainingOnLastPage = usedHeight > 0 ? Math.max(0, usablePageHeightPx - usedHeight) : 0;
    const tailPaddingPx = Math.round(remainingOnLastPage + marginBottomPx + pendingUnrenderedGapsPx);
    // Unlike per-block margins, this is safe to keep writing directly: `view.dom` is the root
    // contentEditable element ProseMirror never rebuilds or replaces for the life of the view (only
    // its *children* go through the reconciliation that makes direct mutation unsafe above), so a
    // plain style write here persists exactly the same way codeBlockGrips.ts's zoom var does.
    this.view.dom.style.paddingBottom = `${tailPaddingPx}px`;
    this.tailPaddingApplied = true;

    // Pass 3: turn marginAssignments into decorations and dispatch them. Each assignment becomes
    // two decorations at the same position: a `Decoration.node` that just tags the block itself
    // with `data-page-start` - doesn't do anything on its own, it's a marker Editor.tsx's
    // handlePrint reads at print time to inject a matching `break-before: page`, so the printed
    // output's page breaks land at exactly the same blocks the live on-screen layout chose - and a
    // `Decoration.widget` immediately before it that actually reserves the gap's height, as a real
    // sibling `<div>` rather than the block's own `margin-top` (see Pass 1's `appliedMargin` for
    // why: a margin the block itself owns can't be excluded from that block's own selection paint,
    // where a separate `user-select: none` sibling can). No spec data on either decoration beyond
    // that: Pass 1 above reads the gap straight back off the DOM (the widget's own `offsetHeight`)
    // rather than out of this decoration's own spec - see its own comment for why - so there's
    // nothing else here that needs to round-trip through it.
    //
    // Unconditional dispatch, not gated on "did the target change since last time" (an earlier
    // version compared a signature of marginAssignments/inlineSplitAssignments to what it last
    // computed, and skipped dispatching when they matched) - that comparison only ever asked "is
    // my *target* different from my own last target", never "does the *live* document still have
    // what I last dispatched". Those can diverge: every transaction between one recompute and the
    // next - even one editing a completely different block - runs the existing decorations
    // through `tr.mapping` (see this plugin's `apply` below), and `Decoration.node` isn't
    // guaranteed to survive that unscathed (ProseMirror can lose track of "is this still the same
    // node" as content shifts around it, particularly for an edit landing right at the decorated
    // node's own boundary - pressing Enter right after a just-pushed block, inserting a new
    // sibling right there, is exactly that case). If the live decoration silently drops or
    // misplaces its margin in the meantime, and the next recompute's target happens to come out
    // identical to what it computed before (routine: adding content *after* an already-placed
    // block doesn't change that block's own placement at all), the old signature check saw
    // "unchanged" and skipped re-asserting it - so the corruption just stuck, read back as
    // `appliedMargin` every cycle after, until something else forced a different target. That's
    // the exact "a line that already moved to the next page snaps back" bug this replaces: dispatching
    // every recompute regardless costs one extra decorations-only transaction on cycles where
    // nothing actually changed, but ProseMirror's own view update already no-ops the DOM for
    // decorations whose value didn't change, and recomputes are already throttled to one per
    // animation frame - a cost worth paying for never trusting stale, silently-remapped state.
    const decorations = [
      ...Array.from(marginAssignments.entries()).flatMap(([pos, { nodeSize, gapPx }]) => [
        // `margin-top: 0` cancels this block's own natural CSS top margin (e.g. `.prose-note p`'s
        // `margin: 0.15em 0`) - the widget below is the *only* source of the reserved gap now, so
        // without this override the block would sit that natural margin's worth of extra px below
        // where `gapPx` (and therefore `appliedMargin`/`pages` in Pass 1/2) assumes it lands, the
        // same few-px-per-page-start drift this file's own history says compounds into visibly
        // wrong page breaks over a long enough document.
        Decoration.node(pos, pos + nodeSize, { style: "margin-top: 0", "data-page-start": "true" }),
        // `side: -1` so this renders immediately before the block at `pos`, the same boundary-
        // widget placement `data-inline-page-start` below already uses. `user-select: none` (see
        // index.css) is the entire reason this is a separate sibling instead of the block's own
        // margin - Pass 1's `appliedMargin` comment has the full story.
        Decoration.widget(
          pos,
          () => {
            const el = document.createElement("div");
            el.setAttribute("data-page-start-gap", "true");
            el.style.height = `${gapPx}px`;
            return el;
          },
          { side: -1 },
        ),
      ]),
      // The intra-block analogue of the decoration above. Deliberately a *widget*, not a
      // `Decoration.inline(from, to, {style: 'margin-top'})` wrapping the rest of the block's
      // text (an earlier version did exactly that, and it corrupted the whole page layout): a
      // widget always renders as exactly the one DOM node given here, where an inline decoration
      // renders once per underlying DOM text-node fragment its range happens to cross -
      // completely invisible normally since adjacent text is usually one fragment, but this app's
      // own text is frequently assembled across several separate insertions (paste, undo/redo
      // coalescing boundaries, ordinary fast typing) that don't always end up as one fragment.
      // When they don't, an inline decoration's `margin-top` gets applied *again* for every extra
      // fragment - each recompute's own dispatch could add yet another fragment boundary at a
      // slightly different split point than last time, so the extra margin (and therefore the
      // measured height feeding the next recompute) grew without bound, a bug report described as
      // a page "still overflowing" as it went right on ballooning. A widget has no fragment to
      // multiply: it's one node, inserted once, always contributing its margin exactly once no
      // matter how the surrounding text happens to be chunked.
      ...inlineSplitAssignments.map(({ pos, gapPx }) =>
        Decoration.widget(
          pos,
          () => {
            const el = document.createElement("span");
            el.setAttribute("data-inline-page-start", "true");
            el.style.display = "block";
            el.style.marginTop = `${gapPx}px`;
            return el;
          },
          { side: -1 },
        ),
      ),
    ];
    this.view.dispatch(
      this.view.state.tr.setMeta(paginationKey, { decorations: DecorationSet.create(this.view.state.doc, decorations) }),
    );

    const signature = pages.map((p) => `${p.top}:${p.height}`).join(",");
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.onLayoutChanged(pages);
    }
  }
}

/** The nearest scrollable ancestor of the editor's own DOM root - `.prose-note`/`.milkdown-scroll`
 * in this app today, found generically (by CSS `overflow-y` + actually having overflow) rather
 * than by a hardcoded class name, so this keeps working if that wrapper is ever renamed. */
function findScrollContainer(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** How close the caret is allowed to sit to the scroll container's own edge before this counts
 * it as "not visible" - matches ProseMirror's own default `scrollMargin` order of magnitude
 * (a handful of px), just enough that the caret doesn't render flush against the viewport edge. */
const CURSOR_SCROLL_MARGIN_PX = 24;

/** Scrolls the *minimum* amount needed to bring the caret back inside the scroll container's
 * viewport - does nothing at all if it's already there. See `paginationLayout`'s own comment for
 * why this exists instead of just letting ProseMirror's built-in scroll-into-view run. */
function scrollCursorIntoViewIfNeeded(view: EditorView) {
  const container = findScrollContainer(view.dom);
  if (!container) return;
  let coords: { top: number; bottom: number };
  try {
    coords = view.coordsAtPos(view.state.selection.head);
  } catch {
    // Stale/out-of-range position (e.g. the view's doc moved on since this was scheduled) -
    // nothing sensible to scroll to.
    return;
  }
  const containerRect = container.getBoundingClientRect();
  if (coords.top < containerRect.top + CURSOR_SCROLL_MARGIN_PX) {
    container.scrollTop -= containerRect.top + CURSOR_SCROLL_MARGIN_PX - coords.top;
  } else if (coords.bottom > containerRect.bottom - CURSOR_SCROLL_MARGIN_PX) {
    container.scrollTop += coords.bottom - (containerRect.bottom - CURSOR_SCROLL_MARGIN_PX);
  }
}

/** Registers the pagination measurement engine - only meaningful (and only worth its
 * measurement cost) for Fixed-Size notes, so callers should only `.use()` this when the note's
 * kind is "fixed-size" (see Editor.tsx). `metricsRef` is a live-updated ref (the "ref bridge"
 * pattern already used for noteLinkResultsRef in this same file's caller) rather than a value
 * baked in at construction, since PageSetup can change at runtime (the page-setup dropdown)
 * without remounting the whole editor.
 *
 * Also takes over scroll-into-view entirely for this note (`editorViewOptionsCtx`'s
 * `handleScrollToSelection`), rather than leaving it to ProseMirror's own default. That default
 * is itself already "just enough to keep the caret visible," not an unconditional recenter - but
 * it runs synchronously, inside the very same transaction that (for Enter, arrow-key movement,
 * etc.) requested it, which for a paginated note is *before* this same recompute has had its own
 * chance to run - a plain "push this block to the next page" margin change, or a `.zoom-stage`
 * resize from `onLayoutChanged` a render later, can each shift where the caret ends up on screen
 * moments after ProseMirror already decided (correctly, for the geometry that existed a frame
 * ago) whether or how far to scroll. The visible symptom is a scroll jump that has nothing to do
 * with whether the caret needed to move into view - exactly what a report described as "the whole
 * screen moves" on every Enter. Returning `true` here tells ProseMirror not to run its own pass at
 * all; the actual check is deferred two animation frames out (`requestAnimationFrame` nested
 * inside another) specifically to land after both this file's own rAF-scheduled `recompute` *and*
 * the `onLayoutChanged` → React state → `.zoom-stage` resize it triggers a render later - so it
 * only ever scrolls the minimum amount needed against the page geometry the user will actually
 * see, and does nothing at all if the caret was never going to leave the viewport in the first
 * place. */
export function paginationLayout(metricsRef: { current: PaginationMetrics }, onLayoutChanged: (pages: ComputedPageRect[]) => void) {
  return $prose(
    (ctx) => {
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        handleScrollToSelection: (view) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!view.isDestroyed) scrollCursorIntoViewIfNeeded(view);
            });
          });
          return true;
        },
      }));
      return new Plugin<PaginationPluginState>({
        key: paginationKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty }),
          apply(tr, prev: PaginationPluginState, _oldState: EditorState, _newState: EditorState) {
            const meta = tr.getMeta(paginationKey) as PaginationPluginState | undefined;
            if (meta) return meta;
            if (!tr.docChanged) return prev;
            // Map existing decorations forward through the edit so they stay visually correct
            // (and don't flash away) until the next async recompute produces the real answer.
            return { decorations: prev.decorations.map(tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations(state) {
            return paginationKey.getState(state)?.decorations ?? null;
          },
        },
        view: (view) => new PaginationLayoutView(view, metricsRef, onLayoutChanged),
      });
    },
  );
}
