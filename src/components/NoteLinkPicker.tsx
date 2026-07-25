import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Globe, Hash } from "lucide-react";
import { readNote } from "../utils/fsNotes";
import { predictHeadingSlugs, type HeadingSlug } from "../utils/headingSlug";
import {
  buildNoteLinkHref,
  describeNoteLinkTarget,
  looksLikeExternalUrl,
  normalizeExternalUrl,
  parseNoteLinkHref,
} from "../milkdown/noteLinkHref";

export interface NoteLinkChoice {
  path: string;
  title: string;
  parentPath: string;
}

const MAX_RESULTS = 30;

/** Title-prefix matches first (typing a note's name should surface it immediately), then plain
 * substring matches, both capped so a large vault doesn't render an unbounded list. Exported so
 * the `[[` inline trigger (see noteLinkTrigger.ts/Editor.tsx) can filter the same way without
 * duplicating the ranking logic. */
export function filterNoteChoices(notes: NoteLinkChoice[], query: string): NoteLinkChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes.slice(0, MAX_RESULTS);
  return notes
    .filter((n) => n.title.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.title.length - b.title.length;
    })
    .slice(0, MAX_RESULTS);
}

interface NoteLinkResultsListProps {
  results: NoteLinkChoice[];
  activeIndex: number;
  onHoverIndex: (i: number) => void;
  onChoose: (choice: NoteLinkChoice) => void;
  /** Renders a per-row "link to a heading" affordance when provided - the toolbar/modal entry
   * point wants this, the `[[` inline trigger doesn't (see its own scope note in the plan: it
   * stays note-level only, to keep its keyboard handling to a single stage). */
  onRequestHeadings?: (choice: NoteLinkChoice) => void;
  emptyMessage?: string;
}

/** The filtered result rows themselves, with no opinion on where the query/activeIndex come from
 * - the search popovers own the query locally (see NoteLinkPickerBody below), while the `[[`
 * inline popover (see Editor.tsx) drives them from the ProseMirror plugin's own state instead,
 * since there's no separate `<input>` there - the query is whatever's typed in the doc itself. */
