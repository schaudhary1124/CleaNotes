import { $nodeSchema, $remark } from "@milkdown/kit/utils";

/** Loose shape for the mdast nodes remark hands us - mirrors the same escape hatch used in
 * notePin.ts/imageSchemaExtensions.ts. */
interface MdastNode {
  type: string;
  value?: string;
  voiceId?: string;
  voiceSrc?: string;
  voiceDur?: number;
  children?: MdastNode[];
  [key: string]: unknown;
}

/** Attrs an inline voice-note atom carries - see voiceNoteInlineView.ts for the NodeView that
 * reads/writes these and voiceRecording.ts for how `voiceSrc` gets produced. `voiceId` is
 * non-null the instant the atom is inserted (see Editor.tsx's insertVoiceNoteAtCursor) - unlike
 * the legacy per-line attrs in voiceNoteSchemaExtensions.ts, there's no meaningful "atom exists
 * but has no id" state here, since the atom itself only exists because the user asked for a
 * voice note. `voiceSrc: null` just means "still recording (or a stalled/never-finished one)". */
export interface VoiceNoteInlineAttrs {
  voiceId: string | null;
  /** Note-relative path (writeAttachment's return value) to a normalized WAV asset. */
  voiceSrc: string | null;
  /** Total clip duration in milliseconds. */
  voiceDur: number;
}

// Deliberately a different tag from voiceNoteSchemaExtensions.ts's `plainotes-voice`/
// `plainotes-tablevoice` sidecars - this is a distinct (inline atom, not block-attrs) storage
// format, and reusing the same tag would make the two remark passes fight over the same comments.
const VOICE_POINT_PATTERN = /^<!--plainotes-voicepoint:([a-zA-Z0-9-]+);src=([^;]*);dur=(\d+)-->$/;

function encodeVoicePointSidecar(voice: VoiceNoteInlineAttrs): string {
  return `<!--plainotes-voicepoint:${voice.voiceId};src=${encodeURIComponent(voice.voiceSrc ?? "")};dur=${voice.voiceDur}-->`;
}

/** Recursively swaps any `html` mdast node matching the voicepoint sidecar for a synthetic
 * `voiceNoteInline` node remark can't produce on its own - same per-node convert-in-place shape
 * as notePin.ts's processPinSidecars. Because this sidecar is genuine inline HTML embedded
 * mid-paragraph (not a trailing block sidecar), no "unwrap paragraph > html" handling is needed
 * the way voiceNoteSchemaExtensions.ts's sidecarVoice requires. */
function processVoicePointSidecars(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === "html" && typeof node.value === "string") {
      const match = VOICE_POINT_PATTERN.exec(node.value.trim());
      if (match) {
        children[i] = {
          type: "voiceNoteInline",
          voiceId: match[1],
          voiceSrc: decodeURIComponent(match[2] ?? ""),
          voiceDur: Number(match[3]) || 0,
        };
        continue;
      }
    }
    processVoicePointSidecars(node.children);
  }
}

/** Must be `.use()`d after commonmark/gfm so their remark plugins have already settled the raw
 * `html` nodes into their final flat shape - same ordering requirement as notePinRemark. */
export const voiceNoteInlineRemark = $remark("plainotesVoiceNoteInline", () => () => (tree) => {
  processVoicePointSidecars((tree as unknown as MdastNode).children);
});

/** An inline, cursor-anchored voice note - a zero-content inline atom (like `notePin`), not
 * attrs on the enclosing block, so it flows with the surrounding text regardless of soft-wrap and
 * is addressable/deletable as its own unit. See voiceNoteInlineView.ts for the NodeView that
 * drives recording/playback. */
export const voiceNoteInlineSchema = $nodeSchema("voiceNoteInline", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,
  attrs: {
    voiceId: { default: null },
    voiceSrc: { default: null },
    voiceDur: { default: 0 },
  },
  parseDOM: [
    {
      tag: "span[data-voice-note]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return { voiceId: null, voiceSrc: null, voiceDur: 0 };
        return {
          voiceId: dom.dataset.voiceNote || null,
          voiceSrc: dom.dataset.voiceSrc || null,
          voiceDur: Number(dom.dataset.voiceDur) || 0,
        };
      },
    },
  ],
  toDOM: (node) => [
    "span",
    {
      "data-voice-note": (node.attrs.voiceId as string | null) ?? "",
      "data-voice-src": (node.attrs.voiceSrc as string | null) ?? "",
      "data-voice-dur": String(node.attrs.voiceDur as number),
      class: "voice-note-inline",
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === "voiceNoteInline",
    runner: (state, node, type) => {
      const mdastNode = node as MdastNode;
      state.addNode(type, {
        voiceId: mdastNode.voiceId ?? null,
        voiceSrc: mdastNode.voiceSrc ?? null,
        voiceDur: mdastNode.voiceDur ?? 0,
      });
    },
  },
  // Renders as nothing in copy-as-plain-text contexts (clipboard) - a recording marker, not
  // content, same reasoning as notePin.ts's leafText.
  leafText: () => "",
  toMarkdown: {
    match: (node) => node.type.name === "voiceNoteInline",
    runner: (state, node) => {
      const voiceId = node.attrs.voiceId as string | null;
      // A placeholder that never finished recording (mic permission denied, app closed mid-
      // recording, ...) silently drops out of saved markdown - harmless, since it only ever
      // existed transiently in the live doc anyway.
      if (!voiceId) return;
      state.addNode("html", undefined, encodeVoicePointSidecar({
        voiceId,
        voiceSrc: (node.attrs.voiceSrc as string | null) ?? null,
        voiceDur: (node.attrs.voiceDur as number) || 0,
      }));
    },
  },
}));

export const voiceNoteInlinePlugins = [voiceNoteInlineRemark, voiceNoteInlineSchema].flat();
