import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { headingSchema, paragraphSchema } from "@milkdown/kit/preset/commonmark";
import { extendListItemSchemaForTask } from "@milkdown/kit/preset/gfm";
import type { Ctx } from "@milkdown/kit/ctx";
import { $remark } from "@milkdown/kit/utils";
import type { BlockAlign } from "./alignmentSchemaExtensions";
import { findSidecarOwner, type MdastHtmlNode } from "./sidecarComments";
import { mapRowChildren, rowHeightAttr, tableHeaderRowSchemaExt, tableRowSchemaExt, tableSchemaExt } from "./tableSchemaExtensions";

/** A voice-note attachment on a paragraph/heading/list_item "line", or on a whole table row - see
 * voiceNoteGrips.ts for the margin UI that reads/writes these and voiceRecording.ts for how
 * `voiceSrc` gets produced. `null`/`0` (not omitted keys) is the "no voice note" state, mirroring
 * imageSchemaExtensions.ts's null-means-untouched `x`/`y` attrs. */
export interface VoiceNoteAttrs {
  voiceId: string | null;
  /** Note-relative path (writeAttachment's return value) to a normalized WAV asset - see
   * voiceRecording.ts. */
  voiceSrc: string | null;
  /** Total clip duration in milliseconds. */
  voiceDur: number;
}

const NO_VOICE: VoiceNoteAttrs = { voiceId: null, voiceSrc: null, voiceDur: 0 };

const VOICE_NOTE_ATTR_DEFAULTS = {
  voiceId: { default: null },
  voiceSrc: { default: null },
  voiceDur: { default: 0 },
};

/** Reads the voice-note attrs off a real ProseMirror node (used from `toMarkdown` runners, which
 * receive the actual node - contrast with mdastVoiceOf below, used from `parseMarkdown` runners,
 * which only see the loose mdast shape). */
function voiceAttrsOf(node: { attrs: Record<string, unknown> }): VoiceNoteAttrs {
  return {
    voiceId: (node.attrs.voiceId as string | null) ?? null,
    voiceSrc: (node.attrs.voiceSrc as string | null) ?? null,
    voiceDur: (node.attrs.voiceDur as number) || 0,
  };
}

/** Loose shape for the mdast nodes remark hands us - mirrors the same escape hatch used in
 * alignmentSchemaExtensions.ts/tableSchemaExtensions.ts. */
interface MdastNode extends MdastHtmlNode {
  depth?: number;
  label?: string | null;
  spread?: boolean;
  checked?: boolean | null;
  data?: Record<string, unknown>;
  children?: MdastNode[];
}

// `src` is URL-encoded defensively (unlike image's plain numeric extras) since a note-relative
// asset path can contain `;`/`=`-adjacent characters depending on folder/file naming.
const VOICE_SIDECAR_PATTERN = /^<!--plainotes-voice:([a-zA-Z0-9-]+);src=([^;]*);dur=(\d+)-->$/;

function encodeVoiceSidecar(voice: VoiceNoteAttrs): string {
  return `<!--plainotes-voice:${voice.voiceId};src=${encodeURIComponent(voice.voiceSrc ?? "")};dur=${voice.voiceDur}-->`;
}

/** Parses a `<!--plainotes-voice:...-->` sidecar's payload, or null if `node` isn't one. Same
 * "unwrap the paragraph > html quirk" shape as alignmentSchemaExtensions.ts's sidecarAlign -
 * commonmark's remarkHtmlTransformer flattens every top-level raw HTML node into `paragraph >
 * html`, so the sidecar comment can show up either bare or wrapped like that depending on its
 * neighbors (a trailing sidecar inside a list item's own content - see
 * processListItemVoiceSidecars below - hit the wrapped shape in practice). Missing this case
 * meant the sidecar was never recognized on reload: it fell through as ordinary paragraph text
 * instead of being stripped, so the raw `<!--plainotes-voice:...-->` comment rendered as a
 * second, visible line in the editor. */
