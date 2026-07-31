import { Plugin } from "@milkdown/kit/prose/state";
import type { PluginView } from "@milkdown/kit/prose/state";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { readAttachment, writeAttachment } from "../utils/fsNotes";
import type { VoiceNoteAttrs } from "./voiceNoteSchemaExtensions";
import { VoiceRecording, appendWav, formatDuration } from "./voiceRecording";

// Lucide-style glyphs, inlined - this is a PluginView rendering raw DOM (see
// VoiceNoteGripsView below), not JSX, same reasoning as codeBlockGrips.ts's own inlined icons.
// Outline for the "add" affordance (an action - nothing exists yet), filled for the pill (state -
// a recording already exists here) - deliberately different *shapes*, not just colors, since the
// add button turns the same accent color on hover as an idle pill already is.
const MIC_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';
const MIC_ICON_FILLED =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1a1 1 0 0 0-2 0v1a9 9 0 0 0 8 8.94V22a1 1 0 0 0 2 0v-2.06A9 9 0 0 0 21 11v-1a1 1 0 0 0-2 0Z"/></svg>';
const STOP_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const CANCEL_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';

/** Fired (bubbling) whenever an occupied line's voice-note pill is clicked, so Editor.tsx - which
 * has no direct reference to any one plugin instance - can open its popover. Same NodeView/
 * PluginView -> React bridge notePinView.ts's NOTE_PIN_CLICKED_EVENT uses. */
export const VOICE_NOTE_CLICKED_EVENT = "plainotes:voice-note-clicked";

export interface VoiceNoteClickedDetail {
  id: string;
  voiceSrc: string;
  voiceDur: number;
  /** The pill's own DOM node, so the popover can anchor to it (via ToolbarPopover.tsx). */
  element: HTMLElement;
  /** Clears this line's voice-note attachment (attrs reset to null/0) - a live callback
   * (re-resolving the line's position fresh) rather than one captured at click time, mirroring
   * notePinView.ts's `remove`. Does not delete the underlying asset file - see this file's own
   * comment on orphaned assets in voiceNoteSchemaExtensions.ts. */
  remove: () => void;
  /** Starts a new recording targeted at this same line in "append" mode: on stop, the new
   * segment is decoded and concatenated onto the existing clip (see voiceRecording.ts's
   * appendWav) rather than replacing or playlist-ing it. Swaps this line's control over to the
   * same on-canvas recording widget a fresh recording uses. */
  startAppend: () => void;
}

type LineNodeType = "paragraph" | "heading" | "list_item" | "table_row" | "table_header_row";

function voiceOf(node: ProseNode): VoiceNoteAttrs {
  return {
    voiceId: (node.attrs.voiceId as string | null) ?? null,
    voiceSrc: (node.attrs.voiceSrc as string | null) ?? null,
    voiceDur: (node.attrs.voiceDur as number) || 0,
  };
}

interface ScannedLine {
  pos: number;
  node: ProseNode;
  type: LineNodeType;
}

/** Walks the doc for every paragraph/heading/list_item/table-row eligible to carry a voice note.
 * A paragraph that's the first (or only) child of a list_item is skipped - that line is already
 * representable by the list item itself, so showing two overlapping affordances on one visual
 * line would be confusing; a second paragraph inside a multi-paragraph list item stays
 * independently eligible. A table cell/header's own paragraph is skipped the same way: its whole
 * *row* is the eligible line instead (a cell can't carry its own sidecar - see
 * voiceNoteSchemaExtensions.ts's configureVoiceNoteSchemas for why - and a table's rows already
 * span its full width, so one control per row is also all the margin has room for without two
 * cells in the same row fighting over the same spot). */
function scanEligibleLines(doc: ProseNode): ScannedLine[] {
  const results: ScannedLine[] = [];
  doc.descendants((node, pos, parent, index) => {
    const type = node.type.name;
    if (type === "list_item") {
      results.push({ pos, node, type: "list_item" });
    } else if (type === "table_row") {
      results.push({ pos, node, type: "table_row" });
    } else if (type === "table_header_row") {
      results.push({ pos, node, type: "table_header_row" });
    } else if (type === "heading") {
      results.push({ pos, node, type: "heading" });
    } else if (type === "paragraph") {
      if (parent?.type.name === "list_item" && index === 0) return true;
      if (parent?.type.name === "table_cell" || parent?.type.name === "table_header") return true;
      results.push({ pos, node, type: "paragraph" });
    }
    return true;
  });
  return results;
}

