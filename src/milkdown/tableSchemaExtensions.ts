import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import {
  tableCellSchema,
  tableHeaderRowSchema,
  tableHeaderSchema,
  tableRowSchema,
  tableSchema,
} from "@milkdown/kit/preset/gfm";
import { tableNodes } from "@milkdown/kit/prose/tables";
import { $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

/** Loose shape for the mdast nodes remark hands us - only the fields this
 * file actually reads/writes are named, everything else passes through via
 * the index signature (mirrors the `node as never` escape hatch pattern
 * used elsewhere for mdast nodes). */
interface MdastNode {
  type: string;
  value?: string;
  align?: (string | null)[] | string | null;
  isHeader?: boolean;
  children?: MdastNode[];
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

const SIDECAR_PREFIX = "plainotes-table:";
const SIDECAR_PATTERN = /^<!--plainotes-table:([\s\S]+)-->$/;

interface TableFormatting {
  cols?: (number | null)[];
  rows?: Record<string, number>;
  bg?: Record<string, string>;
}

/** Same `alignment` cell attribute gfm's table schema already uses - kept
 * byte-for-byte so parsing/rendering existing alignment stays identical. */
const alignmentAttribute = {
  default: "left",
  getFromDOM: (dom: HTMLElement) => dom.style.textAlign || "left",
  setDOMAttr: (value: unknown, attrs: Record<string, unknown>) => {
    attrs.style = `text-align: ${value || "left"}`;
  },
};

/** `setDOMAttr`s run in declaration order and each one may overwrite
 * `attrs.style` wholesale (that's what `alignmentAttribute` above does) - so
 * this one must run after alignment and *append* rather than replace. */
const backgroundAttribute = {
  default: null,
  getFromDOM: (dom: HTMLElement) => dom.style.backgroundColor || null,
  setDOMAttr: (value: unknown, attrs: Record<string, unknown>) => {
    if (!value) return;
    const prev = typeof attrs.style === "string" && attrs.style ? `${attrs.style};` : "";
    attrs.style = `${prev}background-color: ${value as string}`;
  },
};

/** A second `tableNodes()` call, independent from the one baked into
 * @milkdown/preset-gfm, whose only purpose is to hand us cell `attrs` /
 * `parseDOM` / `toDOM` that also know about `background` (colspan, rowspan,
 * and colwidth come along for free - they're always part of `tableNodes()`'s
 * cell attrs, background is the only genuinely new one). */
const cellNodes = tableNodes({
  tableGroup: "block",
  cellContent: "paragraph",
  cellAttributes: { alignment: alignmentAttribute, background: backgroundAttribute },
});

function cellDataAttrs(node: MdastNode) {
  const colwidth = node.data?.colwidth as number[] | null | undefined;
  const background = node.data?.background as string | null | undefined;
  return {
    colwidth: colwidth ?? null,
    background: background ?? null,
  };
}

export const tableCellSchemaExt = tableCellSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: cellNodes.table_cell.attrs,
    parseDOM: cellNodes.table_cell.parseDOM,
    toDOM: cellNodes.table_cell.toDOM,
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const mdastNode = node as MdastNode;
        state
          .openNode(type, { alignment: mdastNode.align, ...cellDataAttrs(mdastNode) })
          .openNode(state.schema.nodes.paragraph)
          .next(mdastNode.children ?? [])
          .closeNode()
          .closeNode();
      },
    },
  };
});

export const tableHeaderSchemaExt = tableHeaderSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: cellNodes.table_header.attrs,
    parseDOM: cellNodes.table_header.parseDOM,
    toDOM: cellNodes.table_header.toDOM,
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const mdastNode = node as MdastNode;
        state.openNode(type, { alignment: mdastNode.align, ...cellDataAttrs(mdastNode) });
        state.openNode(state.schema.nodes.paragraph);
        state.next(mdastNode.children ?? []);
        state.closeNode();
        state.closeNode();
      },
    },
  };
});

