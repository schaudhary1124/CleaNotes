import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { headingSchema, paragraphSchema } from "@milkdown/kit/preset/commonmark";
import { isInTable } from "@milkdown/kit/prose/tables";
import { canSplit } from "@milkdown/kit/prose/transform";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { BlockStyle } from "./setup";

/** Strips every mark (bold, italic, highlight, underline, strikethrough, ...)
 * from the current selection - the toolbar's "Clear formatting" action.
 * No-ops on a collapsed selection, same as most editors' equivalent command:
 * there's no range to clear, and clearing `storedMarks` instead would be a
 * surprising side effect for a click that looks like it did nothing. */
export function clearFormatting(ctx: Ctx) {
  const view = ctx.get(editorViewCtx);
  const { from, to, empty } = view.state.selection;
  if (empty) return;
  view.dispatch(view.state.tr.removeMark(from, to));
}

/** Blocks we're willing to cut in half to honour a partial selection. Anything
 * else the selection happens to touch (code blocks, list items, images, ...)
 * is left whole and just gets its type set, as before. */
const SPLITTABLE_BLOCKS = new Set(["paragraph", "heading"]);

/** Applies a text style (Normal text / Subheading / Heading / Title) to the
 * selection.
 *
 * Heading-ness is a property of a *block* in both ProseMirror and markdown, so
 * the naive `setBlockType` that used to back this dropdown (Milkdown's
 * `wrapInHeadingCommand`) restyled every block the selection touched in full -
 * highlighting three words of a paragraph and picking "Title" turned the whole
 * paragraph into a title. There is no way to represent "half a line is a
 * heading" as a mark, so instead we give the highlighted run a block of its
 * own: split the first block at the start of the selection and the last block
 * at its end, then set the type across what's left in between. The unselected
 * head and tail stay behind as their original type, which is what "only change
 * what I highlighted" looks like once it round-trips through markdown.
 *
 * Splits are skipped when the boundary is already a block edge (no empty
 * blocks left behind), when the block isn't one we split (see
 * SPLITTABLE_BLOCKS), when the selection sits inside a table (a cell's
 * markdown is inline-only - see tableSchemaExtensions.ts - so a second
 * paragraph in a cell would not survive a save), and whenever ProseMirror's
 * own `canSplit` says the result would be invalid. In all of those cases this
 * degrades to exactly the old whole-block behaviour. */
export function setBlockStyle(ctx: Ctx, style: BlockStyle) {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { from, to, empty, $from, $to } = state.selection;

  const type = style === "paragraph" ? paragraphSchema.type(ctx) : headingSchema.type(ctx);
  // Alignment is a plainotes attr on both node types (alignmentSchemaExtensions.ts) and
  // is orthogonal to the style, so carry it across the conversion. `id` is deliberately
  // not carried: a heading's slug should be regenerated from its new text.
  const attrsFor = (node: ProseNode) => ({
    align: (node.attrs.align as string | undefined) ?? "left",
    ...(style === "paragraph" ? {} : { level: style }),
  });

  // Nothing to do if everything in range is already this style - bail before splitting,
  // so re-picking the current style isn't a way to accidentally chop a paragraph in three.
  let alreadyStyled = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock && !node.hasMarkup(type, attrsFor(node))) alreadyStyled = false;
  });
  if (alreadyStyled) return;

  const tr = state.tr;
  const splittable = !empty && !isInTable(state);
  // End first: splitting there can't move `from`, so the second split still uses
  // untouched coordinates.
  if (splittable && SPLITTABLE_BLOCKS.has($to.parent.type.name) && to < $to.end() && canSplit(tr.doc, to)) {
    tr.split(to);
  }
  if (splittable && SPLITTABLE_BLOCKS.has($from.parent.type.name) && from > $from.start() && canSplit(tr.doc, from)) {
    tr.split(from);
  }

  // Bias each end *into* the range the splits carved out, so the new boundary
  // blocks either side of it aren't restyled too.
  tr.setBlockType(tr.mapping.map(from, 1), tr.mapping.map(to, -1), type, attrsFor);
  if (tr.docChanged) view.dispatch(tr);
}
