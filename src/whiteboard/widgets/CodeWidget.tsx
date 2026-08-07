import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { codeBlockExtensions, codeBlockLanguages } from "../../milkdown/codeBlock";
import type { CodeElement } from "../boardTypes";

/** A free-floating code block on the board.
 *
 * Reuses the exact CodeMirror configuration note-embedded code blocks already use
 * (`codeBlockExtensions` / `codeBlockLanguages` from milkdown/codeBlock.ts) rather than assembling
 * a second one, so a code block looks and behaves identically whether it's in a note or on a board
 * - same dark theme, same keymap, same lazily-loaded language set.
 *
 * The editor is created once and kept alive across re-renders. Recreating it on every prop change
 * would drop cursor position and undo history on each keystroke, since `code` round-trips through
 * the board document; instead, external changes are pushed in as transactions and only when the
 * incoming value genuinely differs from what CodeMirror already holds. */
export function CodeWidget({
  element,
  editable,
  onChange,
}: {
  element: CodeElement;
  /** False while the board is in a non-select tool (or the element is locked) - the widget must
   * not swallow pointer events meant for drawing/panning over the top of it. */
  editable: boolean;
  onChange: (patch: Partial<CodeElement>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: element.code,
        extensions: [
          ...codeBlockExtensions,
          languageCompartment.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current({ code: update.state.doc.toString() });
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally mount-only: `element.code` seeds the initial document and is thereafter
    // synced by the effect below, and re-running this would destroy/recreate the editor (losing
    // selection and undo history) on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Language is swapped through a Compartment rather than by rebuilding the editor, and the
  // tokenizer is loaded lazily - `codeBlockLanguages` entries only fetch their parser on `load()`.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    const description = codeBlockLanguages.find(
      (lang) =>
        lang.name.toLowerCase() === element.language.toLowerCase() ||
        lang.alias.includes(element.language.toLowerCase()),
    );
    if (!description) {
      view.dispatch({ effects: languageCompartment.current.reconfigure([]) });
      return;
    }
    void description.load().then((support) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({ effects: languageCompartment.current.reconfigure(support) });
    });
    return () => {
      cancelled = true;
    };
  }, [element.language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === element.code) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: element.code } });
  }, [element.code]);

  return (
    <div className="board-code-widget">
      <div className="board-widget-bar">
        <button
          type="button"
          className="board-widget-chip"
          onClick={() => setMenuOpen((open) => !open)}
          disabled={!editable}
          title="Change language"
        >
          {element.language || "plain text"}
        </button>
        {menuOpen && (
          <div className="board-widget-menu">
            {["plain text", ...codeBlockLanguages.map((lang) => lang.name)].map((name) => (
              <button
                key={name}
                type="button"
                className="board-widget-menu-item"
                onClick={() => {
                  onChange({ language: name === "plain text" ? "" : name });
                  setMenuOpen(false);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        ref={hostRef}
        className="board-code-host"
        style={{ pointerEvents: editable ? "auto" : "none" }}
      />
    </div>
  );
}