/** Exported for voiceNoteSchemaExtensions.ts's own tableRowSchemaExt/tableHeaderRowSchemaExt
 * patches, which need to replicate these two runners' exact openNode/next call shape (with a
 * voice attr merged into the same openNode) rather than delegate to them - same
 * can't-merge-attrs-after-the-fact constraint documented at length on that file's own
 * paragraph/heading patches. */
export function rowHeightAttr(node: MdastNode) {
  const height = node.data?.height as number | null | undefined;
  return { height: height ?? null };
}

/** Row content mapping copied from gfm's own tableRowSchema/tableHeaderRowSchema
 * runners (they distribute per-column `align` onto each cell) - the only
 * addition is passing the row's own `height` attr through to `openNode`. */
export function mapRowChildren(node: MdastNode): MdastNode[] {
  const align = node.align;
  const alignArray = Array.isArray(align) ? align : undefined;
  return (node.children ?? []).map((cell, i) => ({ ...cell, align: alignArray?.[i] }));
}

export const tableRowSchemaExt = tableRowSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { height: { default: null } },
    parseDOM: [
      {
        tag: "tr",
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement)) return false;
          const height = Number.parseInt(dom.style.height, 10);
          return { height: Number.isFinite(height) ? height : null };
        },
      },
    ],
    toDOM: (node: ProseNode) => [
      "tr",
      node.attrs.height ? { style: `height: ${node.attrs.height as number}px` } : {},
      0,
    ],
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const mdastNode = node as MdastNode;
        state.openNode(type, rowHeightAttr(mdastNode));
        state.next(mapRowChildren(mdastNode));
        state.closeNode();
      },
    },
  };
});

export const tableHeaderRowSchemaExt = tableHeaderRowSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { height: { default: null } },
    parseDOM: [
      {
        tag: "tr[data-is-header]",
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement)) return {};
          const height = Number.parseInt(dom.style.height, 10);
          return { height: Number.isFinite(height) ? height : null };
        },
      },
      {
        tag: "tr",
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement) || !dom.querySelector("th")) return false;
          const height = Number.parseInt(dom.style.height, 10);
          return { height: Number.isFinite(height) ? height : null };
        },
      },
    ],
    toDOM: (node: ProseNode) => [
      "tr",
      { "data-is-header": true, ...(node.attrs.height ? { style: `height: ${node.attrs.height as number}px` } : {}) },
      0,
    ],
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const mdastNode = node as MdastNode;
        const children = mapRowChildren(mdastNode).map((cell) => ({ ...cell, isHeader: mdastNode.isHeader }));
        state.openNode(type, rowHeightAttr(mdastNode));
        state.next(children);
        state.closeNode();
      },
    },
  };
});

/** Walks a table's rendered rows/cells to collect any non-default
 * width/height/color into the compact sidecar shape - returns null when the
 * table has no customization at all, so plain tables stay plain Markdown. */
function collectFormatting(node: ProseNode): TableFormatting | null {
  const cols: (number | null)[] = [];
  const rows: Record<string, number> = {};
  const bg: Record<string, string> = {};
  let hasAny = false;

  node.content.forEach((row, _offset, rowIndex) => {
    const height = row.attrs.height as number | null;
    if (height) {
      rows[rowIndex] = height;
      hasAny = true;
    }
    row.content.forEach((cell, __offset, colIndex) => {
      const colwidth = cell.attrs.colwidth as number[] | null;
      if (colwidth?.[0] && cols[colIndex] == null) {
        cols[colIndex] = colwidth[0];
        hasAny = true;
      }
      const background = cell.attrs.background as string | null;
      if (background) {
        bg[`${rowIndex}:${colIndex}`] = background;
        hasAny = true;
      }
    });
  });

  if (!hasAny) return null;
  const formatting: TableFormatting = {};
  if (cols.some((c) => c != null)) formatting.cols = cols.map((c) => c ?? null);
  if (Object.keys(rows).length) formatting.rows = rows;
  if (Object.keys(bg).length) formatting.bg = bg;
  return formatting;
}

