import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $view } from "@milkdown/kit/utils";
import { readAttachment, writeAttachment } from "../utils/fsNotes";
import { voiceNoteInlineSchema } from "./voiceNoteInline";
import { appendWav, formatDuration } from "./voiceRecording";

// Lucide-style glyphs, inlined - same set voiceNoteGrips.ts uses for its (legacy, per-line)
// margin controls, ported verbatim since the visual language should stay identical.
const MIC_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';
const MIC_ICON_FILLED =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1a1 1 0 0 0-2 0v1a9 9 0 0 0 8 8.94V22a1 1 0 0 0 2 0v-2.06A9 9 0 0 0 21 11v-1a1 1 0 0 0-2 0Z"/></svg>';

/** Fired (bubbling) whenever a voice-note glyph is clicked - either this file's inline atom pill,
 * or voiceNoteGrips.ts's legacy per-line pill, which imports this same event/detail so both old
 * and new voice notes open the identical VoiceNotePopover in Editor.tsx. Same NodeView -> React
 * bridge notePinView.ts's NOTE_PIN_CLICKED_EVENT uses. */
export const VOICE_NOTE_CLICKED_EVENT = "plainotes:voice-note-clicked";

export interface VoiceNoteClickedDetail {
  id: string;
  voiceSrc: string;
  voiceDur: number;
  /** The pill's own DOM node, so the popover can anchor to it (via ToolbarPopover.tsx). */
  element: HTMLElement;
  /** Removes this voice note. A live callback (re-resolving position fresh via getPos()) rather
   * than one captured at click time, mirroring notePinView.ts's `remove`. */
  remove: () => void;
  /** Starts a new recording targeted at this same atom in "append" mode: on stop, the new segment
   * is concatenated onto the existing clip (see voiceRecording.ts's appendWav) rather than
   * replacing it. */
  startAppend: () => void;
}

/** Fired (bubbling) when an atom wants a recording session opened for it. The microphone itself is
 * never touched here: VoiceRecorderPopover.tsx (mounted by Editor.tsx in response to this event)
 * owns the countdown, the live VoiceRecording, and the pause/restart/delete controls, and hands
 * the finished bytes back through `complete` below. Keeping the NodeView out of that means the
 * recording UI can be real React (a positioned panel with state) instead of hand-built DOM inside
 * an inline atom the width of one glyph. */
export const VOICE_NOTE_RECORD_EVENT = "plainotes:voice-note-record";

export interface VoiceNoteRecordDetail {
  /** The atom's voiceId - also the key Editor.tsx matches VOICE_NOTE_RECORD_ABORT_EVENT against. */
  id: string;
  /** The (pulsing, for the duration of the session) inline glyph to anchor the panel to. */
  element: HTMLElement;
  /** True when this session concatenates onto an existing clip rather than creating one. */
  isAppend: boolean;
  /** Persists the finished clip onto this atom (appending first when `isAppend`). */
  complete: (wav: Uint8Array, durationMs: number) => void;
  /** Abandons the session: a brand-new atom is removed outright, an appended-to one reverts to
   * the clip it already had. */
  cancel: () => void;
}

/** Fired (bubbling) when an atom with an open recording session goes away underneath it - the note
 * was closed, or the text holding it was deleted. Editor.tsx unmounts the panel, whose own cleanup
 * releases the microphone. */
export const VOICE_NOTE_RECORD_ABORT_EVENT = "plainotes:voice-note-record-abort";

/** Set immediately before dispatching the transaction that inserts a fresh `voiceNoteInline` atom
 * (see Editor.tsx's insertVoiceNoteAtCursor) - `view.dispatch` synchronously constructs the new
 * atom's NodeView before it returns, so the constructor below can read this flag right after it's
 * set and know "this specific instance is the one that should start recording immediately", with
 * no need to thread state through node attrs (which would otherwise pollute markdown/undo). */
let autoStartId: string | null = null;
export function armAutoStartRecording(id: string) {
  autoStartId = id;
}