/** Walks up from a line's own DOM element to the position/node of its enclosing
 * paragraph/heading/list_item, the way codeBlockGrips.ts's resolveCodeBlockInfo walks up from a
 * code block's DOM to the code_block node. Always re-resolved fresh (never a position cached
 * from an earlier scan) at the moment a transaction is about to be built, since the doc may have
 * changed underneath a pending recording or popover action. */
function resolveLineAt(view: EditorView, el: HTMLElement, type: LineNodeType): { pos: number; node: ProseNode } | null {
  let domPos: number;
  try {
    domPos = view.posAtDOM(el, 0);
  } catch {
    return null;
  }
  const $pos = view.state.doc.resolve(domPos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === type) {
      const pos = depth === 0 ? 0 : $pos.before(depth);
      return { pos, node };
    }
  }
  return null;
}

interface LineEntry {
  el: HTMLElement;
  type: LineNodeType;
  control: HTMLElement;
  voice: VoiceNoteAttrs;
  top: number;
  bottom: number;
}

interface RecordingState {
  entryEl: HTMLElement;
  type: LineNodeType;
  /** Non-null when this recording should be concatenated onto an existing clip on stop, rather
   * than replacing it - see voiceRecording.ts's appendWav. */
  appendVoiceId: string | null;
  session: VoiceRecording | null;
  timerEl: HTMLElement;
  intervalId: number;
}

/** Per-editor overlay: a small "add voice note" affordance that reveals on hovering an eligible
 * empty line, or a persistent play/duration pill for a line that already has one, floated in the
 * note's right margin (outside the editable text column) - same "floating DOM appended as a
 * sibling of view.dom, not a child of it" shape as CodeBlockGripsView/TableOverlay, and the same
 * reason: these controls aren't part of the document, just a positioned readout of it. */
class VoiceNoteGripsView implements PluginView {
  private view: EditorView;
  private notePath: string;
  // Gates only the idle-line "add voice note" affordance below (see renderEntry/onDomMouseMove) -
  // an existing recording's pill (and its click-to-open-popover/remove behavior) stays fully
  // functional either way, so disabling the Voice Notes feature never strands already-recorded
  // clips.
  private enabled: boolean;
  private host: HTMLElement | null = null;
  // The margin controls render outside view.dom's own box (in .prose-note's right padding
  // gutter - see repositionAll), so hover tracking can't be bound to view.dom itself: the
  // instant the pointer crosses from the text into the gutter to reach an add-affordance,
  // view.dom would fire `mouseleave` and hide it again before it could ever be clicked. `.prose-
  // note` is the ancestor that actually owns that padding, so its box contains both the text and
  // the gutter - bound here instead, found once and cached rather than re-queried per move.
  private hoverRoot: HTMLElement | null = null;
  private entries = new Map<HTMLElement, LineEntry>();
  private hovered: HTMLElement | null = null;
  private resizeObserver = new ResizeObserver(() => this.repositionAll());
  private recording: RecordingState | null = null;
  // A live window-resize drag can dispatch "resize" events faster than the display refreshes -
  // without this, every single one of those ran its own full repositionAll() pass over every
  // eligible line in the note, several times more often than the screen could even show the
  // result. Coalescing to one pass per animation frame (see onWindowResize) throws away nothing
  // visible, since only the last-known size before each paint ever mattered anyway.
  private resizeRaf: number | null = null;

  constructor(view: EditorView, notePath: string, enabled: boolean) {
    this.view = view;
    this.notePath = notePath;
    this.enabled = enabled;
    this.sync();
    window.addEventListener("resize", this.onWindowResize);
    this.hoverRoot = this.view.dom.closest<HTMLElement>(".prose-note") ?? this.view.dom;
    this.hoverRoot.addEventListener("mousemove", this.onDomMouseMove);
    this.hoverRoot.addEventListener("mouseleave", this.onDomMouseLeave);
  }

  update(view: EditorView, prevState: EditorView["state"]) {
    this.view = view;
    if (view.state.doc !== prevState.doc) this.sync();
    else this.repositionAll();
  }

