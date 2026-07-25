import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history as codeMirrorHistory, historyKeymap, indentWithTab } from "@codemirror/commands";
import { languages as codeMirrorLanguages } from "@codemirror/language-data";
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { StateEffect, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";

/** Default font size for a fresh code block, in px - matches the zoom
 * in/out step and clamp range in codeBlockGrips.ts, which reads/writes this
 * same `--cb-font-size` custom property per block. */
export const CODE_BLOCK_DEFAULT_FONT_SIZE = 13;

/** All languages CodeMirror ships language-data for (JS/TS, Python, Rust, Go,
 * Java, C/C++, HTML, CSS, JSON, YAML, SQL, shell, etc.) - each one's tokenizer
 * is lazy-loaded on first use, so listing the full set here doesn't cost
 * anything until a note actually picks that language from the code block's
 * language picker. */
export const codeBlockLanguages = codeMirrorLanguages;

/** A do-nothing replacement for @codemirror/search's own `scrollToMatch`
 * (default: `EditorView.scrollIntoView`) - that default walks *every*
 * scrollable ancestor, not just this block's own `.cm-scroller`, so jumping
 * to a match would also drag the note's outer page (and its scroll
 * position) around with it. codeBlockGrips.ts's SearchPopup does its own
 * scrolling instead, confined to the block itself - this just stops
 * @codemirror/search from doing its (wider-reaching) version first. */
const noOpScrollEffect = StateEffect.define<null>();

/** Editor chrome for note-embedded code blocks: fixed to a VSCode-style dark
 * theme regardless of the app's own light/midnight theme, the way GitHub,
 * Notion, and Obsidian all treat embedded code - syntax highlighting reads
 * consistently no matter what the surrounding note theme is doing. */
export const codeBlockExtensions: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  foldGutter({ openText: "⌄", closedText: "›" }),
  indentUnit.of("  "),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  codeMirrorHistory(),
  // Powers the find/replace *logic* only (query state, match highlighting,
  // findNext/replaceAll commands) - its own default panel UI is replaced by
  // a draggable popup built in codeBlockGrips.ts, since that default panel
  // (a full-width bar of text fields and case/regexp/word checkboxes) is
  // more than a note's inline code block calls for. `createPanel` still has
  // to return *something* - an empty, CSS-hidden div (see `.cm-panels` in
  // index.css) - because @codemirror/search only turns on match-highlight
  // decorations while a panel is mounted, and codeBlockGrips.ts's
  // `openSearchPanel()` call is what mounts it.
  search({
    top: true,
    createPanel: () => ({ dom: document.createElement("div") }),
    scrollToMatch: () => noOpScrollEffect.of(null),
  }),
  keymap.of([...closeBracketsKeymap, ...historyKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
  oneDark,
  EditorView.theme({
    // Fills whatever height `.milkdown-code-block` currently has (see
    // index.css) - that wrapper is what's actually `resize: both`, so this
    // just needs to track it rather than impose its own fixed size.
    // `--cb-font-size` is a per-block custom property (default unset, so it
    // falls back to the default here) - codeBlockGrips.ts's zoom in/out
    // buttons set it directly on `.milkdown-code-block`, which this
    // inherits since `.cm-editor` is a descendant of it.
    "&": { fontSize: `var(--cb-font-size, ${CODE_BLOCK_DEFAULT_FONT_SIZE}px)`, height: "100%" },
    // Long blocks (e.g. a pasted file) scroll inside the block instead of
    // pushing the rest of the note down indefinitely.
    ".cm-scroller": { lineHeight: "1.5", overflowY: "auto" },
    ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)", padding: "0.85em 0" },
    ".cm-gutters": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
    // oneDark's own `.cm-searchMatch-selected` (the current find/replace
    // match) is a *lower*-opacity version of `.cm-searchMatch` (every other
    // match) with the same blue hue and no outline - next to a block full of
    // identical-looking matches, the "current" one is the least visible of
    // the bunch rather than the most. Overridden here with a warm color that
    // reads as distinct from the cool blue given to the rest - `!important`
    // because oneDark's own rule has the same selector specificity and CM6
    // doesn't guarantee this theme's StyleModule sorts after oneDark's.
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "#ffb02e66 !important",
      outline: "1px solid #ffb02e",
    },
  }),
];