export const tableSchemaExt = tableSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        base.toMarkdown.runner(state, node);
        const formatting = collectFormatting(node);
        if (formatting) {
          state.addNode("html", undefined, `<!--${SIDECAR_PREFIX}${JSON.stringify(formatting)}-->`);
        }
      },
    },
  };
});

function applyFormatting(table: MdastNode, raw: string) {
  let data: TableFormatting;
  try {
    data = JSON.parse(raw) as TableFormatting;
  } catch {
    return;
  }
  (table.children ?? []).forEach((row, rowIndex) => {
    row.data = { ...(row.data ?? {}), height: data.rows?.[rowIndex] ?? null };
    (row.children ?? []).forEach((cell, colIndex) => {
      const width = data.cols?.[colIndex];
      cell.data = {
        ...(cell.data ?? {}),
        colwidth: width ? [width] : null,
        background: data.bg?.[`${rowIndex}:${colIndex}`] ?? null,
      };
    });
  });
}

/** Milkdown's `commonmark` preset has no dedicated "HTML block" node type,
 * so its own remarkHtmlTransformer plugin (registered ahead of this one)
 * rewrites every top-level `html` node into `paragraph > html` before this
 * plugin ever sees it - the sidecar can show up either bare or wrapped like
 * that, so both shapes have to be recognized here. */
function sidecarValue(node: MdastNode): string | null {
  if (node.type === "html" && typeof node.value === "string") return node.value;
  if (node.type === "paragraph" && node.children?.length === 1) {
    const child = node.children[0];
    if (child.type === "html" && typeof child.value === "string") return child.value;
  }
  return null;
}

/** Recursively strips sidecar comments out of the mdast tree (so they never
 * render as stray paragraphs) and stamps their data onto the preceding
 * table's row/cell nodes for the node schemas above to pick up. Hand-rolled
 * instead of pulling in unist-util-visit for a single-purpose sibling scan. */
function processChildren(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i];
    const value = i > 0 && children[i - 1].type === "table" ? sidecarValue(node) : null;
    if (value != null) {
      const match = SIDECAR_PATTERN.exec(value.trim());
      if (match) {
        applyFormatting(children[i - 1], match[1]);
        children.splice(i, 1);
        continue;
      }
    }
    processChildren(node.children);
  }
}

/** Must be `.use()`d after `.use(gfm)` so remarkGFM has already turned raw
 * pipe tables into mdast `table` nodes by the time this runs. */
export const tableSidecarRemark = $remark("plainotesTableFormatting", () => () => (tree) => {
  processChildren((tree as unknown as MdastNode).children);
});

/** Loose shape covering just the `state` field this file's handler reads -
 * mirrors the loose-typing convention above rather than importing
 * mdast-util-to-markdown's real (and much larger) `State` type. */
interface ToMarkdownStateWithStack {
  stack: string[];
}

/** GFM table cells can't contain a literal newline (each table row has to be
 * one physical line of markdown), so mdast-util-gfm-table flags '\n' as
 * unsafe inside a `tableCell` construct - and the library's own default
 * `break` handler (mdast-util-to-markdown's handle/break.js), on seeing that,
 * silently swaps the line break for a single space instead of erroring. That
 * made every newline typed into a table cell (via tableLineBreak.ts's Enter
 * handling, or Shift-Enter) vanish the moment the note was saved and
 * reloaded. Overriding the handler to emit `<br data-plainotes-break>` while
 * inside a table cell - a variant of the standard, widely-supported way to
 * force a line break in a markdown table cell - fixes that; outside table
 * cells this defers to the library's real default so other unsafe-context
 * handling (e.g. setext headings) is untouched.
 *
 * A plain `<br>` won't do: @milkdown/preset-commonmark's
 * remarkPreserveEmptyLinePlugin (bundled into `commonmark` in setup.ts, for
 * an unrelated feature - preserving blank lines between paragraphs) scans the
 * *entire* tree for any html node whose value is exactly `<br>`, `<br/>`,
 * `<br />`, or `<br >` and deletes it outright, table cells included. The
 * data attribute keeps this out of that exact-string blacklist while still
 * rendering as a real line break in any other markdown viewer, since
 * unrecognized attributes on `<br>` are simply ignored by any HTML parser. */