function sidecarVoice(node: MdastHtmlNode | undefined): VoiceNoteAttrs | null {
  let value: string | undefined;
  if (node?.type === "html" && typeof node.value === "string") value = node.value;
  else if (node?.type === "paragraph" && node.children?.length === 1 && node.children[0]?.type === "html") {
    value = node.children[0].value as string | undefined;
  }
  if (typeof value !== "string") return null;
  const match = VOICE_SIDECAR_PATTERN.exec(value.trim());
  if (!match) return null;
  return { voiceId: match[1] ?? null, voiceSrc: decodeURIComponent(match[2] ?? ""), voiceDur: Number(match[3]) || 0 };
}

function mdastVoiceOf(node: MdastNode): VoiceNoteAttrs {
  return (node.data?.voiceNote as VoiceNoteAttrs | undefined) ?? NO_VOICE;
}

/** A table row's markdown content has to stay on the table's single physical line, the same
 * constraint that rules out a per-cell sidecar (see this file's own comment on why voice notes
 * attach to a whole `table_row`/`table_header_row`, not a `table_cell`, further down) - so unlike
 * paragraph/heading/list_item above, a row can't carry a trailing sidecar of its own. Instead this
 * mirrors tableSchemaExtensions.ts's own `<!--plainotes-table:...-->` cols/rows/bg sidecar: one
 * combined JSON blob, keyed by row index (0 = header row, matching `ProseNode.forEach`'s own
 * ordering over `table_header_row table_row+`), emitted once after the *entire table* closes -
 * never between individual rows, which - unlike after the whole table - sit inside gfm table
 * serialization's own row/cell matrix builder and would corrupt it.
 *
 * The "kind" segment has to stay a single lowercase word (no hyphen) to match
 * sidecarComments.ts's `ANY_SIDECAR_PATTERN` - `plainotes-table-voice:` would silently fail that
 * check and break every *other* feature's findSidecarOwner scan past this one. */
const TABLE_VOICE_SIDECAR_PATTERN = /^<!--plainotes-tablevoice:([\s\S]+)-->$/;

function encodeTableVoiceSidecar(rows: Record<number, VoiceNoteAttrs>): string {
  return `<!--plainotes-tablevoice:${JSON.stringify(rows)}-->`;
}

function tableVoiceSidecar(node: MdastHtmlNode | undefined): Record<number, VoiceNoteAttrs> | null {
  let value: string | undefined;
  if (node?.type === "html" && typeof node.value === "string") value = node.value;
  else if (node?.type === "paragraph" && node.children?.length === 1 && node.children[0]?.type === "html") {
    value = node.children[0].value as string | undefined;
  }
  if (typeof value !== "string") return null;
  const match = TABLE_VOICE_SIDECAR_PATTERN.exec(value.trim());
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as Record<number, VoiceNoteAttrs>;
  } catch {
    return null;
  }
}

/** Collects every row (header included) that currently carries a voice note into the compact
 * sidecar shape, or null if none do - same "stay plain Markdown when untouched" rule
 * tableSchemaExtensions.ts's collectFormatting follows for cols/rows/bg. */
function collectTableVoice(table: ProseNode): Record<number, VoiceNoteAttrs> | null {
  const rows: Record<number, VoiceNoteAttrs> = {};
  let hasAny = false;
  table.forEach((row, _offset, index) => {
    const voice = voiceAttrsOf(row);
    if (voice.voiceId) {
      rows[index] = voice;
      hasAny = true;
    }
  });
  return hasAny ? rows : null;
}

function applyTableVoice(table: MdastNode, voice: Record<number, VoiceNoteAttrs>) {
  (table.children ?? []).forEach((row, index) => {
    const rowVoice = voice[index];
    if (rowVoice) row.data = { ...(row.data ?? {}), voiceNote: rowVoice };
  });
}

