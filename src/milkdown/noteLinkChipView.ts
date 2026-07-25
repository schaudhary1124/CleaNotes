import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $view } from "@milkdown/kit/utils";
import { noteLinkChipSchema } from "./noteLinkChip";
import { LINK_CLICKED_EVENT, openLinkHref, type LinkClickedDetail } from "./noteLinkClick";
import type { NoteLinkTarget } from "./noteLinkHref";

// Lucide's "link" path data, inlined the same way notePinView.ts inlines its own "map-pin" icon -
// deliberately a different glyph so a pasted link chip reads as "points away from here" at a
// glance, distinct from a pin's "other notes point back to here".
const LINK_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

/** NodeView for the `noteLinkChip` atom (see noteLinkChip.ts): a small inline glyph standing in
 * for a `link` mark with no text of its own to be applied to. A plain click opens the same
 * LinkPopover a text link's click opens (see noteLinkClick.ts/SelectionLinkToolbar.tsx) - both
 * fire LINK_CLICKED_EVENT so Editor.tsx only needs one popover/listener for both link shapes.
 * Cmd/Ctrl-click is kept as a fast path straight past the popover, mirroring noteLinkClickPlugin's
 * own fast path for real link marks exactly. */
class NoteLinkChipNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private onNavigate: (target: NoteLinkTarget) => void;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined, onNavigate: (target: NoteLinkTarget) => void) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.onNavigate = onNavigate;

    this.dom = document.createElement("span");
    this.dom.className = "note-link-chip";
    this.dom.contentEditable = "false";
    this.dom.innerHTML = LINK_ICON;
    this.applyTitle(node);

    // Same fix codeBlockGrips.ts's makeButton/notePinView.ts apply to their own clickables:
    // without this, the mousedown alone shifts focus/selection before `click` ever fires.
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());
    this.dom.addEventListener("click", this.onClick);
  }

  private applyTitle(node: ProseNode) {
    this.dom.title = (node.attrs.linkTitle as string) || "Click for link options";
  }

  private onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.metaKey || event.ctrlKey) {
      openLinkHref(this.node.attrs.href as string, this.onNavigate);
      return;
    }

    this.dom.dispatchEvent(
      new CustomEvent(LINK_CLICKED_EVENT, {
        detail: {
          href: this.node.attrs.href as string,
          markTitle: (this.node.attrs.linkTitle as string) ?? "",
          element: this.dom,
          remove: this.remove,
          applyEdit: this.applyEdit,
        } satisfies LinkClickedDetail,
        bubbles: true,
      }),
    );
  };

  private remove = () => {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
  };

  private applyEdit = (href: string, linkTitle: string) => {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { href, linkTitle }));
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.applyTitle(node);
    return true;
  }

  destroy() {
    this.dom.removeEventListener("click", this.onClick);
  }
}

export function noteLinkChipView(onNavigate: (target: NoteLinkTarget) => void) {
  return $view(noteLinkChipSchema.node, () => {
    return ((node, view, getPos) => new NoteLinkChipNodeView(node, view, getPos, onNavigate)) as NodeViewConstructor;
  });
}