export function NoteLinkResultsList({
  results,
  activeIndex,
  onHoverIndex,
  onChoose,
  onRequestHeadings,
  emptyMessage = "No notes found.",
}: NoteLinkResultsListProps) {
  return (
    <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
      {results.length === 0 ? (
        <p className="text-tertiary py-3 text-center text-xs">{emptyMessage}</p>
      ) : (
        results.map((choice, i) => (
          <div
            key={choice.path}
            role="button"
            tabIndex={-1}
            onMouseEnter={() => onHoverIndex(i)}
            onClick={() => onChoose(choice)}
            className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 ${
              i === activeIndex ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover hover:text-primary"
            }`}
          >
            <FileText size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{choice.title}</span>
            {choice.parentPath && <span className="text-tertiary shrink-0 truncate text-[11px]">{choice.parentPath}</span>}
            {onRequestHeadings && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestHeadings(choice);
                }}
                title="Link to a heading in this note"
                aria-label={`Link to a heading in ${choice.title}`}
                className="btn-ghost h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
              >
                <ChevronRight size={12} />
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

interface NoteLinkPickerBodyProps {
  notes: NoteLinkChoice[];
  /** Controlled, rather than owned locally - NoteLinkQuickPicker needs to read the same query
   * text to detect a pasted note:// link, so it has to live above this component. */
  query: string;
  onQueryChange: (query: string) => void;
  onChoose: (choice: NoteLinkChoice) => void;
  onRequestHeadings?: (choice: NoteLinkChoice) => void;
  /** When the query looks like a URL (see `looksLikeExternalUrl`), the normalized href to offer as
   * a plain external link - e.g. a pasted YouTube link, or any other site that isn't one of this
   * vault's own notes. Only the toolbar/modal entry point (NoteLinkQuickPicker) wants this; the
   * inline `[[` trigger stays note-only. */
  externalHref?: string | null;
  onChooseExternal?: (href: string) => void;
  /** Focuses the search input on mount - the toolbar's "Add link" popover wants this, the inline
   * `[[` trigger doesn't (focus has to stay in the editor for typing to keep landing in the doc). */
  autoFocus?: boolean;
  placeholder?: string;
}

/** Search input + filtered note list, plus (when the query looks like a URL) a row offering to
 * add it as a plain external link instead - the "paste a YouTube link" half of Add Link, which
 * otherwise has no home since a URL will almost never match a note title. */
export function NoteLinkPickerBody({
  notes,
  query,
  onQueryChange,
  onChoose,
  onRequestHeadings,
  externalHref,
  onChooseExternal,
  autoFocus,
  placeholder = "Search notes…",
}: NoteLinkPickerBodyProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.select();
  }, [autoFocus]);

  const results = useMemo(() => filterNoteChoices(notes, query), [notes, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const choice = results[activeIndex];
      if (choice) onChoose(choice);
      else if (externalHref && onChooseExternal) onChooseExternal(externalHref);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="border-subtle bg-surface-hover text-primary mt-3 h-9 w-full rounded-lg border px-3 text-sm focus:outline-none"
      />
      {externalHref && onChooseExternal && (
        <div
          role="button"
          tabIndex={-1}
          onClick={() => onChooseExternal(externalHref)}
          className="group mt-2 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-surface-hover"
        >
          <Globe size={14} className="text-tertiary shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Add link to <span className="text-primary font-medium">{externalHref}</span>
          </span>
        </div>
      )}
      <div className="mt-2">
        <NoteLinkResultsList
          results={results}
          activeIndex={activeIndex}
          onHoverIndex={setActiveIndex}
          onChoose={onChoose}
          onRequestHeadings={onRequestHeadings}
        />
      </div>
    </div>
  );
}

export interface NoteLinkQuickPickerProps {
  notes: NoteLinkChoice[];
  /** `href` is ready to use as-is (already built via buildNoteLinkHref, or - for a pasted link -
   * exactly what the user pasted); `markTitle` is a suggested tooltip for the applied link mark's
   * `title` attr. */
  onConfirm: (href: string, markTitle: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
  /** Seeds the query with an existing link's href - the "Edit link" entry point (see
   * LinkPopover in SelectionLinkToolbar.tsx) wants the current link visible and selected right
   * away, both as a way to see what it is and to make small edits to it, rather than starting
   * from a blank search. "Add link" leaves this unset, starting from an empty query. */
  initialQuery?: string;
}

type PickerStage = { kind: "notes" } | { kind: "headings"; note: NoteLinkChoice };

/** The selection toolbar's "Add link" content: one input that either fuzzy-searches notes
 * (optionally drilling into one of their headings, same two-stage flow the old centered modal
 * had), or - if what's typed/pasted parses as a note:// href, e.g. one copied via "Copy link to
 * this point" - resolves and confirms that link directly. Those are the "search a note" and
 * "paste a copied specific link" halves of the ask, unified into one field rather than two
 * separate modes to switch between.
 *
 * Deliberately has no dialog/overlay chrome of its own (no backdrop, no Cancel button) - it's
 * meant to sit inside a small anchored popover (see SelectionLinkToolbar.tsx's AddLinkPopover),
 * dismissed by clicking outside or Escape, the same way TableMenu/ImageMenu's popovers work. */
export function NoteLinkQuickPicker({ notes, onConfirm, onCancel, autoFocus, initialQuery }: NoteLinkQuickPickerProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [stage, setStage] = useState<PickerStage>({ kind: "notes" });
  const [headings, setHeadings] = useState<HeadingSlug[] | null>(null);
  const [headingsError, setHeadingsError] = useState(false);
  const pastedInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) pastedInputRef.current?.select();
  }, [autoFocus]);

  const pastedTarget = useMemo(() => {
    const trimmed = query.trim();
    return trimmed ? parseNoteLinkHref(trimmed) : null;
  }, [query]);
  const pastedNote = pastedTarget ? (notes.find((n) => n.path === pastedTarget.path) ?? null) : null;

  /** Only considered once it's clearly not one of our own note:// hrefs - e.g. a pasted YouTube
   * link, or any other external site that isn't a note in this vault. */
  const externalHref = useMemo(() => {
    if (pastedTarget) return null;
    const trimmed = query.trim();
    return looksLikeExternalUrl(trimmed) ? normalizeExternalUrl(trimmed) : null;
  }, [query, pastedTarget]);

  async function openHeadingsFor(note: NoteLinkChoice) {
    setStage({ kind: "headings", note });
    setHeadings(null);
    setHeadingsError(false);
    try {
      const content = await readNote(note.path);
      setHeadings(predictHeadingSlugs(content));
    } catch {
      setHeadingsError(true);
    }
  }

  function handleEscape() {
    if (stage.kind === "headings") setStage({ kind: "notes" });
    else onCancel();
  }

  function confirmPastedTarget() {
    if (!pastedTarget || !pastedNote) return;
    onConfirm(query.trim(), describeNoteLinkTarget(pastedTarget));
  }

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") handleEscape();
      }}
    >
      {stage.kind === "headings" ? (
        <>
          <button
            type="button"
            onClick={() => setStage({ kind: "notes" })}
            className="text-secondary hover:text-primary -ml-1 flex items-center gap-1 text-sm font-medium"
          >
            <ChevronLeft size={14} />
            {stage.note.title}
          </button>
          <p className="text-tertiary mt-1 text-xs">Choose a heading to link to.</p>
          <div className="mt-2 flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {headingsError ? (
              <p className="text-tertiary py-3 text-center text-xs">Couldn't read that note.</p>
            ) : headings === null ? (
              <p className="text-tertiary py-3 text-center text-xs">Loading…</p>
            ) : headings.length === 0 ? (
              <p className="text-tertiary py-3 text-center text-xs">No headings in this note.</p>
            ) : (
              headings.map((h) => (
                <button
                  key={h.slug}
                  type="button"
                  onClick={() =>
                    onConfirm(buildNoteLinkHref(stage.note.path, { headingId: h.slug }), `${h.text} · ⌘-click to open`)
                  }
                  style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
                  className="text-secondary hover:bg-surface-hover hover:text-primary flex items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-sm transition-colors duration-150"
                >
                  <Hash size={12} className="text-tertiary shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{h.text}</span>
                </button>
              ))
            )}
          </div>
        </>
      ) : pastedTarget ? (
        <div>
          <input
            ref={pastedInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes, or paste a link…"
            className="border-subtle bg-surface-hover text-primary h-9 w-full rounded-lg border px-3 text-sm focus:outline-none"
          />
          {pastedNote ? (
            <div className="mt-2">
              <p className="text-secondary px-1 text-sm">
                Link to <span className="text-primary font-medium">{pastedNote.title}</span>
                {pastedTarget.pinId ? " (a specific point)" : pastedTarget.headingId ? " (a heading)" : ""}
              </p>
              <button
                type="button"
                onClick={confirmPastedTarget}
                className="bg-accent-solid mt-2 h-8 w-full rounded-lg text-sm font-medium text-white transition-colors duration-150 hover:brightness-110"
              >
                Add link
              </button>
            </div>
          ) : (
            <p className="text-tertiary mt-2 px-1 text-xs">Couldn't find that note - it may have been deleted or renamed.</p>
          )}
        </div>
      ) : (
        <NoteLinkPickerBody
          notes={notes}
          query={query}
          onQueryChange={setQuery}
          onChoose={(choice) => onConfirm(buildNoteLinkHref(choice.path), "⌘-click to open")}
          onRequestHeadings={openHeadingsFor}
          externalHref={externalHref}
          onChooseExternal={(href) => onConfirm(href, "⌘-click to open")}
          autoFocus={autoFocus}
          placeholder="Search notes, or paste a link…"
        />
      )}
    </div>
  );
}
