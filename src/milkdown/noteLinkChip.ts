import { $nodeSchema, $remark } from "@milkdown/kit/utils";

/** Loose shape for the mdast nodes remark hands us - mirrors the same escape hatch used in
 * notePin.ts/imageSchemaExtensions.ts/tableSchemaExtensions.ts. */
interface MdastNode {
  type: string;
  value?: string;
  href?: string;
  linkTitle?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// Round-trips as a single self-contained HTML comment, the same sidecar shape notePin.ts uses -
// href/linkTitle are percent-encoded so neither can break out of the comment or collide with the
// `|` delimiter (encodeURIComponent never emits a literal `|` or `>`, so "-->" can't appear
// early either).
const LINK_CHIP_PATTERN = /^<!--plainotes-linkchip:([^|]*)\|(.*)-->$/;

/** Recursively swaps any `html` mdast node matching the link-chip comment for a synthetic
 * `noteLinkChip` node remark can't produce on its own - same per-node convert-in-place shape as
 * notePin.ts's processPinSidecars. */
function processLinkChipSidecars(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === "html" && typeof node.value === "string") {
      const match = LINK_CHIP_PATTERN.exec(node.value.trim());
      if (match) {
        children[i] = { type: "noteLinkChip", href: decodeURIComponent(match[1]), linkTitle: decodeURIComponent(match[2]) };
        continue;
      }
    }
    processLinkChipSidecars(node.children);
  }
}

/** Must be `.use()`d after commonmark/gfm so their remark plugins have already settled the raw
 * `html` nodes into their final flat shape - same ordering requirement as notePinRemark. */
export const noteLinkChipRemark = $remark("plainotesNoteLinkChip", () => () => (tree) => {
  processLinkChipSidecars((tree as unknown as MdastNode).children);
});

/** A read-only stand-in for a `link` mark, for the one case a mark can't cover: pasting a bare
 * note:// link (e.g. one copied via the selection toolbar's "Copy link to this point") with
 * nothing selected has no text to wrap a mark around, so it becomes this zero-content inline atom
 * instead - see the paste handling in Editor.tsx. Cmd/Ctrl-click navigates exactly like a real
 * link mark would (see noteLinkClick.ts) rather than opening a popover like notePin's own glyph -
 * this represents an *outgoing* link, not a point other notes link back to. */
export const noteLinkChipSchema = $nodeSchema("noteLinkChip", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { href: { default: "" }, linkTitle: { default: "" } },
  parseDOM: [
    {
      tag: "span[data-note-link-chip]",
      getAttrs: (dom) =>
        dom instanceof HTMLElement
          ? { href: dom.dataset.noteLinkChip || "", linkTitle: dom.dataset.linkTitle || "" }
          : {},
    },
  ],
  toDOM: (node) => [
    "span",
    {
      "data-note-link-chip": node.attrs.href as string,
      "data-link-title": node.attrs.linkTitle as string,
      class: "note-link-chip",
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === "noteLinkChip",
    runner: (state, node, type) => {
      const mdastNode = node as MdastNode;
      state.addNode(type, { href: mdastNode.href ?? "", linkTitle: mdastNode.linkTitle ?? "" });
    },
  },
  // Renders as nothing in copy-as-plain-text contexts (e.g. clipboard) - same rationale as
  // notePin.ts's leafText.
  leafText: () => "",
  toMarkdown: {
    match: (node) => node.type.name === "noteLinkChip",
    runner: (state, node) => {
      const href = encodeURIComponent(node.attrs.href as string);
      const linkTitle = encodeURIComponent(node.attrs.linkTitle as string);
      state.addNode("html", undefined, `<!--plainotes-linkchip:${href}|${linkTitle}-->`);
    },
  },
}));

export const noteLinkChipPlugins = [noteLinkChipRemark, noteLinkChipSchema].flat();
