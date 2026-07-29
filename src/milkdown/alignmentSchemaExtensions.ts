import { headingAttr, headingIdGenerator, headingSchema, paragraphAttr, paragraphSchema } from "@milkdown/kit/preset/commonmark";
import type { Ctx } from "@milkdown/kit/ctx";
import { $remark } from "@milkdown/kit/utils";
import { findSidecarOwner } from "./sidecarComments";

export type BlockAlign = "left" | "center" | "right";

/** Loose shape for the mdast nodes remark hands us - mirrors the same escape
 * hatch already used in tableSchemaExtensions.ts/textDecorationMarks.ts. */
interface MdastNode {
  type: string;
  value?: string;
  depth?: number;
  data?: Record<string, unknown>;
  children?: MdastNode[];
  [key: string]: unknown;
}

const SIDECAR_PATTERN = /^<!--plainotes-align:(left|center|right)-->$/;

function alignOf(node: { attrs: { align?: unknown } }): BlockAlign {
  return (node.attrs.align as BlockAlign | undefined) ?? "left";
}

function alignStyle(align: BlockAlign): Record<string, string> {
  return align === "left" ? {} : { style: `text-align: ${align}` };
}

/** Wires the `align` attr into commonmark's existing paragraph/heading node
 * schemas and their markdown sidecar comment, by patching the `GetNodeSchema`
 * function each one's ctx slice resolves to - NOT via `paragraphSchema.
 * extendSchema(...)`/`.use()`, even though that's the pattern
 * tableSchemaExtensions.ts uses for table nodes.
 *
 * The difference matters: `$nodeSchema(id, ...).extendSchema` builds a brand
 * new `$node(id, ...)` plugin under the same id, and Milkdown's node
 * registration (`ctx.update(nodesCtx, ns => [...ns.filter(n => n[0] !== id),
 * [id, schema]])`, see @milkdown/utils) always *removes then re-appends* -
 * so `.use()`-ing it moves that node to the end of the schema's node list.
 * For table-only node types that's harmless. For `paragraph` it isn't:
 * ProseMirror picks the "default" fill type for generic `block+` content
 * (the doc root, list items, blockquotes, ...) as the *first* node in that
 * list without required attrs, and `paragraph` is normally first for exactly
 * this reason. Re-registering it bumped `code_block` (untouched, still
 * early) ahead of it - so pressing Enter on an empty trailing paragraph
 * (splitting it, which asks ProseMirror to fill in a fresh default block)
 * silently produced a code block instead of another paragraph.
 * `ctx.update` on the existing schema's own ctx slice instead patches what
 * the *original*, already-positioned `$node` plugin resolves to, leaving
 * registration order untouched. Called from setup.ts's `.config()`, the same
 * place codeBlockConfig/hardbreakFilterNodes are overridden. */
export function configureAlignmentSchemas(ctx: Ctx) {
  ctx.update(paragraphSchema.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    return {
      ...base,
      attrs: { align: { default: "left" } },
      toDOM: (node) => ["p", { ...innerCtx.get(paragraphAttr.key)(node), ...alignStyle(alignOf(node)) }, 0],
      parseDOM: [
        {
          tag: "p",
          getAttrs: (dom) => ({
            align: ((dom instanceof HTMLElement && dom.style.textAlign) || "left") as BlockAlign,
          }),
        },
      ],
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const mdastNode = node as MdastNode;
          state.openNode(type, { align: (mdastNode.data?.align as BlockAlign) ?? "left" });
          if (mdastNode.children) state.next(mdastNode.children);
          else state.addText((mdastNode.value as string) || "");
          state.closeNode();
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          base.toMarkdown.runner(state, node);
          const align = alignOf(node);
          if (align !== "left") state.addNode("html", undefined, `<!--plainotes-align:${align}-->`);
        },
      },
    };
  });

  ctx.update(headingSchema.ctx.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx);
    const getId = innerCtx.get(headingIdGenerator.key);
    return {
      ...base,
      attrs: { ...base.attrs, align: { default: "left" } },
      toDOM: (node) => [
        `h${node.attrs.level as number}`,
        {
          ...innerCtx.get(headingAttr.key)(node),
          id: node.attrs.id || getId(node),
          ...alignStyle(alignOf(node)),
        },
        0,
      ],
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        getAttrs: (dom: HTMLElement | string) => {
          if (!(dom instanceof HTMLElement)) return false;
          return {
            level,
            id: dom.id,
            align: (dom.style.textAlign || "left") as BlockAlign,
          };
        },
      })),
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const mdastNode = node as MdastNode;
          state.openNode(type, { level: mdastNode.depth, align: (mdastNode.data?.align as BlockAlign) ?? "left" });
          state.next(mdastNode.children ?? []);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          base.toMarkdown.runner(state, node);
          const align = alignOf(node);
          if (align !== "left") state.addNode("html", undefined, `<!--plainotes-align:${align}-->`);
        },
      },
    };
  });
}

/** Same "unwrap the paragraph > html quirk" shape as tableSchemaExtensions.ts'
 * sidecarValue - commonmark's remarkHtmlTransformer flattens every top-level
 * raw HTML node into `paragraph > html`, so the sidecar comment can show up
 * either bare or wrapped like that depending on its neighbors. */
function sidecarAlign(node: MdastNode): BlockAlign | null {
  let value: string | undefined;
  if (node.type === "html" && typeof node.value === "string") value = node.value;
  else if (node.type === "paragraph" && node.children?.length === 1 && node.children[0].type === "html") {
    value = node.children[0].value;
  }
  if (typeof value !== "string") return null;
  const match = SIDECAR_PATTERN.exec(value.trim());
  return match ? (match[1] as BlockAlign) : null;
}

/** Recursively strips `<!--plainotes-align:...-->` sidecars out of the mdast
 * tree and stamps their value onto the owning paragraph/heading's
 * `data.align`, for the schemas above to pick up. Hand-rolled the same way
 * tableSchemaExtensions.ts's processChildren is, for the same
 * single-purpose-sibling-scan reason.
 *
 * The owner isn't always the *immediate* previous sibling:
 * voiceNoteSchemaExtensions.ts patches these same paragraph/heading schemas,
 * and when both attrs are present its own sidecar can land between the
 * paragraph and this one (the two patches' `toMarkdown` runners are layered,
 * so whichever wraps the other always emits its sidecar second).
 * findSidecarOwner skips back over any such foreign sidecar instead of
 * assuming adjacency, so this scan doesn't depend on which patch was
 * layered on top of the other. */
function processAlignSidecars(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const align = sidecarAlign(children[i]);
    const owner = align ? findSidecarOwner(children, i) : null;
    if (align && owner && (owner.type === "paragraph" || owner.type === "heading")) {
      owner.data = { ...(owner.data ?? {}), align };
      children.splice(i, 1);
      continue;
    }
    processAlignSidecars(children[i].children);
  }
}

/** Must be `.use()`d after commonmark/gfm so their remark plugins have
 * already flattened raw HTML into its final shape - same ordering
 * requirement as tableSidecarRemark/textDecorationRemark. */
export const alignmentSidecarRemark = $remark("plainotesAlignFormatting", () => () => (tree) => {
  processAlignSidecars((tree as unknown as MdastNode).children);
});
