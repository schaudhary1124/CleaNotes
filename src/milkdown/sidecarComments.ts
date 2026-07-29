/** Loose shape shared by every sidecar-scanning remark pass in src/milkdown/*SchemaExtensions.ts
 * (align, voice, ...) - same escape hatch each of those files already declares its own copy of. */
export interface MdastHtmlNode {
  type: string;
  value?: string;
  children?: MdastHtmlNode[];
  [key: string]: unknown;
}

// Matches ANY of this app's `<!--plainotes-<kind>:...-->` sidecar comments (align, voice, pin,
// image, table, ...), not just one feature's own - see findSidecarOwner below for why.
const ANY_SIDECAR_PATTERN = /^<!--plainotes-[a-z]+:/;

/** True if `node` is some recognized plainotes sidecar comment - regardless of *which* feature
 * it belongs to. Used only to recognize "skip past this, it's not what I'm looking for", not to
 * read its payload (each feature's own pattern, e.g. alignmentSchemaExtensions.ts's
 * SIDECAR_PATTERN, still does that).
 *
 * Checks both shapes a sidecar can show up as: a bare `html` node, or one commonmark's
 * remarkHtmlTransformer wrapped in `paragraph > html` (its "unwrap the paragraph > html quirk" -
 * see alignmentSchemaExtensions.ts's sidecarAlign / voiceNoteSchemaExtensions.ts's sidecarVoice,
 * which each unwrap it for their *own* pattern already) - skipped here too so the backward scan
 * doesn't mistake a wrapped foreign sidecar for real paragraph/heading content and stop short. */
export function isPlainotesSidecarHtml(node: MdastHtmlNode | undefined): boolean {
  if (node?.type === "html" && typeof node.value === "string") {
    return ANY_SIDECAR_PATTERN.test(node.value.trim());
  }
  if (node?.type === "paragraph" && node.children?.length === 1 && node.children[0]?.type === "html") {
    const inner = node.children[0].value;
    return typeof inner === "string" && ANY_SIDECAR_PATTERN.test(inner.trim());
  }
  return false;
}

/** Finds the sibling immediately preceding `children[i]`, skipping back over any *other*
 * recognized plainotes sidecar in between. Two independently-layered sidecar-emitting schema
 * patches on the same node type (e.g. alignmentSchemaExtensions.ts and
 * voiceNoteSchemaExtensions.ts both patching paragraph/heading) each append their own trailing
 * sidecar in a fixed, deterministic order on write - but that means one's sidecar can end up
 * sitting between a paragraph and the other's sidecar in the doc. A naive "my sidecar's
 * immediate previous sibling must be the paragraph" scan misses its owner in that case; this
 * lets each scan look past sidecars it doesn't recognize as its own instead, so neither depends
 * on the other's `.use()` order or which patch layered on top of which. */
export function findSidecarOwner(children: MdastHtmlNode[], i: number): MdastHtmlNode | null {
  let j = i - 1;
  while (j >= 0 && isPlainotesSidecarHtml(children[j])) j--;
  return j >= 0 ? children[j] : null;
}