/** Only one microphone session may run at a time across every voiceNoteInline NodeView instance -
 * same invariant voiceNoteGrips.ts's old per-line `beginRecording` enforced (starting a new
 * recording finalizes/cancels whichever instance currently holds this). */
let activeRecorder: { id: string; cancel: () => void } | null = null;

type Mode = "idle" | "filled" | "recording";

/** NodeView for the `voiceNoteInline` atom (see voiceNoteInline.ts): renders as an inline mic
 * glyph that owns its own recording lifecycle (mirrors, and inlines, what used to be split across
 * voiceNoteGrips.ts's plugin-level RecordingState) - a live microphone session tied to one
 * specific atom instance via `getPos()`, the same "always re-resolve fresh, robust across doc
 * edits" mechanism notePinView.ts's `remove` already relies on ProseMirror to provide. */
class VoiceNoteInlineNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private notePath: string;
  private mode: Mode = "idle";
  /** Whether the in-progress recording is appending onto a clip that already existed before this
   * recording attempt started - decides both completeRecording's append-vs-replace path and
   * cancelRecording's revert-to-pill-vs-delete-the-atom path. */
  private isAppend = false;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined, notePath: string) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.notePath = notePath;

    this.dom = document.createElement("span");
    this.dom.contentEditable = "false";
    this.applyId(node);
    this.render();

    if (autoStartId && node.attrs.voiceId === autoStartId) {
      autoStartId = null;
      // Deferred one microtask: view.dispatch can't safely reenter synchronously from inside the
      // NodeView construction that's still part of the transaction which created this instance.
      Promise.resolve().then(() => {
        if (this.mode === "idle") this.requestRecording(false);
      });
    }
  }

  private applyId(node: ProseNode) {
    const id = node.attrs.voiceId as string | null;
    this.dom.id = id ? `voice-note-${id}` : "";
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.applyId(node);
    if (this.mode !== "recording") this.render();
    return true;
  }

  destroy() {
    // No *transaction* here (the doc change that removed this atom is already in flight) - just
    // tell the recorder panel its anchor is gone (note closed, the text holding this atom deleted
    // mid-recording, ...) so it unmounts and releases the microphone, rather than staying pinned
    // to a detached element.
    if (this.mode === "recording" && activeRecorder?.id === this.instanceId()) {
      activeRecorder = null;
      this.view.dom.dispatchEvent(
        new CustomEvent(VOICE_NOTE_RECORD_ABORT_EVENT, { detail: { id: this.instanceId() }, bubbles: true }),
      );
    }
  }

  private instanceId(): string {
    return (this.node.attrs.voiceId as string | null) ?? "";
  }

  // ---- rendering ----
  private render() {
    this.dom.innerHTML = "";
    this.dom.title = "";
    const voiceId = this.node.attrs.voiceId as string | null;
    const voiceSrc = this.node.attrs.voiceSrc as string | null;

    if (voiceId && voiceSrc) {
      this.mode = "filled";
      this.dom.className = "voice-note-inline voice-note-inline-pill";
      this.dom.title = `Voice note - ${formatDuration(this.node.attrs.voiceDur as number)}`;
      this.dom.innerHTML = MIC_ICON_FILLED;
      this.dom.onclick = this.onPillClick;
      this.dom.onmousedown = (event) => event.preventDefault();
    } else {
      this.mode = "idle";
      this.dom.className = "voice-note-inline voice-note-inline-idle";
      this.dom.title = "Tap to record";
      this.dom.innerHTML = MIC_ICON;
      this.dom.onclick = () => this.requestRecording(false);
      this.dom.onmousedown = (event) => event.preventDefault();
    }
  }

  /** The atom's appearance for the whole time VoiceRecorderPopover.tsx is open against it - a
   * pulsing mic at exactly the idle glyph's size (so starting a recording never reflows the line)
   * that the panel anchors to. */
  private renderLive() {
    this.mode = "recording";
    this.dom.className = "voice-note-inline voice-note-inline-live";
    this.dom.title = "Recording…";
    this.dom.innerHTML = MIC_ICON_FILLED;
    this.dom.onclick = null;
    this.dom.onmousedown = (event) => event.preventDefault();
  }

  private onPillClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const voiceId = this.node.attrs.voiceId as string | null;
    const voiceSrc = this.node.attrs.voiceSrc as string | null;
    if (!voiceId || !voiceSrc) return;
    const detail: VoiceNoteClickedDetail = {
      id: voiceId,
      voiceSrc,
      voiceDur: this.node.attrs.voiceDur as number,
      element: this.dom,
      remove: this.remove,
      startAppend: () => this.requestRecording(true),
    };
    this.view.dom.dispatchEvent(new CustomEvent(VOICE_NOTE_CLICKED_EVENT, { detail, bubbles: true }));
  };

  private remove = () => {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
  };

  // ---- recording ----
  /** Opens a recording session for this atom - the panel that actually drives it lives in React
   * (see VOICE_NOTE_RECORD_EVENT above), so all this does is claim the single global recording
   * slot, switch the glyph to its pulsing live state, and hand out the two callbacks the panel
   * finishes through. */
  private requestRecording(isAppend: boolean) {
    if (activeRecorder) activeRecorder.cancel();

    this.isAppend = isAppend;
    this.renderLive();
    activeRecorder = { id: this.instanceId(), cancel: () => this.cancelRecording() };

    const detail: VoiceNoteRecordDetail = {
      id: this.instanceId(),
      element: this.dom,
      isAppend,
      complete: (wav, durationMs) => void this.completeRecording(wav, durationMs),
      cancel: () => this.cancelRecording(),
    };
    this.view.dom.dispatchEvent(new CustomEvent(VOICE_NOTE_RECORD_EVENT, { detail, bubbles: true }));
  }

  /** Persists a finished clip: append-onto-existing when this session was started from "Record
   * more", plain write otherwise. Positions are re-resolved either side of the awaits, since the
   * doc can move (or lose this atom entirely) while the file is being written. */
  private async completeRecording(wav: Uint8Array, durationMs: number) {
    if (activeRecorder?.id === this.instanceId()) activeRecorder = null;

    try {
      const pos = this.getPos();
      if (pos === undefined) return; // atom was deleted while recording - drop the clip

      const voiceId = this.node.attrs.voiceId as string;
      let finalWav = wav;
      let finalDuration = durationMs;
      const existingSrc = this.node.attrs.voiceSrc as string | null;
      if (this.isAppend && existingSrc) {
        const existing = await readAttachment(existingSrc);
        const appended = await appendWav(existing, wav);
        finalWav = appended.wav;
        finalDuration = appended.durationMs;
      }

      const relPath = await writeAttachment(this.notePath, "voice.wav", finalWav);
      const freshPos = this.getPos();
      if (freshPos === undefined) return;
      const tr = this.view.state.tr.setNodeMarkup(freshPos, undefined, {
        ...this.node.attrs,
        voiceId,
        voiceSrc: relPath,
        voiceDur: finalDuration,
      });
      this.view.dispatch(tr);
    } finally {
      if (this.mode === "recording") this.render();
    }
  }

  /** Called both from the panel's own Delete button and from a *different* atom claiming the
   * recording slot - the microphone session itself is the panel's to release (it holds the
   * VoiceRecording), so this only unwinds the document side. */
  private cancelRecording() {
    if (activeRecorder?.id === this.instanceId()) activeRecorder = null;

    const hadContentBefore = this.isAppend;
    if (!hadContentBefore) {
      // Nothing existed before this recording attempt (a fresh toolbar-triggered insert) - cancel
      // means "never mind", so the atom itself goes away rather than being left as an empty stub.
      const pos = this.getPos();
      if (pos !== undefined) {
        this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
        return;
      }
    }
    this.render();
  }
}

export function voiceNoteInlineView(notePath: string) {
  return $view(voiceNoteInlineSchema.node, () => {
    return ((node, view, getPos) => new VoiceNoteInlineNodeView(node, view, getPos, notePath)) as NodeViewConstructor;
  });
}