/** Wires the `voiceId`/`voiceSrc`/`voiceDur` attrs into commonmark's paragraph/heading and gfm's
 * (task-aware) list-item node schemas, the same `ctx.update`-on-the-existing-ctx-key mechanism
 * `alignmentSchemaExtensions.ts`'s `configureAlignmentSchemas` uses and explains at length - see
 * that function's own comment for why patching in place (not `.extendSchema()`/`.use()`-ing a
 * replacement) is required for `paragraph` specifically.
 *
 * `list_item` needs the *task-list-extended* schema's ctx key
 * (`extendListItemSchemaForTask`, from `@milkdown/kit/preset/gfm`), not plain commonmark's
 * `listItemSchema`: gfm's task-list support is itself `listItemSchema.extendSchema(...)`, and
 * `$nodeSchema.extendSchema()` allocates a *brand-new* ctx slice (`$ctx(schema, id)` internally)
 * rather than reusing the original's - so `extendListItemSchemaForTask.ctx.key !==
 * listItemSchema.ctx.key`, and since `setup.ts` does `.use(gfm)`, only the former is what
 * `list_item` actually resolves through. Patching `listItemSchema.ctx.key` here would compile
 * fine and silently do nothing.
 *
 * `toDOM`/`parseDOM` are left untouched for all three (unlike alignment, which changes visible
 * layout): the margin UI (voiceNoteGrips.ts) is a floating overlay plugin that reads these attrs
 * straight off the doc and resolves each line's DOM element via `view.nodeDOM(pos)`, the same
 * way codeBlockGrips.ts/tableGrips.ts resolve their own target blocks - it never needs a literal
 * DOM marker to key off of. */