  destroy() {
    this.cancelRecording();
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    if (this.resizeRaf !== null) cancelAnimationFrame(this.resizeRaf);
    this.hoverRoot?.removeEventListener("mousemove", this.onDomMouseMove);
    this.hoverRoot?.removeEventListener("mouseleave", this.onDomMouseLeave);
    this.entries.forEach((entry) => entry.control.remove());
    this.entries.clear();
  }

  private onWindowResize = () => {
    if (this.resizeRaf !== null) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = null;
      this.repositionAll();
    });
  };

  // ---- hover reveal (add-affordance only - the pill is always visible) ----
  private onDomMouseMove = (event: MouseEvent) => {
    if (this.recording) return;
    const y = event.clientY;
    let match: HTMLElement | null = null;
    for (const [el, entry] of this.entries) {
      if (entry.voice.voiceId || !this.enabled) continue;
      if (y >= entry.top && y <= entry.bottom) {
        match = el;
        break;
      }
    }
    this.setHovered(match);
  };

  private onDomMouseLeave = () => this.setHovered(null);

  private setHovered(el: HTMLElement | null) {
    if (this.hovered === el) return;
    if (this.hovered) this.entries.get(this.hovered)?.control.classList.remove("hovered");
    this.hovered = el;
    if (el) this.entries.get(el)?.control.classList.add("hovered");
  }

  // ---- scan / sync / positioning ----
  private sync() {
    const host = this.view.dom.parentElement;
    if (!host) return;
    if (host !== this.host) {
      this.host = host;
      if (!host.style.position) host.style.position = "relative";
    }

    const current = new Map<HTMLElement, { type: LineNodeType; node: ProseNode }>();
    for (const line of scanEligibleLines(this.view.state.doc)) {
      const dom = this.view.nodeDOM(line.pos);
      if (dom instanceof HTMLElement) current.set(dom, { type: line.type, node: line.node });
    }

    for (const [el, entry] of this.entries) {
      if (!current.has(el)) {
        if (this.recording?.entryEl === el) this.cancelRecording();
        entry.control.remove();
        this.resizeObserver.unobserve(el);
        this.entries.delete(el);
        if (this.hovered === el) this.hovered = null;
      }
    }

    current.forEach((info, el) => {
      let entry = this.entries.get(el);
      if (!entry) {
        entry = this.createEntry(el, info.type);
        this.entries.set(el, entry);
        this.resizeObserver.observe(el);
      } else {
        entry.type = info.type;
      }
      entry.voice = voiceOf(info.node);
      this.renderEntry(entry);
    });

    this.repositionAll();
  }

  private repositionAll() {
    if (!this.host) return;
    const hostRect = this.host.getBoundingClientRect();
    // Two passes, not one: reading a rect (getBoundingClientRect/getClientRects) right after
    // writing another entry's control.style.top/left forces the browser to synchronously
    // recompute layout before it can answer, since it can no longer trust its last-known
    // geometry. Interleaved like that, this loop cost one forced reflow per eligible line in the
    // *entire* note (scanEligibleLines walks the whole doc, not just what's scrolled into view) -
    // on every single window-resize tick during a live drag. `.voice-line-control` is
    // `position: absolute` (see index.css), so it never affects any entry's own layout - splitting
    // into a read pass then a write pass is safe and collapses all those reflows into effectively
    // one for the whole batch.
    const measurements: { entry: LineEntry; top: number; left: number }[] = [];
    this.entries.forEach((entry) => {
      const rect = entry.el.getBoundingClientRect();
      entry.top = rect.top;
      entry.bottom = rect.bottom;
      const lineRect = this.firstLineRect(entry.el);
      measurements.push({
        entry,
        top: lineRect.top - hostRect.top + (lineRect.height - 22) / 2,
        left: rect.right - hostRect.left + 6,
      });
    });
    measurements.forEach(({ entry, top, left }) => {
      entry.control.style.top = `${top}px`;
      entry.control.style.left = `${left}px`;
    });
  }

  /** A line's own element (paragraph/heading/list_item/table_row) is a single block box - its
   * getBoundingClientRect spans *every* wrapped visual line inside it, not just the first one. For
   * a line that has wrapped (or a table row tall from cell padding), centering the control against
   * that whole box lands it between the first and second visual line instead of next to the text
   * that's actually there. This finds the first line's own line-box rect (via a Range over its
   * first text node, whose getClientRects() yields one rect per wrapped fragment - [0] is the
   * first) so the control centers against real text, not the block's full wrapped height. Falls
   * back to the element's own rect for an empty line (no text node to range over). */
  private firstLineRect(el: HTMLElement): DOMRect {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (node?.textContent) {
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, node.textContent.length);
      const rects = range.getClientRects();
      if (rects.length > 0) return rects[0];
    }
    return el.getBoundingClientRect();
  }

  private createEntry(el: HTMLElement, type: LineNodeType): LineEntry {
    const control = document.createElement("div");
    control.className = "voice-line-control";
    control.addEventListener("mousedown", (event) => event.preventDefault());
    this.host!.append(control);
    return { el, type, control, voice: { voiceId: null, voiceSrc: null, voiceDur: 0 }, top: 0, bottom: 0 };
  }

  private renderEntry(entry: LineEntry) {
    if (this.recording?.entryEl === entry.el) return; // recording widget owns this control for now
    entry.control.innerHTML = "";
    if (entry.voice.voiceId) {
      entry.control.dataset.state = "pill";
      entry.control.classList.remove("hovered");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-line-pill";
      // Icon-only, not icon+duration-text: .prose-note's right padding gutter (px-12, ~48px -
      // see Editor.tsx) only has room for a glyph the same size as the add-affordance it
      // replaces. A label wide enough to show "0:11" pushed this past the gutter into territory
      // .prose-note's forced overflow-x clips (see .voice-line-recording's own comment on the
      // exact mechanism) - full duration is still one click away via the popover, and available
      // without clicking via this title tooltip.
      btn.title = `Voice note - ${formatDuration(entry.voice.voiceDur)}`;
      btn.innerHTML = MIC_ICON_FILLED;
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", () => this.onPillClick(entry));
      entry.control.append(btn);
    } else if (this.enabled) {
      entry.control.dataset.state = "add";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-line-add-btn";
      btn.title = "Add voice note";
      btn.setAttribute("aria-label", "Add voice note to this line");
      btn.innerHTML = MIC_ICON;
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", () => this.beginRecording(entry, null));
      entry.control.append(btn);
    }
  }

  private onPillClick(entry: LineEntry) {
    if (!entry.voice.voiceId || !entry.voice.voiceSrc) return;
    const detail: VoiceNoteClickedDetail = {
      id: entry.voice.voiceId,
      voiceSrc: entry.voice.voiceSrc,
      voiceDur: entry.voice.voiceDur,
      element: entry.control,
      remove: () => this.removeVoiceNote(entry.el, entry.type),
      startAppend: () => this.beginRecording(entry, entry.voice.voiceId),
    };
    this.view.dom.dispatchEvent(new CustomEvent(VOICE_NOTE_CLICKED_EVENT, { detail, bubbles: true }));
  }

  private removeVoiceNote(el: HTMLElement, type: LineNodeType) {
    const resolved = resolveLineAt(this.view, el, type);
    if (!resolved) return;
    const tr = this.view.state.tr.setNodeMarkup(resolved.pos, undefined, {
      ...resolved.node.attrs,
      voiceId: null,
      voiceSrc: null,
      voiceDur: 0,
    });
    this.view.dispatch(tr);
  }

  // ---- recording ----
  private beginRecording(entry: LineEntry, appendVoiceId: string | null) {
    if (this.recording) {
      if (this.recording.entryEl === entry.el) return;
      this.cancelRecording();
    }

    entry.control.innerHTML = "";
    entry.control.dataset.state = "recording";
    entry.control.classList.remove("hovered");

    const widget = document.createElement("div");
    widget.className = "voice-line-recording";
    const dot = document.createElement("span");
    dot.className = "voice-line-recording-dot";
    const timer = document.createElement("span");
    timer.className = "voice-line-recording-timer";
    timer.textContent = "0:00";
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.title = "Stop and save";
    stopBtn.setAttribute("aria-label", "Stop and save voice note");
    stopBtn.innerHTML = STOP_ICON;
    stopBtn.addEventListener("mousedown", (event) => event.preventDefault());
    stopBtn.addEventListener("click", () => void this.finishRecording());
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.title = "Cancel recording";
    cancelBtn.setAttribute("aria-label", "Cancel recording");
    cancelBtn.innerHTML = CANCEL_ICON;
    cancelBtn.addEventListener("mousedown", (event) => event.preventDefault());
    cancelBtn.addEventListener("click", () => this.cancelRecording());
    widget.append(dot, timer, stopBtn, cancelBtn);
    entry.control.append(widget);

    const intervalId = window.setInterval(() => {
      const session = this.recording?.session;
      if (session) timer.textContent = formatDuration(session.elapsedMs());
    }, 250);

    this.recording = { entryEl: entry.el, type: entry.type, appendVoiceId, session: null, timerEl: timer, intervalId };

    VoiceRecording.start()
      .then((session) => {
        if (!this.recording || this.recording.entryEl !== entry.el) {
          session.cancel();
          return;
        }
        this.recording.session = session;
      })
      .catch((err: unknown) => this.showRecordingError(entry, err));
  }

  private showRecordingError(entry: LineEntry, err: unknown) {
    if (this.recording?.entryEl === entry.el) {
      window.clearInterval(this.recording.intervalId);
      this.recording = null;
    }
    // Logged, not just shown inline: the pill only has room for a couple of words, but the
    // *name* of a DOMException (NotAllowedError/NotFoundError/NotReadableError/...) or a plain
    // Error's message (see VoiceRecording.start's isSecureContext check) usually says exactly
    // what went wrong.
    console.error("[voice note] couldn't start recording:", err);
    entry.control.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "voice-line-error";
    msg.title = err instanceof Error ? err.message : String(err);
    if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      msg.textContent = "Microphone access denied";
    } else if (err instanceof DOMException && err.name === "NotFoundError") {
      msg.textContent = "No microphone found";
    } else if (!window.isSecureContext) {
      msg.textContent = "Mic unavailable (insecure context)";
    } else {
      msg.textContent = "Couldn't start recording";
    }
    entry.control.append(msg);
    window.setTimeout(() => {
      if (this.entries.get(entry.el) === entry) this.renderEntry(entry);
    }, 2500);
  }

  private async finishRecording() {
    const rec = this.recording;
    if (!rec || !rec.session) return;
    this.recording = null;
    window.clearInterval(rec.intervalId);
    try {
      const { wav, durationMs } = await rec.session.stop();
      const resolved = resolveLineAt(this.view, rec.entryEl, rec.type);
      if (!resolved) return; // line was deleted while recording - drop the clip

      let voiceId = rec.appendVoiceId;
      let finalWav = wav;
      let finalDuration = durationMs;
      if (voiceId) {
        const currentVoice = voiceOf(resolved.node);
        if (currentVoice.voiceSrc) {
          const existing = await readAttachment(currentVoice.voiceSrc);
          const appended = await appendWav(existing, wav);
          finalWav = appended.wav;
          finalDuration = appended.durationMs;
        }
      } else {
        voiceId = crypto.randomUUID();
      }

      const relPath = await writeAttachment(this.notePath, "voice.wav", finalWav);
      const freshResolved = resolveLineAt(this.view, rec.entryEl, rec.type);
      if (!freshResolved) return;
      const tr = this.view.state.tr.setNodeMarkup(freshResolved.pos, undefined, {
        ...freshResolved.node.attrs,
        voiceId,
        voiceSrc: relPath,
        voiceDur: finalDuration,
      });
      this.view.dispatch(tr);
    } finally {
      // Cast, not a plain read: `this.recording` was narrowed to `null` by the assignment near
      // the top of this method, but that narrowing doesn't account for beginRecording having
      // possibly reassigned it (from a *different* call) during the `await`s above.
      const stillRecording = this.recording as RecordingState | null;
      const entry = this.entries.get(rec.entryEl);
      if (entry && stillRecording?.entryEl !== rec.entryEl) this.renderEntry(entry);
    }
  }

  private cancelRecording() {
    const rec = this.recording;
    if (!rec) return;
    this.recording = null;
    window.clearInterval(rec.intervalId);
    rec.session?.cancel();
    const entry = this.entries.get(rec.entryEl);
    if (entry) this.renderEntry(entry);
  }
}

export function voiceNoteGrips(notePath: string, enabled: boolean = true) {
  return $prose(() => new Plugin({ view: (view) => new VoiceNoteGripsView(view, notePath, enabled) }));
}
