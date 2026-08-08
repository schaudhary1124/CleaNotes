import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Search, WrapText, ZoomIn, ZoomOut } from "lucide-react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import {
  CODE_BLOCK_DEFAULT_FONT_SIZE,
  codeBlockExtensions,
  codeBlockLanguages,
} from "../../milkdown/codeBlock";
import type { CodeElement } from "../boardTypes";

/** A free-floating code block on the board.
 *
 * Reuses the exact CodeMirror configuration note-embedded code blocks already use
 * (`codeBlockExtensions` / `codeBlockLanguages` from milkdown/codeBlock.ts) rather than assembling
 * a second one, so a code block looks and behaves identically whether it's in a note or on a board
 * - same dark theme, same keymap, same lazily-loaded language set - and the chrome around it offers
 * the same things codeBlockGrips.ts hangs off a note's block: copy, font zoom, and find/replace.
 * Delete and "expand to fill" are the two the board deliberately doesn't repeat, because the canvas
 * already answers both far better than a button could (select and press Delete; drag the resize
 * handles).
 *
 * The editor is created once and kept alive across re-renders. Recreating it on every prop change
 * would drop cursor position and undo history on each keystroke, since `code` round-trips through
 * the board document; instead, external changes are pushed in as transactions and only when the
 * incoming value genuinely differs from what CodeMirror already holds. Language and wrapping are
 * swapped through Compartments for the same reason - reconfiguring an extension rather than
 * rebuilding the editor around it. */

/** Font-size range for the zoom controls, matching codeBlockGrips.ts's clamp on the note side so a
 * code block can't be zoomed anywhere on a board it couldn't be zoomed to in a note. */
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 28;
const FONT_STEP = 1;

/** How long the copy button shows its checkmark before reverting - same dwell codeBlockGrips.ts
 * uses, so the two code blocks acknowledge a copy identically. */
const COPY_FEEDBACK_MS = 1400;

/** Stops counting matches past this many. A find in a long block is answered by "lots", not by an
 * exact number, and walking every match on every keystroke of the query is the one part of
 * find-as-you-type that can actually be felt. */
const MAX_COUNTED_MATCHES = 999;

