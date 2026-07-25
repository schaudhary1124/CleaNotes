import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $view } from "@milkdown/kit/utils";
import { notePinSchema } from "./notePin";

// Lucide's "map-pin" path data, inlined the same way codeBlockGrips.ts inlines its own icons
// (COPY_ICON/CHECK_ICON) - a NodeView renders raw DOM, not React, so the lucide-react component
// itself isn't usable here.
const MAP_PIN_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>';

/** Fired (bubbling) whenever a pin glyph is clicked, so Editor.tsx - which has no direct
 * reference to any one NodeView - can open its popover. Same NodeView -> React bridge imageView.ts
 * uses for IMAGE_CROP_CHANGED_EVENT. */
export const NOTE_PIN_CLICKED_EVENT = "plainotes:note-pin-clicked";

export interface NotePinClickedDetail {
  id: string;
  /** The pin's own DOM node, so the popover can anchor to it (via ToolbarPopover.tsx) the same
   * live, reposition-on-scroll way every other toolbar popover in the editor does - a snapshot
   * rect alone can't do that. */
  element: HTMLElement;
  /** Removes this exact pin node from the doc. A live callback (reading `getPos()` fresh) rather
   * than a position captured at click time, since the doc may have changed by the time the
   * popover's Remove button is actually pressed. */
  remove: () => void;
}

/** NodeView for the `notePin` atom (see notePin.ts): a small clickable glyph with a stable DOM id
 * (`note-pin-<id>`) - the same "real id lands on the rendered element" trick Milkdown's own
 * heading id generator uses, and what lets navigation reuse plain `document.getElementById`
 * (see App.tsx's handleNavigateToNoteLink) instead of needing its own resolution mechanism. */
class NotePinNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private view: EditorView;
  private getPos: () => number | undefined;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("span");
    this.dom.className = "note-pin";
    this.dom.contentEditable = "false";
    this.dom.innerHTML = MAP_PIN_ICON;
    this.dom.title = "Linked point - click for details";
    this.applyId(node);

    // Same fix codeBlockGrips.ts's makeButton applies to its own buttons: without this, the
    // mousedown alone shifts focus/selection away from the editor before `click` ever fires.
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());
    this.dom.addEventListener("click", this.onClick);
  }

  private applyId(node: ProseNode) {
    this.dom.id = `note-pin-${node.attrs.id as string}`;
  }

  private onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.view.dom.dispatchEvent(
      new CustomEvent(NOTE_PIN_CLICKED_EVENT, {
        detail: { id: this.node.attrs.id as string, element: this.dom, remove: this.remove } satisfies NotePinClickedDetail,
        bubbles: true,
      }),
    );
  };

  private remove = () => {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.applyId(node);
    return true;
  }

  destroy() {
    this.dom.removeEventListener("click", this.onClick);
  }
}

export const notePinView = $view(notePinSchema.node, () => {
  return ((node, view, getPos) => new NotePinNodeView(node, view, getPos)) as NodeViewConstructor;
});