export function configureVoiceNoteSchemas(ctx: Ctx) {
  ctx.update(paragraphSchema.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    return {
      ...base,
      attrs: { ...base.attrs, ...VOICE_NOTE_ATTR_DEFAULTS },
      // Can't delegate to `base.parseMarkdown.runner`: it already calls `state.openNode(...)`
      // with its own (align-aware) attrs, and ProseMirror node attrs are fixed at the single
      // `openNode` call that creates the node - there's no way to merge more in afterward. This
      // re-reads `data.align` itself (duplicating alignmentSchemaExtensions.ts's one-line
      // default) purely so both attrs can land in the same `openNode` call.
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const mdastNode = node as MdastNode;
          const align = (mdastNode.data?.align as BlockAlign) ?? "left";
          const voice = mdastVoiceOf(mdastNode);
          state.openNode(type, { align, ...voice });
          if (mdastNode.children) state.next(mdastNode.children);
          else state.addText((mdastNode.value as string) || "");
          state.closeNode();
        },
      },
      // Unlike parseMarkdown, delegation works fine here: `base.toMarkdown.runner` receives the
      // already-fully-attributed real node (align included) and closes it, conditionally adding
      // its own align sidecar - this just adds one more sidecar after it returns.
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          base.toMarkdown.runner(state, node);
          const voice = voiceAttrsOf(node);
          if (voice.voiceId) state.addNode("html", undefined, encodeVoiceSidecar(voice));
        },
      },
    };
  });

  ctx.update(headingSchema.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    return {
      ...base,
      attrs: { ...base.attrs, ...VOICE_NOTE_ATTR_DEFAULTS },
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const mdastNode = node as MdastNode;
          const align = (mdastNode.data?.align as BlockAlign) ?? "left";
          const voice = mdastVoiceOf(mdastNode);
          state.openNode(type, { level: mdastNode.depth, align, ...voice });
          state.next(mdastNode.children ?? []);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          base.toMarkdown.runner(state, node);
          const voice = voiceAttrsOf(node);
          if (voice.voiceId) state.addNode("html", undefined, encodeVoiceSidecar(voice));
        },
      },
    };
  });

  // `list_item`'s content is `'paragraph block*'` - a real block container, unlike paragraph/
  // heading which only hold inline content - so its sidecar can't be a trailing sibling (a bare
  // HTML comment between two `- item` lines isn't a valid CommonMark continuation of the first
  // item and would split one list into two on re-parse). It's instead the list item's own last
  // *child*, indented under its marker by mdast-util-to-markdown's listItem handler for free as
  // long as it's appended before `closeNode()` - see processListItemVoiceSidecars below for the
  // matching read-side shape.
  ctx.update(extendListItemSchemaForTask.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    return {
      ...base,
      attrs: { ...base.attrs, ...VOICE_NOTE_ATTR_DEFAULTS },
      // Both the plain and task-list parseMarkdown runners
      // (@milkdown/preset-commonmark's list-item.ts / @milkdown/preset-gfm's
      // task-list-item.ts) compute label/listType/spread identically - they only differ in
      // whether `checked` is set - so this unifies them into one call rather than branching.
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const mdastNode = node as MdastNode;
          const label = mdastNode.label != null ? `${mdastNode.label}.` : "•";
          const listType = mdastNode.label != null ? "ordered" : "bullet";
          const spread = mdastNode.spread != null ? `${mdastNode.spread}` : "true";
          const checked = mdastNode.checked != null ? Boolean(mdastNode.checked) : null;
          const voice = mdastVoiceOf(mdastNode);
          state.openNode(type, { label, listType, spread, checked, ...voice });
          state.next(mdastNode.children ?? []);
          state.closeNode();
        },
      },
      // The no-voice path still delegates to `base.toMarkdown.runner` below, same as paragraph/
      // heading. Only the voice-attached path needs to stay open past `state.next`, so it
      // replicates (verbatim, not "improved") whichever of the two branches
      // extendListItemSchemaForTask's own runner would have taken, since delegating there would
      // already have closed the node before a sidecar could be appended.
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          const voice = voiceAttrsOf(node);
          if (!voice.voiceId) {
            base.toMarkdown.runner(state, node);
            return;
          }
          const checked = node.attrs.checked as boolean | null;
          if (checked == null) {
            state.openNode("listItem", undefined, { spread: node.attrs.spread });
          } else {
            state.openNode("listItem", undefined, {
              label: node.attrs.label,
              listType: node.attrs.listType,
              spread: node.attrs.spread === "true",
              checked,
            });
          }
          state.next(node.content);
          state.addNode("html", undefined, encodeVoiceSidecar(voice));
          state.closeNode();
        },
      },
    };
  });

  // A table row, not a table cell: a cell's own content is a single fixed-shape paragraph
  // rendered inline (via mdast-util-gfm-table's containerPhrasing) into the table's one physical
  // line - there's no room in that shape for a *second* child to carry a sidecar the way
  // list_item's flexible 'paragraph block*' content does. Rows get the attrs instead, and their
  // markdown round-trips through one combined per-table sidecar (collectTableVoice/
  // encodeTableVoiceSidecar's own comment above has the full reasoning) rather than each row
  // emitting its own - so unlike every case above, `toMarkdown` isn't touched here at all; only
  // tableSchemaExt's (the whole table's) toMarkdown is.
  ctx.update(tableRowSchemaExt.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    return {
      ...base,
      attrs: { ...base.attrs, ...VOICE_NOTE_ATTR_DEFAULTS },
      // Same can't-delegate-then-merge constraint as paragraph/heading above - replicates
      // tableRowSchemaExt's own runner shape (rowHeightAttr + mapRowChildren, exported from
      // tableSchemaExtensions.ts for exactly this) rather than duplicating its logic by hand.
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const mdastNode = node as MdastNode;
          const voice = mdastVoiceOf(mdastNode);
          state.openNode(type, { ...rowHeightAttr(mdastNode), ...voice });
          state.next(mapRowChildren(mdastNode));
          state.closeNode();
        },
      },
    };
  });

  ctx.update(tableHeaderRowSchemaExt.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    return {
      ...base,
      attrs: { ...base.attrs, ...VOICE_NOTE_ATTR_DEFAULTS },
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const mdastNode = node as MdastNode;
          const voice = mdastVoiceOf(mdastNode);
          const children = mapRowChildren(mdastNode).map((cell) => ({ ...cell, isHeader: mdastNode.isHeader }));
          state.openNode(type, { ...rowHeightAttr(mdastNode), ...voice });
          state.next(children);
          state.closeNode();
        },
      },
    };
  });

  // Layered on top of tableSchemaExt's own cols/rows/bg formatting sidecar (see
  // tableSchemaExtensions.ts's collectFormatting/tableSchemaExt) - delegating first means that
  // sidecar (if any) always lands closer to the table than this one, matching write order to
  // processVoiceSidecarsInBlocks's read-side expectations below.
  ctx.update(tableSchemaExt.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    return {
      ...base,
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          base.toMarkdown.runner(state, node);
          const voice = collectTableVoice(node);
          if (voice) state.addNode("html", undefined, encodeTableVoiceSidecar(voice));
        },
      },
    };
  });
}

