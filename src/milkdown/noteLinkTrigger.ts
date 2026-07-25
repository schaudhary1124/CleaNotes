import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { linkSchema } from "@milkdown/kit/preset/commonmark";
import type { EditorState } from "@milkdown/kit/prose/state";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import type { RefObject } from "react";
import { buildNoteLinkHref } from "./noteLinkHref";

export interface NoteLinkTriggerChoice {
  path: string;
  title: string;
}

export interface NoteLinkTriggerInfo {
  query: string;
  coords: { left: number; top: number };
  activeIndex: number;
}

interface TriggerSpan {
  from: number;
  to: number;
  query: string;
}

interface PluginState {
  trigger: TriggerSpan | null;
  dismissedFrom: number | null;
  activeIndex: number;
}

interface TriggerMeta {
  dismiss?: boolean;
  moveActiveIndex?: number;
}

const noteLinkTriggerKey = new PluginKey<PluginState>("noteLinkTrigger");

// A stray "[[" typed ages ago and never closed shouldn't keep matching forever as the user types
// an entire paragraph after it - cap how far back the trigger can still be considered "live".
const MAX_QUERY_LENGTH = 80;

/** Finds the last unclosed "[[" before the cursor, within the current text block only (a trigger
 * can't span multiple blocks). Returns null once a "]" appears after it - either the user is
 * closing it themselves or typing something unrelated, and either way suggestions should stop. */
function findActiveTrigger(state: EditorState): TriggerSpan | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;

  const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);
  const idx = textBefore.lastIndexOf("[[");
  if (idx === -1) return null;

  const query = textBefore.slice(idx + 2);
  if (query.includes("]") || query.length > MAX_QUERY_LENGTH) return null;

  const blockStart = $from.start();
  return { from: blockStart + idx, to: blockStart + textBefore.length, query };
}

function isActiveState(pState: PluginState): pState is PluginState & { trigger: TriggerSpan } {
  return pState.trigger !== null && pState.trigger.from !== pState.dismissedFrom;
}

function applyChoice(view: EditorView, ctx: Ctx, trigger: TriggerSpan, choice: NoteLinkTriggerChoice) {
  const mark = linkSchema.type(ctx).create({ href: buildNoteLinkHref(choice.path), title: "⌘-click to open" });
  const tr = view.state.tr
    .insertText(choice.title, trigger.from, trigger.to)
    .addMark(trigger.from, trigger.from + choice.title.length, mark);
  view.dispatch(tr);
  view.focus();
}

/** Confirms the currently-active trigger with `choice` - called from Editor.tsx when the user
 * clicks a row in the floating popover. (Keyboard confirm via Enter never leaves ProseMirror's
 * own event handling - see handleKeyDown below - so it doesn't need this entry point.) */
export function confirmNoteLinkTrigger(ctx: Ctx, choice: NoteLinkTriggerChoice): void {
  const view = ctx.get(editorViewCtx);
  const pState = noteLinkTriggerKey.getState(view.state);
  if (!pState || !isActiveState(pState)) return;
  applyChoice(view, ctx, pState.trigger, choice);
}

interface NoteLinkTriggerPluginOptions {
  /** Called whenever the trigger's active/query/highlighted-row state changes, and with null once
   * it's no longer active - Editor.tsx shows (or hides) the floating popover from this. */
  onTriggerChange: (info: NoteLinkTriggerInfo | null) => void;
  /** Editor.tsx keeps this updated with the note list filtered for the trigger's current query, so
   * ArrowUp/ArrowDown/Enter here can read it synchronously without a second round-trip callback. */
  resultsRef: RefObject<NoteLinkTriggerChoice[]>;
}

/** The `[[` live autocomplete trigger: typing `[[` opens a note picker (rendered by Editor.tsx)
 * filtered as the user keeps typing, with Arrow/Enter/Escape handled here so they don't leak into
 * normal editing. Deliberately note-level only (no heading sub-stage, unlike the toolbar/modal
 * picker) - keeps this plugin's keyboard handling to a single stage; heading precision stays
 * reachable via the toolbar for links that need it. */
export function noteLinkTriggerPlugin({ onTriggerChange, resultsRef }: NoteLinkTriggerPluginOptions) {
  return $prose((ctx) => {
    let lastSignature = "";

    return new Plugin<PluginState>({
      key: noteLinkTriggerKey,
      state: {
        init: () => ({ trigger: null, dismissedFrom: null, activeIndex: 0 }),
        apply(tr, prev, _oldState, newState) {
          const trigger = findActiveTrigger(newState);
          if (!trigger) return { trigger: null, dismissedFrom: null, activeIndex: 0 };

          const meta = tr.getMeta(noteLinkTriggerKey) as TriggerMeta | undefined;
          const sameSpan = prev.trigger?.from === trigger.from;

          const dismissedFrom = meta?.dismiss ? trigger.from : sameSpan ? prev.dismissedFrom : null;

          let activeIndex = sameSpan && prev.trigger?.query === trigger.query ? prev.activeIndex : 0;
          if (meta?.moveActiveIndex) {
            const count = resultsRef.current.length;
            activeIndex = count === 0 ? 0 : (((activeIndex + meta.moveActiveIndex) % count) + count) % count;
          }

          return { trigger, dismissedFrom, activeIndex };
        },
      },
      props: {
        decorations(state) {
          const pState = noteLinkTriggerKey.getState(state);
          if (!pState || !isActiveState(pState)) return null;
          return DecorationSet.create(state.doc, [
            Decoration.inline(pState.trigger.from, pState.trigger.to, { class: "note-link-trigger-pending" }),
          ]);
        },
        handleKeyDown(view, event) {
          const pState = noteLinkTriggerKey.getState(view.state);
          if (!pState || !isActiveState(pState)) return false;

          if (event.key === "Escape") {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(noteLinkTriggerKey, { dismiss: true }));
            return true;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(noteLinkTriggerKey, { moveActiveIndex: 1 }));
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(noteLinkTriggerKey, { moveActiveIndex: -1 }));
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const choice = resultsRef.current[pState.activeIndex];
            if (!choice) return false;
            event.preventDefault();
            applyChoice(view, ctx, pState.trigger, choice);
            return true;
          }
          return false;
        },
      },
      view: () => ({
        update(view) {
          const pState = noteLinkTriggerKey.getState(view.state);
          if (!pState) return;
          const active = isActiveState(pState);
          const signature = active ? `${pState.trigger.from}:${pState.trigger.to}:${pState.activeIndex}` : "";
          if (signature === lastSignature) return;
          lastSignature = signature;

          if (!active) {
            onTriggerChange(null);
            return;
          }
          const coords = view.coordsAtPos(pState.trigger.from);
          onTriggerChange({
            query: pState.trigger.query,
            coords: { left: coords.left, top: coords.bottom },
            activeIndex: pState.activeIndex,
          });
        },
      }),
    });
  });
}
