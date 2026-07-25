import { linkSchema } from "@milkdown/kit/preset/commonmark";
import type { Mark, MarkType, ResolvedPos } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseNoteLinkHref, type NoteLinkTarget } from "./noteLinkHref";

/** Fired (bubbling) on a plain click inside a `link`-marked text run, so Editor.tsx - which owns
 * the popover's React state - can show LinkPopover (see SelectionLinkToolbar.tsx). The same event
 * doubles for the `noteLinkChip` atom's own plain-click handling (see noteLinkChipView.ts), so
 * Editor.tsx only needs one popover/listener for both link shapes. */
export const LINK_CLICKED_EVENT = "plainotes:link-clicked";

export interface LinkClickedDetail {
  href: string;
  markTitle: string;
  /** The clicked link's own DOM node, so the popover can anchor to it - same live,
   * reposition-on-scroll anchoring every other toolbar popover in the editor uses. */
  element: HTMLElement;
  /** Removes the link - unlinks (keeps the text) for a mark, deletes the glyph for a chip. */
  remove: () => void;
  /** Repoints the link at a new href/title, in place. */
  applyEdit: (href: string, markTitle: string) => void;
}

/** Resolves an href the same way for every "open this link" entry point in the editor: an
 * internal `note://` href navigates in-app, anything else opens in the system browser. Exported
 * so noteLinkChipView.ts's own Cmd/Ctrl-click fast path and LinkPopover's "Open" button (see
 * Editor.tsx) resolve a click identically to this plugin's Cmd/Ctrl-click below. */
export function openLinkHref(href: string, onNavigate: (target: NoteLinkTarget) => void) {
  const target = parseNoteLinkHref(href);
  if (target) onNavigate(target);
  else openUrl(href).catch(() => {});
}

/** The `link` mark's full extent around `$pos` - adjacent text runs carrying an *identical* mark
 * (same type + attrs, per `Mark.eq`) merge into one range, matching ProseMirror's own mark
 * semantics. Standard "get mark range" helper (same shape as the one in prosemirror-utils),
 * needed because a mark itself doesn't know its own bounds - only the doc position it's read at
 * does. */
function getMarkRange($pos: ResolvedPos, type: MarkType): { from: number; to: number; mark: Mark } | null {
  const start = $pos.parent.childAfter($pos.parentOffset);
  if (!start.node) return null;
  const mark = type.isInSet(start.node.marks);
  if (!mark) return null;

  let startIndex = $pos.index();
  let startPos = $pos.start() + start.offset;
  let endIndex = startIndex + 1;
  let endPos = startPos + start.node.nodeSize;
  while (startIndex > 0 && mark.isInSet($pos.parent.child(startIndex - 1).marks)) {
    startIndex -= 1;
    startPos -= $pos.parent.child(startIndex).nodeSize;
  }
  while (endIndex < $pos.parent.childCount && mark.isInSet($pos.parent.child(endIndex).marks)) {
    endPos += $pos.parent.child(endIndex).nodeSize;
    endIndex += 1;
  }
  return { from: startPos, to: endPos, mark };
}

/** A plain click on a `link`-marked run opens LinkPopover instead of just placing the cursor -
 * the Google Docs "click a link, get a small options card" convention. Cmd/Ctrl-click is kept as
 * a fast path straight past the popover, and is now also the only way to land a cursor inside a
 * link's own text (e.g. to fix a typo) without the popover intercepting the click - editing the
 * underlying text isn't one of the popover's own actions. */
export function noteLinkClickPlugin(onNavigate: (target: NoteLinkTarget) => void) {
  return $prose((ctx) => {
    const markType = linkSchema.type(ctx);
    return new Plugin({
      props: {
        handleClick(view: EditorView, pos: number, event: MouseEvent) {
          const range = getMarkRange(view.state.doc.resolve(pos), markType);
          if (!range) return false;
          const { from, to, mark } = range;
          const href = mark.attrs.href as string;

          if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            openLinkHref(href, onNavigate);
            return true;
          }

          event.preventDefault();
          const anchorEl = event.target instanceof HTMLElement ? event.target.closest("a") : null;
          view.dom.dispatchEvent(
            new CustomEvent(LINK_CLICKED_EVENT, {
              detail: {
                href,
                markTitle: (mark.attrs.title as string) ?? "",
                element: (anchorEl ?? event.target) as HTMLElement,
                remove: () => view.dispatch(view.state.tr.removeMark(from, to, markType)),
                applyEdit: (nextHref: string, nextTitle: string) =>
                  view.dispatch(view.state.tr.addMark(from, to, markType.create({ href: nextHref, title: nextTitle }))),
              } satisfies LinkClickedDetail,
              bubbles: true,
            }),
          );
          return true;
        },
      },
    });
  });
}
