import { $nodeSchema, $remark } from "@milkdown/kit/utils";

/** Loose shape for the mdast nodes remark hands us - mirrors the same escape hatch used in
 * notePin.ts/imageSchemaExtensions.ts. */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// A page break round-trips as a single self-contained HTML comment, the same sidecar shape
// notePin.ts uses for `<!--plainotes-pin:...-->` - no content of its own to wrap. Keeps the
// trailing `:` (even with nothing meaningful after it) so sidecarComments.ts's
// ANY_SIDECAR_PATTERN recognizes it as a skippable sidecar for *other* features' backward scans
// (findSidecarOwner) - see voiceNoteSchemaExtensions.ts's own comment on why the "kind" segment
// must be a single lowercase word followed by a colon.
const PAGE_BREAK_PATTERN = /^<!--plainotes-pagebreak:-->$/;

/** Recursively swaps any `html` mdast node matching the page-break comment for a synthetic
 * `pageBreak` node remark can't produce on its own - same per-node convert-in-place shape as
 * notePin.ts's processPinSidecars. */
function processPageBreakSidecars(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === "html" && typeof node.value === "string" && PAGE_BREAK_PATTERN.test(node.value.trim())) {
      children[i] = { type: "pageBreak" };
      continue;
    }
    processPageBreakSidecars(node.children);
  }
}

/** Must be `.use()`d after commonmark/gfm so their remark plugins have already settled the raw
 * `html` nodes into their final flat shape - same ordering requirement as notePinRemark. */
export const pageBreakRemark = $remark("plainotesPageBreak", () => () => (tree) => {
  processPageBreakSidecars((tree as unknown as MdastNode).children);
});

/** An explicit "force a new page here" marker for Fixed-Size notes (see Editor.tsx's
 * `pagination` prop) - a zero-content block atom, deletable as a single unit via Backspace/
 * Delete like any other atom (image, notePin) once selected, no custom delete affordance
 * needed. Registered unconditionally (not gated on kind) in registerMilkdownPlugins so it still
 * round-trips correctly even if it ends up in a non-Fixed-Size note (e.g. pasted content) -
 * only the toolbar action that *inserts* one is gated on the pagination prop being present. */
export const pageBreakSchema = $nodeSchema("pageBreak", () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  parseDOM: [{ tag: "div[data-page-break]" }],
  toDOM: () => [
    "div",
    { "data-page-break": "true", class: "page-break", contenteditable: "false" },
    ["span", { class: "page-break-label" }, "Page break"],
  ],
  parseMarkdown: {
    match: (node) => node.type === "pageBreak",
    runner: (state, _node, type) => {
      state.addNode(type);
    },
  },
  // Renders as nothing in copy-as-plain-text contexts (e.g. clipboard) - it's a layout marker,
  // not content, same reasoning as notePin.ts's identical leafText.
  leafText: () => "",
  toMarkdown: {
    match: (node) => node.type.name === "pageBreak",
    runner: (state) => {
      state.addNode("html", undefined, "<!--plainotes-pagebreak:-->");
    },
  },
}));

export const pageBreakPlugins = [pageBreakRemark, pageBreakSchema].flat();