const CELL_BREAK_TAG = "<br data-plainotes-break>";

function tableCellAwareBreak(
  node: unknown,
  parent: unknown,
  state: ToMarkdownStateWithStack,
  info: unknown,
): string {
  if (state.stack.includes("tableCell")) return CELL_BREAK_TAG;
  return (defaultHandlers.break as (n: unknown, p: unknown, s: unknown, i: unknown) => string)(
    node,
    parent,
    state,
    info,
  );
}

/** The other half of tableCellAwareBreak: when a table cell is parsed back
 * from markdown, a `<br data-plainotes-break>` lands as a raw inline `html`
 * mdast node (same as any other unrecognized inline tag) rather than the
 * `break` node a real line break would produce. Swap it back in place so it
 * flows into hardbreakSchema's `parseMarkdown` (which matches on
 * `type === "break"`) exactly like a Shift-Enter break would. */
const BR_TAG_PATTERN = /^<br\s+data-plainotes-break\s*\/?>$/i;

function convertCellBreaks(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === "html" && typeof node.value === "string" && BR_TAG_PATTERN.test(node.value.trim())) {
      children[i] = { type: "break" };
    }
  }
}

/** Recursively finds every `tableCell` in the tree and converts its `<br>`
 * children - cells can be nested arbitrarily deep inside other block
 * content (e.g. a list within a cell), so this walks the whole tree rather
 * than just one row/table level. */
function convertCellBreaksInTree(children: MdastNode[] | undefined) {
  if (!children) return;
  for (const node of children) {
    if (node.type === "tableCell") convertCellBreaks(node.children);
    convertCellBreaksInTree(node.children);
  }
}

interface RemarkProcessorLike {
  data(key: "toMarkdownExtensions"): unknown[] | undefined;
  data(key: "toMarkdownExtensions", value: unknown[]): void;
}

/** Registers both directions of the table-cell line-break fix: a tree
 * transform (parse direction) that turns `<br>` html nodes inside table
 * cells back into `break` nodes, plus a `mdast-util-to-markdown` handler
 * extension (stringify direction) that renders `break` nodes inside table
 * cells as `<br>` instead of losing them to a space. Same two-sided
 * registration pattern as textDecorationMarks.ts's textDecorationRemark.
 * Must run after `.use(gfm)`, same ordering requirement as
 * tableSidecarRemark above. */
export const tableCellBreakRemark = $remark("plainotesTableCellBreaks", () => {
  return function attachTableCellBreaks(this: RemarkProcessorLike) {
    const extensions = this.data("toMarkdownExtensions") ?? [];
    this.data("toMarkdownExtensions", [...extensions, { handlers: { break: tableCellAwareBreak } }]);

    return (tree: unknown) => {
      convertCellBreaksInTree((tree as MdastNode).children);
    };
  };
});

/** Registration order matters here, not just for readability: Milkdown
 * resolves markdown nodes to a ProseMirror type by scanning `schema.nodes`
 * and taking the first schema whose `parseMarkdown.match` returns true, and
 * a schema re-registered via `.extendSchema` moves to the *end* of that scan
 * order. `table_row`'s match is unconditional (any `tableRow` mdast node) -
 * it has to stay ordered after `table_header_row` (`isHeader` rows only) or
 * every header row gets misparsed as a body row. Mirrors gfm's own
 * registration order (header schemas before their body counterparts). */
export const tableSchemaExtensionPlugins = [
  tableSchemaExt,
  tableHeaderRowSchemaExt,
  tableRowSchemaExt,
  tableHeaderSchemaExt,
  tableCellSchemaExt,
].flat();