export function CodeWidget({
  element,
  editable,
  onChange,
}: {
  element: CodeElement;
  /** False while the board is in a non-select tool (or the element is locked, or it simply isn't
   * the element being edited) - the widget must not swallow pointer events meant for
   * drawing/panning over the top of it. */
  editable: boolean;
  onChange: (patch: Partial<CodeElement>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const appearanceCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const fontSize = element.fontSize ?? CODE_BLOCK_DEFAULT_FONT_SIZE;

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
          appearanceCompartment.current.of([]),
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
    const description = findLanguage(element.language);
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

  // Wrapping is an extension, so it goes through a compartment. Font size deliberately does *not*:
  // codeBlockExtensions' theme already sizes the editor from a `--cb-font-size` custom property
  // (that is exactly how codeBlockGrips.ts zooms a note's block), so setting that property on the
  // widget's own element is both simpler and immune to which of two competing themes CodeMirror
  // happens to sort last.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: appearanceCompartment.current.reconfigure(element.wrap ? EditorView.lineWrapping : []),
    });
  }, [element.wrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === element.code) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: element.code } });
  }, [element.code]);

  // A widget that stops being live keeps neither of its transient popups open - otherwise a menu
  // left open sits on a click-through element, visible but unreachable.
  useEffect(() => {
    if (editable) return;
    setMenuOpen(false);
    setSearchOpen(false);
  }, [editable]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  function zoom(delta: number) {
    onChange({ fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSize + delta)) });
  }

  function copyCode() {
    void navigator.clipboard.writeText(element.code).then(
      () => setCopied(true),
      () => {
        // A denied clipboard is not worth an error surface on a whiteboard - the button simply
        // doesn't acknowledge, which reads as "that didn't work".
      },
    );
  }

  return (
    <>
      <div
        className="board-code-widget"
        // Read by codeBlockExtensions' own theme (`font-size: var(--cb-font-size, …)`), which the
        // editor inherits as a descendant - see the appearance effect above.
        style={{ "--cb-font-size": `${fontSize}px` } as React.CSSProperties}
      >
        <div className="board-widget-bar">
          <button
            type="button"
            className="board-widget-chip board-widget-chip-wide"
            data-board-menu-toggle
            onClick={() => setMenuOpen((open) => !open)}
            disabled={!editable}
            title="Change language"
          >
            {element.language || "plain text"}
            <ChevronDown size={10} />
          </button>

          <div className="board-widget-bar-end">
            <button
              type="button"
              className={`board-widget-icon ${element.wrap ? "is-on" : ""}`}
              onClick={() => onChange({ wrap: element.wrap ? undefined : true })}
              disabled={!editable}
              title={element.wrap ? "Stop wrapping long lines" : "Wrap long lines"}
            >
              <WrapText size={13} />
            </button>
            <button
              type="button"
              className="board-widget-icon"
              onClick={() => zoom(-FONT_STEP)}
              disabled={!editable || fontSize <= MIN_FONT_SIZE}
              title="Smaller text"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              className="board-widget-icon"
              onClick={() => zoom(FONT_STEP)}
              disabled={!editable || fontSize >= MAX_FONT_SIZE}
              title="Larger text"
            >
              <ZoomIn size={13} />
            </button>
            <button
              type="button"
              className={`board-widget-icon ${searchOpen ? "is-on" : ""}`}
              onClick={() => setSearchOpen((open) => !open)}
              disabled={!editable}
              title="Find and replace"
            >
              <Search size={13} />
            </button>
            <button
              type="button"
              className={`board-widget-icon ${copied ? "is-done" : ""}`}
              onClick={copyCode}
              disabled={!editable}
              title="Copy code"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>

        {searchOpen && <SearchBar viewRef={viewRef} onClose={() => setSearchOpen(false)} />}

        <div
          ref={hostRef}
          className="board-code-host"
          style={{ pointerEvents: editable ? "auto" : "none" }}
          // ⌘F from inside the editor opens *this* bar. codeBlockExtensions' searchKeymap already
          // binds the key, but only to `openSearchPanel`, whose panel is a deliberately empty stub
          // (see codeBlock.ts) - so without this the shortcut silently does nothing visible. The
          // keystroke still reaches here because CodeMirror's keymap preventDefaults it rather than
          // stopping it propagating.
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") setSearchOpen(true);
          }}
        />
      </div>

      {/* Outside the widget box, which clips its own overflow so the editor scrolls inside it - a
          dropdown rendered within it would be cut off at that same edge. */}
      {menuOpen && editable && (
        <LanguageMenu
          current={element.language}
          onPick={(language) => {
            onChange({ language });
            setMenuOpen(false);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}

/** The language picker.
 *
 * Filtered rather than a bare list, which is the one thing the note-side picker gets for free from
 * being a short menu and this one can't: `codeBlockLanguages` is CodeMirror's full language-data
 * set, ~150 entries, and scrolling it inside a widget the size of a code block on a canvas is a
 * genuinely bad way to reach "rust". Aliases are searched alongside names, so "js", "ts" and "c++"
 * all find what the user means even though none of them is what the entry is called. */
function LanguageMenu({
  current,
  onPick,
  onClose,
}: {
  current: string;
  onPick: (language: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on any press outside the menu, including one landing on the canvas behind the widget -
  // the board's own pointer handling never sees that press as "close this", since it has no idea
  // the menu exists. The chip that opened the menu is exempt: it toggles on *click*, which lands
  // after this pointerdown, so closing here would let that toggle immediately reopen it.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (hostRef.current?.contains(target) || target?.closest("[data-board-menu-toggle]")) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const matches = useMemo(() => {
    const names = ["plain text", ...codeBlockLanguages.map((lang) => lang.name)];
    const needle = query.trim().toLowerCase();
    if (!needle) return names;
    return names.filter((name) => {
      if (name.toLowerCase().includes(needle)) return true;
      const description = codeBlockLanguages.find((lang) => lang.name === name);
      return description?.alias.some((alias) => alias.includes(needle)) ?? false;
    });
  }, [query]);

  return (
    <div className="board-widget-menu" ref={hostRef}>
      <input
        ref={inputRef}
        className="board-widget-menu-search"
        value={query}
        placeholder="Search languages…"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          // Enter takes the top match, so a language can be set without ever leaving the keyboard.
          else if (e.key === "Enter" && matches.length > 0) onPick(languageValue(matches[0]));
        }}
      />
      <div className="board-widget-menu-list">
        {matches.length === 0 && <div className="board-widget-menu-empty">No match</div>}
        {matches.map((name) => (
          <button
            key={name}
            type="button"
            className={`board-widget-menu-item ${isCurrent(name, current) ? "is-on" : ""}`}
            onClick={() => onPick(languageValue(name))}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "plain text" is the menu's label for *no* language, which is stored as an empty string. */
function languageValue(name: string): string {
  return name === "plain text" ? "" : name;
}

function isCurrent(name: string, current: string): boolean {
  return name === "plain text" ? current === "" : name === current;
}

function findLanguage(language: string) {
  const needle = language.toLowerCase();
  return codeBlockLanguages.find(
    (lang) => lang.name.toLowerCase() === needle || lang.alias.includes(needle),
  );
}

/** Find and replace over the block's own CodeMirror.
 *
 * Drives @codemirror/search's commands directly, exactly as codeBlockGrips.ts's popup does on the
 * note side - the extension's own panel UI is deliberately stubbed out in codeBlock.ts, so the
 * `openSearchPanel` call below exists purely to switch on match-highlight decorations, which the
 * extension only applies while *some* panel is mounted.
 *
 * Rendered as a bar under the widget's toolbar rather than as a floating popup: a board element is
 * already a free-floating box the user placed, and a second floating thing anchored to it would
 * need its own repositioning against pan, zoom and the element's own drag. */
function SearchBar({
  viewRef,
  onClose,
}: {
  viewRef: React.RefObject<EditorView | null>;
  onClose: () => void;
}) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [count, setCount] = useState<{ current: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    inputRef.current?.focus();
    openSearchPanel(view);
    return () => {
      // Leaving the panel mounted would keep every match highlighted after the bar is gone - the
      // extension only decorates matches while one is up, which is the whole reason it was opened.
      const current = viewRef.current;
      if (!current) return;
      current.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      closeSearchPanel(current);
    };
  }, [viewRef]);

  /** Pushes the current query into CodeMirror and refreshes the count.
   *
   * `selectFirstMatch` is true only when the *find* text changed: `replaceNext` only replaces a
   * match the selection is already sitting on, so without jumping to one as the query is typed the
   * Replace button would silently do nothing on its first press (the same trap codeBlockGrips.ts
   * documents). Editing the *replacement* text must not move the selection, or Replace would keep
   * jumping off whatever match Next just landed on. */
  function commitQuery(nextFind: string, nextReplace: string, selectFirstMatch: boolean) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: nextFind, replace: nextReplace })),
    });
    if (selectFirstMatch && nextFind) findNext(view);
    refreshCount();
  }

  function refreshCount() {
    const view = viewRef.current;
    if (!view) return setCount(null);
    const query = getSearchQuery(view.state);
    if (!query.search) return setCount(null);
    setCount(matchStats(view, query));
  }

  function run(command: (view: EditorView) => boolean) {
    const view = viewRef.current;
    if (!view) return;
    command(view);
    refreshCount();
  }

  return (
    <div className="board-code-search">
      <input
        ref={inputRef}
        className="board-code-search-input"
        value={find}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => {
          setFind(e.target.value);
          commitQuery(e.target.value, replace, true);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            run(e.shiftKey ? findPrevious : findNext);
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <span className="board-code-search-count">
        {count === null
          ? ""
          : count.total === 0
            ? "None"
            : `${count.current || 1}/${count.total}${count.total > MAX_COUNTED_MATCHES ? "+" : ""}`}
      </span>
      <button type="button" className="board-widget-icon" onClick={() => run(findPrevious)} title="Previous match">
        ‹
      </button>
      <button type="button" className="board-widget-icon" onClick={() => run(findNext)} title="Next match">
        ›
      </button>
      <input
        className="board-code-search-input"
        value={replace}
        placeholder="Replace"
        spellCheck={false}
        onChange={(e) => {
          setReplace(e.target.value);
          commitQuery(find, e.target.value, false);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            run(replaceNext);
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <button type="button" className="board-widget-chip" onClick={() => run(replaceNext)} title="Replace this match">
        Replace
      </button>
      <button type="button" className="board-widget-chip" onClick={() => run(replaceAll)} title="Replace every match">
        All
      </button>
      <button type="button" className="board-widget-icon" onClick={onClose} title="Close find and replace">
        ×
      </button>
    </div>
  );
}

/** How many matches the query has, and which one the selection is currently on (0 if none - which
 * is the honest answer right after a replace, when the selection sits on replacement text rather
 * than on a match). */
function matchStats(view: EditorView, query: SearchQuery): { current: number; total: number } {
  if (!query.search) return { current: 0, total: 0 };
  const { from, to } = view.state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(view.state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (next.value.from === from && next.value.to === to) current = total;
    if (total > MAX_COUNTED_MATCHES) break;
  }
  return { current, total };
}
