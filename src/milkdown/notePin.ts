import { $nodeSchema, $remark } from "@milkdown/kit/utils";

/** Loose shape for the mdast nodes remark hands us - mirrors the same escape hatch used in
 * imageSchemaExtensions.ts/tableSchemaExtensions.ts. */
interface MdastNode {
  type: string;
  value?: string;
  id?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// A pin round-trips as a single self-contained HTML comment, the same sidecar shape
// imageSchemaExtensions.ts uses for its `<!--plainotes-image:...-->` - unlike the
// highlight/underline/strikethrough marks in textDecorationMarks.ts, there's no open/close pair to
// scan for since the pin has no content of its own to wrap.
const PIN_PATTERN = /^<!--plainotes-pin:([a-zA-Z0-9-]+)-->$/;

/** Recursively swaps any `html` mdast node matching the pin comment for a synthetic `notePin`
 * node remark can't produce on its own - same per-node convert-in-place shape as
 * processImageWrapSidecars, just simpler (one node in, one node out - no adjacent sidecar to
 * splice away). */
function processPinSidecars(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === "html" && typeof node.value === "string") {
      const match = PIN_PATTERN.exec(node.value.trim());
      if (match) {
        children[i] = { type: "notePin", id: match[1] };
        continue;
      }
    }
    processPinSidecars(node.children);
  }
}

/** Must be `.use()`d after commonmark/gfm so their remark plugins have already settled the raw
 * `html` nodes into their final flat shape - same ordering requirement as
 * imageWrapSidecarRemark/tableSidecarRemark. */
export const notePinRemark = $remark("plainotesNotePin", () => () => (tree) => {
  processPinSidecars((tree as unknown as MdastNode).children);
});

/** A "point" the user planted in a note via the selection toolbar's "Copy link to this point" -
 * a zero-content inline atom, not a mark, so it's addressable by its own stable id
 * (`note-pin-<id>`, stamped on in notePinView.ts) the same way a heading is, and deletable as a
 * single unit via Backspace/Delete like any other atom node (image, hardbreak). `selectable` so
 * clicking it (outside notePinView.ts's own click handling) still gives it a NodeSelection rather
 * than falling through to the nearest text position. */
export const notePinSchema = $nodeSchema("notePin", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { id: { default: "" } },
  parseDOM: [
    {
      tag: "span[data-note-pin]",
      getAttrs: (dom) => ({ id: (dom instanceof HTMLElement && dom.dataset.notePin) || "" }),
    },
  ],
  toDOM: (node) => ["span", { "data-note-pin": node.attrs.id as string, class: "note-pin" }],
  parseMarkdown: {
    match: (node) => node.type === "notePin",
    runner: (state, node, type) => {
      const mdastNode = node as MdastNode;
      state.addNode(type, { id: mdastNode.id ?? "" });
    },
  },
  // Renders as nothing in copy-as-plain-text contexts (e.g. clipboard) - it's a navigation
  // marker, not content.
  leafText: () => "",
  toMarkdown: {
    match: (node) => node.type.name === "notePin",
    runner: (state, node) => {
      state.addNode("html", undefined, `<!--plainotes-pin:${node.attrs.id as string}-->`);
    },
  },
}));

export const notePinPlugins = [notePinRemark, notePinSchema].flat();
