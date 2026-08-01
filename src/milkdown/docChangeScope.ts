import type { Node as ProseNode } from "@milkdown/kit/prose/model";

/** True when everything that changed between prevDoc and nextDoc is confined to the inline
 * text of a single still-same-type block (plain typing/deleting/marking text) - so no
 * block-level node (paragraph/heading/list_item/table_row/code_block/...) could have been
 * added, removed, split, merged, or had its attrs changed. Built on ProseMirror's own
 * Fragment#findDiffStart/findDiffEnd (the same diffing primitive PM uses internally for change
 * tracking) instead of inspecting Transaction steps, because PluginView#update only ever
 * receives the before/after EditorState, never the Transaction that produced it.
 *
 * findDiffStart/End recurse into a child only while `sameMarkup` (type+attrs+marks) holds; the
 * moment a node's type or attrs differ, they stop and report that shallow position instead of
 * descending - so an attrs-only change (e.g. setNodeMarkup for a voice note or table resize) or
 * a type change (e.g. paragraph -> heading) is never mistaken for an inline-only edit. A false
 * "not confined" just falls back to the caller's full scan - exactly what it always did before
 * this - so this can only make things faster, never less correct.
 *
 * Checking only the old doc's side isn't enough: a pure insertion (e.g. pressing Enter to split
 * one paragraph into two) can have its whole diff prefix/suffix-match away to a single point in
 * the *old* doc - nothing was removed there - while the *new* doc gained an extra block boundary
 * at that same point. So both sides have to independently resolve inside one still-same-type
 * textblock for this to be safe to call inline-only.
 *
 * `findDiffEnd`'s `a`/`b` positions can each come out *before* `start` - not a bug, just what it
 * means for the diff to be a pure insertion (nothing unmatched on the old side, e.g. typing a
 * character onto the end of a word matches as much prefix *and* suffix as exists) or a pure
 * deletion (same, on the new side). Each side's end is clamped up to `start` in that case, rather
 * than treated as an error, so a plain single-character insertion/deletion doesn't get misread as
 * "unsafe" just because the two matching passes happened to cross. */
export function isInlineOnlyChange(prevDoc: ProseNode, nextDoc: ProseNode): boolean {
  if (prevDoc === nextDoc) return true;
  const start = prevDoc.content.findDiffStart(nextDoc.content);
  if (start == null) return true;
  const diffEnd = prevDoc.content.findDiffEnd(nextDoc.content);
  if (!diffEnd) return true;
  const oldEnd = Math.max(start, diffEnd.a);
  const newEnd = Math.max(start, diffEnd.b);
  try {
    const $oldStart = prevDoc.resolve(start);
    const $oldEnd = prevDoc.resolve(oldEnd);
    const $newStart = nextDoc.resolve(start);
    const $newEnd = nextDoc.resolve(newEnd);
    return (
      $oldStart.depth > 0 &&
      $oldStart.parent === $oldEnd.parent &&
      $newStart.parent === $newEnd.parent &&
      $oldStart.parent.type === $newStart.parent.type &&
      $oldStart.parent.isTextblock
    );
  } catch {
    return false;
  }
}