/** Recursively strips every `<!--plainotes-voice:...-->` sidecar off the *trailing end* of a
 * `listItem` mdast node's own children and stamps the payload onto that list item's own
 * `data.voiceNote`. Must run before processVoiceSidecarsInBlocks below, which does a sibling
 * scan that would otherwise misattribute a trailing sidecar to whichever paragraph happens to be
 * the last block in the list item's own content instead of to the list item itself.
 *
 * Strips *every* trailing sidecar, not just one: the read-side "unwrap paragraph > html" gap
 * `sidecarVoice` used to have (see its own comment) meant a sidecar written while that bug was
 * live never got recognized on reload, so it was never stripped - and a *second* recording made
 * from that same (still-broken) reload appended a second sidecar behind it rather than replacing
 * it, stacking two. Scanning backward and stripping while each trailing child still matches self-
 * heals that case (and any future one like it) on the next load: the last (most recently
 * written) sidecar found wins as the authoritative payload, and anything older stripped along
 * with it is discarded rather than left behind as visible phantom text. */
function processListItemVoiceSidecars(node: MdastNode) {
  if (node.type === "listItem" && node.children?.length) {
    let voice: VoiceNoteAttrs | null = null;
    while (node.children.length > 0) {
      const candidate = sidecarVoice(node.children[node.children.length - 1]);
      if (!candidate) break;
      if (voice === null) voice = candidate;
      node.children = node.children.slice(0, -1);
    }
    if (voice) node.data = { ...(node.data ?? {}), voiceNote: voice };
  }
  node.children?.forEach(processListItemVoiceSidecars);
}

/** Recursively strips `<!--plainotes-voice:...-->` sidecars that sit as a *following sibling* of
 * a paragraph/heading (not nested inside a list item's own content - see
 * processListItemVoiceSidecars above for that structurally different case) and stamps their
 * value onto that paragraph/heading's `data.voiceNote`. Uses findSidecarOwner (not a raw
 * immediate-previous-sibling check) since alignmentSchemaExtensions.ts's own sidecar can land
 * between the paragraph and this one - see that helper's own comment. */
function processVoiceSidecarsInBlocks(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const voice = sidecarVoice(children[i]);
    const owner = voice ? (findSidecarOwner(children, i) as MdastNode | null) : null;
    if (voice && owner && (owner.type === "paragraph" || owner.type === "heading")) {
      // Scanning backward visits the *last-written* (most recent) sidecar for a given owner
      // before any stray older one stacked up behind it (see processListItemVoiceSidecars's own
      // comment on how that can happen) - don't let a later iteration's stale match overwrite
      // the correct value already stamped here, even though it still gets spliced out below.
      if (owner.data?.voiceNote === undefined) owner.data = { ...(owner.data ?? {}), voiceNote: voice };
      children.splice(i, 1);
      continue;
    }
    // findSidecarOwner (not a raw immediate-previous-sibling check, same reasoning as above)
    // since tableSchemaExtensions.ts's own cols/rows/bg sidecar can land between the table and
    // this one - see configureVoiceNoteSchemas's tableSchemaExt patch for why that's always the
    // write order rather than the reverse.
    const tableVoice = tableVoiceSidecar(children[i]);
    const tableOwner = tableVoice ? findSidecarOwner(children, i) : null;
    if (tableVoice && tableOwner?.type === "table") {
      applyTableVoice(tableOwner as MdastNode, tableVoice);
      children.splice(i, 1);
      continue;
    }
    processVoiceSidecarsInBlocks(children[i].children);
  }
}

/** Must be `.use()`d after commonmark/gfm so their remark plugins have already settled raw
 * `html` nodes into their final flat shape - same ordering requirement as
 * alignmentSidecarRemark/tableSidecarRemark. Runs the list-item pass first (see
 * processListItemVoiceSidecars's own comment for why order matters here specifically). */
export const voiceSidecarRemark = $remark("plainotesVoiceNote", () => () => (tree) => {
  const root = tree as unknown as MdastNode;
  processListItemVoiceSidecars(root);
  processVoiceSidecarsInBlocks(root.children);
});
