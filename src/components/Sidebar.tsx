import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  FilePlus,
  FileText,
  Files,
  Folder,
  FolderPlus,
  MoreHorizontal,
  RotateCcw,
  Search,
  Square,
  Star,
  Trash2,
  UserPlus,
} from "lucide-react";
import { flattenFolders, flattenNotes, type TrashItem } from "../utils/fsNotes";
import { searchNotes, type SearchSnippet } from "../utils/searchIndex";
import { getBacklinksFor, subscribeToBacklinksIndex, type BacklinkHit } from "../utils/backlinksIndex";
import { FOLDER_COLOR_HEX } from "../utils/folderColors";
import { buildDayIndex, dayKey } from "../utils/dayIndex";
import { getEventsForDay, type CalendarEvent } from "../utils/calendarEvents";
import { formatRelativeTime } from "../utils/relativeTime";
import { EntryMenu, NoteTree, RenameInput } from "./NoteTree";
import type { BrowseFilter, FolderEntry, TreeEntry } from "../types";

interface SidebarProps {
  tree: TreeEntry[];
  trash: TrashItem[];
  /** Path of the note currently open in the editor, or null when browsing - drives the
   * "Linked mentions" backlinks section, which only makes sense while a note is open. */
  activeNotePath: string | null;
  /** Manually collapses the sidebar to zero width - the only visibility control at any width,
   * so the sidebar renders identically (and stays clipped by app-shell's rounded corners like
   * any other in-flow child) regardless of how narrow the window gets. */
  collapsed: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchIndexReady: boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** Drives Home's grid/tree filter while browsing (no note open) - while a note is open, the
   * nav buttons below instead drive local `treeFilter` so the note stays open. */
  filter: BrowseFilter;
  onSelectFilter: (filter: BrowseFilter) => void;
  /** Reveals `path` (a folder) in Home's middle portion - used when a search result folder is
   * opened, since the sidebar no longer hosts a file tree of its own to expand into. */
  onOpenFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  onDuplicateNote: (path: string) => void;
  /** Opens the "new note"/"new folder" dialogs - used by the file tree shown while a note is
   * open, so notes can be created without leaving the editor. */
  onPromptNewNote: (parentPath: string) => void;
  onPromptNewFolder: (parentPath: string) => void;
  /** Opens the dialog for redeeming an invite someone else sent - a vault-level action (unlike
   * Share, which is per-note) since it's how a note gets added to your view in the first place. */
  onJoinSharedNote: () => void;
  onRename: (path: string, isFolder: boolean, newTitle: string) => void;
  /** Soft-deletes immediately - no confirmation, since Recently Deleted is the undo. */
  onDeleteEntry: (path: string, isFolder: boolean) => void;
  onMove: (path: string, targetParentPath: string) => void;
  onSetFolderColor: (path: string, color: string | null) => void;
  onSetStarred: (path: string, value: boolean) => void;
  onRestoreFromTrash: (items: TrashItem[]) => void;
  onRequestDeleteForever: (items: TrashItem[]) => void;
  /** Whether the Calendar feature is enabled - see SettingsPanel.tsx's Features section. */
  showCalendar: boolean;
}

interface MenuState {
  path: string;
  title: string;
  type: "note" | "folder";
  color?: string;
  x: number;
  y: number;
}

export function Sidebar({
  tree,
  trash,
  activeNotePath,
  collapsed,
  searchQuery,
  onSearchChange,
  searchIndexReady,
  searchInputRef,
  filter,
  onSelectFilter,
  onOpenFolder,
  onOpenNote,
  onDuplicateNote,
  onPromptNewNote,
  onPromptNewFolder,
  onJoinSharedNote,
  onRename,
  onDeleteEntry,
  onMove,
  onSetFolderColor,
  onSetStarred,
  onRestoreFromTrash,
  onRequestDeleteForever,
  showCalendar,
}: SidebarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ path: string } | null>(null);
  // While a note is open, the nav buttons below filter the file tree in place instead of
  // navigating to Home (see selectSidebarFilter) - this is that filter's own state, independent
  // of `filter`/`onSelectFilter`, which continue to drive Home while browsing.
  const [treeFilter, setTreeFilter] = useState<BrowseFilter>("all");

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;

  const [debouncedQuery, setDebouncedQuery] = useState(trimmedQuery);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(trimmedQuery), 120);
    return () => clearTimeout(timer);
  }, [trimmedQuery]);

  const searchFolders: FolderEntry[] = useMemo(() => {
    if (!isSearching) return [];
    return flattenFolders(tree).filter((f) => f.title.toLowerCase().includes(trimmedQuery));
  }, [isSearching, tree, trimmedQuery]);

  interface SearchNote {
    path: string;
    title: string;
    parentPath: string;
    snippet?: SearchSnippet | null;
    starred?: boolean;
  }

  const searchResults: SearchNote[] = useMemo(() => {
    if (!isSearching) return [];
    const allNotes = flattenNotes(tree);
    if (!searchIndexReady) {
      return allNotes.filter((n) => n.title.toLowerCase().includes(trimmedQuery));
    }
    const byPath = new Map(allNotes.map((n) => [n.path, n]));
    return searchNotes(debouncedQuery)
      .map((hit): SearchNote | undefined => {
        const note = byPath.get(hit.path);
        return note ? { ...note, snippet: hit.snippet } : undefined;
      })
      .filter((n): n is SearchNote => n !== undefined);
  }, [isSearching, tree, trimmedQuery, debouncedQuery, searchIndexReady]);

  const starredCount = useMemo(() => flattenNotes(tree).filter((n) => n.starred).length, [tree]);
  const starredNotes = useMemo(() => flattenNotes(tree).filter((n) => n.starred), [tree]);

  /** Nav filter shown as active - while a note is open this is the file tree's own local
   * filter, since Home's `filter` is invisible while browsing is paused. */
  const navFilter = activeNotePath ? treeFilter : filter;

  /** Nav click in the sidebar (All Notes/Starred/Recently Deleted). While a note is open this
   * only switches what the file tree below shows, so the note stays open; otherwise it defers
   * to Home's own filter/navigation as before. */
  function selectSidebarFilter(next: BrowseFilter) {
    if (activeNotePath) setTreeFilter(next);
    else onSelectFilter(next);
  }

  // Recently Deleted's multi-select (Gmail-style checkboxes), mirroring Home's - only meaningful
  // while the tree below is showing the trash filter, reset whenever it navigates away from that.
  const [selectedTrash, setSelectedTrash] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (navFilter !== "trash") setSelectedTrash(new Set());
  }, [navFilter]);
  // Drop selections for items that just got restored/deleted-forever/expired out from under us.
  useEffect(() => {
    setSelectedTrash((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((p) => trash.some((t) => t.trashPath === p)));
      return next.size === prev.size ? prev : next;
    });
  }, [trash]);
  const allTrashSelected = trash.length > 0 && selectedTrash.size === trash.length;
  const selectedTrashItems = useMemo(
    () => trash.filter((t) => selectedTrash.has(t.trashPath)),
    [trash, selectedTrash],
  );
  function toggleTrashSelected(trashPath: string) {
    setSelectedTrash((prev) => {
      const next = new Set(prev);
      if (next.has(trashPath)) next.delete(trashPath);
      else next.add(trashPath);
      return next;
    });
  }
  function toggleSelectAllTrash() {
    setSelectedTrash(allTrashSelected ? new Set() : new Set(trash.map((t) => t.trashPath)));
  }
  function recoverSelectedTrash() {
    if (selectedTrashItems.length === 0) return;
    onRestoreFromTrash(selectedTrashItems);
    setSelectedTrash(new Set());
  }
  function removeSelectedTrashForever() {
    if (selectedTrashItems.length === 0) return;
    onRequestDeleteForever(selectedTrashItems);
  }

  // backlinksIndex.ts is a plain module singleton with no React state of its own, so this tick
  // is what makes the section below re-render when a note elsewhere adds/removes a link to the
  // one currently open here (see subscribeToBacklinksIndex's own comment).
  const [backlinksTick, setBacklinksTick] = useState(0);
  useEffect(() => subscribeToBacklinksIndex(() => setBacklinksTick((t) => t + 1)), []);
  const backlinks: BacklinkHit[] = useMemo(
    () => (!isSearching && activeNotePath ? getBacklinksFor(activeNotePath) : []),
    // backlinksTick is intentionally a dependency even though it's unused in the body - it's
    // the signal that the index itself changed underneath activeNotePath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeNotePath, isSearching, backlinksTick],
  );

  // Calendar - shown below the nav in place of a file tree; see Home.tsx for the notes grid/tree.
  const notes = useMemo(() => flattenNotes(tree), [tree]);
  const dayIndex = useMemo(() => buildDayIndex(notes), [notes]);
  const today = useMemo(() => new Date(), []);
  const [monthCursor, setMonthCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(today);
  const cells = useMemo(() => {
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const gridStart = new Date(year, month, 1 - startOffset);
    return Array.from({ length: 42 }, (_, i) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + i);
      return { date, inMonth: date.getMonth() === month };
    });
  }, [monthCursor]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    let cancelled = false;
    getEventsForDay(selected).then((result) => {
      if (!cancelled) setEvents(result);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);
  const selectedRefs = dayIndex.get(dayKey(selected)) ?? [];

  function openFolderFromSearch(path: string) {
    onSearchChange("");
    onOpenFolder(path);
  }

  function openMenu(
    e: React.MouseEvent,
    entry: { path: string; title: string; type: "note" | "folder"; color?: string },
  ) {
    e.preventDefault();
    e.stopPropagation();
    if (menu && menu.path === entry.path) {
      setMenu(null);
      return;
    }
    const containerRect = containerRef.current!.getBoundingClientRect();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const idealX = rect.left - containerRect.left;
    const maxX = containerRect.width - 164;
    setMenu({
      path: entry.path,
      title: entry.title,
      type: entry.type,
      color: entry.color,
      x: Math.max(4, Math.min(idealX, maxX)),
      y: rect.bottom - containerRect.top + 4,
    });
  }

  function startRename(path: string) {
    setMenu(null);
    setRenaming({ path });
  }

  function commitRename(path: string, isFolder: boolean, rawValue: string) {
    setRenaming(null);
    const value = rawValue.trim();
    if (value) onRename(path, isFolder, value);
  }

  const nothingAnywhere = tree.length === 0;
  const noMatches = isSearching && searchResults.length === 0 && searchFolders.length === 0;

  return (
    <>
      <nav
        ref={containerRef}
        className={`glass-panel border-subtle relative z-20 flex shrink-0 flex-col gap-1 overflow-hidden border-r py-2 transition-[width] duration-200 ${
          collapsed ? "w-0 border-r-0" : "w-64"
        }`}
      >
        <div className="flex items-center gap-1 px-2">
          <div className="border-subtle bg-surface-hover flex h-8 flex-1 items-center gap-2 rounded-lg border px-2.5">
            <Search size={13} className="text-tertiary shrink-0" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search notes"
              className="text-primary placeholder:text-tertiary min-w-0 flex-1 bg-transparent text-xs focus:outline-none"
            />
          </div>
        </div>

        {!isSearching && (
          <div className="flex flex-col gap-0.5 px-2 pt-1.5">
            <button
              type="button"
              onClick={() => selectSidebarFilter("all")}
              className={`flex h-8 items-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors duration-150 ${
                navFilter === "all" ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover hover:text-primary"
              }`}
            >
              <Files size={14} className="shrink-0" />
              All Notes
            </button>
            <button
              type="button"
              onClick={() => selectSidebarFilter("starred")}
              className={`flex h-8 items-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors duration-150 ${
                navFilter === "starred" ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover hover:text-primary"
              }`}
            >
              <Star size={14} className="shrink-0" />
              Starred
              <span className="text-tertiary ml-auto text-xs tabular-nums">{starredCount}</span>
            </button>
            <button
              type="button"
              onClick={() => selectSidebarFilter("trash")}
              className={`flex h-8 items-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors duration-150 ${
                navFilter === "trash" ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover hover:text-primary"
              }`}
            >
              <Trash2 size={14} className="shrink-0" />
              Recently Deleted
              <span className="text-tertiary ml-auto text-xs tabular-nums">{trash.length}</span>
            </button>
          </div>
        )}

        <div className="border-subtle mx-2 my-1 border-t" />

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {isSearching ? (
            nothingAnywhere ? null : noMatches ? (
              <p className="text-tertiary flex h-20 items-center justify-center text-sm">No matches.</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {searchFolders.map((entry) => (
                  <SearchFolderRow
                    key={entry.path}
                    entry={entry}
                    onOpen={() => openFolderFromSearch(entry.path)}
                    onOpenMenu={(e) => openMenu(e, { path: entry.path, title: entry.title, type: "folder", color: entry.color })}
                  />
                ))}
                {searchResults.map((entry) => (
                  <SearchNoteRow
                    key={entry.path}
                    entry={entry}
                    isRenaming={renaming?.path === entry.path}
                    onCommitRename={(value) => commitRename(entry.path, false, value)}
                    onCancelRename={() => setRenaming(null)}
                    onOpen={() => onOpenNote(entry.path)}
                    onOpenMenu={(e) => openMenu(e, { path: entry.path, title: entry.title, type: "note" })}
                    onToggleStar={() => onSetStarred(entry.path, !entry.starred)}
                  />
                ))}
              </div>
            )
          ) : (
            <div className="flex flex-col gap-3">
              {activeNotePath && backlinks.length > 0 && (
                <div className="border-subtle rounded-xl border p-3">
                  <p className="text-primary mb-2 text-sm font-semibold">Linked mentions</p>
                  <div className="flex flex-col gap-1">
                    {backlinks.map((hit, i) => (
                      <BacklinkRow key={`${hit.sourcePath}:${i}`} hit={hit} onOpen={() => onOpenNote(hit.sourcePath)} />
                    ))}
                  </div>
                </div>
              )}

              {activeNotePath ? (
                <div className="flex flex-col gap-1">
                  {navFilter === "all" && (
                    <>
                      <div className="flex items-center gap-1 px-1">
                        <p className="text-tertiary flex-1 text-xs font-semibold uppercase tracking-wide">All Notes</p>
                        <button
                          type="button"
                          onClick={onJoinSharedNote}
                          className="btn-ghost h-5 w-5"
                          title="Join a shared note"
                          aria-label="Join a shared note"
                        >
                          <UserPlus size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onPromptNewFolder("")}
                          className="btn-ghost h-5 w-5"
                          title="New folder"
                          aria-label="New folder"
                        >
                          <FolderPlus size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onPromptNewNote("")}
                          className="btn-ghost h-5 w-5"
                          title="New note"
                          aria-label="New note"
                        >
                          <FilePlus size={12} />
                        </button>
                      </div>
                      <NoteTree
                        tree={tree}
                        onOpenNote={onOpenNote}
                        onDuplicateNote={onDuplicateNote}
                        onCreateNote={onPromptNewNote}
                        onCreateFolder={onPromptNewFolder}
                        onRename={onRename}
                        onDeleteEntry={onDeleteEntry}
                        onMove={onMove}
                        onSetFolderColor={onSetFolderColor}
                        onSetStarred={onSetStarred}
                      />
                    </>
                  )}

                  {navFilter === "starred" && (
                    <>
                      <p className="text-tertiary px-1 text-xs font-semibold uppercase tracking-wide">Starred</p>
                      {starredNotes.length === 0 ? (
                        <p className="text-tertiary px-1 py-3 text-center text-xs">Star a note to see it here.</p>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {starredNotes.map((entry) => (
                            <SearchNoteRow
                              key={entry.path}
                              entry={entry}
                              isRenaming={renaming?.path === entry.path}
                              onCommitRename={(value) => commitRename(entry.path, false, value)}
                              onCancelRename={() => setRenaming(null)}
                              onOpen={() => onOpenNote(entry.path)}
                              onOpenMenu={(e) => openMenu(e, { path: entry.path, title: entry.title, type: "note" })}
                              onToggleStar={() => onSetStarred(entry.path, !entry.starred)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {navFilter === "trash" && (
                    <>
                      <div className="flex items-center gap-1 px-1">
                        <p className="text-tertiary flex-1 text-xs font-semibold uppercase tracking-wide">
                          Recently Deleted
                        </p>
                        <button
                          type="button"
                          onClick={toggleSelectAllTrash}
                          disabled={trash.length === 0}
                          className="btn-ghost h-5 w-5 disabled:opacity-30"
                          title={allTrashSelected ? "Deselect all" : "Select all"}
                          aria-label={allTrashSelected ? "Deselect all" : "Select all"}
                        >
                          {allTrashSelected ? <CheckSquare size={12} /> : <Square size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={recoverSelectedTrash}
                          disabled={selectedTrashItems.length === 0}
                          className="btn-ghost h-5 w-5 disabled:opacity-30"
                          title="Recover selected"
                          aria-label="Recover selected"
                        >
                          <RotateCcw size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={removeSelectedTrashForever}
                          disabled={selectedTrashItems.length === 0}
                          className="btn-ghost hover:text-danger h-5 w-5 disabled:opacity-30"
                          title="Remove selected"
                          aria-label="Remove selected"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      {trash.length === 0 ? (
                        <p className="text-tertiary px-1 py-3 text-center text-xs">Nothing in Recently Deleted.</p>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {trash.map((item) => (
                            <SidebarTrashRow
                              key={item.trashPath}
                              item={item}
                              selected={selectedTrash.has(item.trashPath)}
                              anySelected={selectedTrash.size > 0}
                              onToggleSelect={() => toggleTrashSelected(item.trashPath)}
                              onRestore={() => onRestoreFromTrash([item])}
                              onDeleteForever={() => onRequestDeleteForever([item])}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : showCalendar ? (
                <>
                  <div className="border-subtle rounded-xl border p-3">
                    <div className="mb-2 flex items-center gap-1">
                      <p className="text-primary flex-1 text-sm font-semibold">
                        {monthCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                      </p>
                      <button
                        type="button"
                        onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                        className="btn-ghost h-6 w-6"
                        aria-label="Previous month"
                      >
                        <ChevronLeft size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
                        className="btn-ghost h-6 w-6"
                        aria-label="Next month"
                      >
                        <ChevronRight size={13} />
                      </button>
                    </div>
                    <div className="grid grid-cols-7 gap-0.5 text-center">
                      {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                        <span key={i} className="text-tertiary text-[10px] font-semibold">
                          {d}
                        </span>
                      ))}
                      {cells.map(({ date, inMonth }) => {
                        const isToday = dayKey(date) === dayKey(today);
                        const isSelected = dayKey(date) === dayKey(selected);
                        const hasActivity = dayIndex.has(dayKey(date));
                        return (
                          <button
                            key={date.toISOString()}
                            type="button"
                            onClick={() => setSelected(date)}
                            className={`relative flex h-7 flex-col items-center justify-center rounded-md text-xs tabular-nums transition-colors duration-150 ${
                              !inMonth ? "text-tertiary opacity-40" : "text-primary"
                            } ${isToday ? "bg-accent-solid font-semibold text-white" : "hover:bg-surface-hover"}`}
                            style={
                              isSelected && !isToday
                                ? { boxShadow: "inset 0 0 0 1.5px rgb(var(--accent-rgb) / 0.5)" }
                                : undefined
                            }
                          >
                            {date.getDate()}
                            {hasActivity && (
                              <span
                                className={`absolute bottom-0.5 h-[3px] w-[3px] rounded-full ${isToday ? "bg-white" : "bg-accent-solid"}`}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="border-subtle flex min-h-32 flex-col gap-1.5 rounded-xl border p-3">
                    <p className="text-primary text-sm font-semibold">
                      {selected.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                    </p>
                    {selectedRefs.length === 0 && events.length === 0 ? (
                      <p className="text-tertiary my-auto py-3 text-center text-xs">Nothing on this day yet.</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {selectedRefs.map((ref) => (
                          <button
                            key={`${ref.note.path}:${ref.kind}`}
                            type="button"
                            onClick={() => onOpenNote(ref.note.path)}
                            className="hover:bg-surface-hover flex items-center gap-2 rounded-lg px-1 py-1 text-left"
                          >
                            <span className="border-subtle bg-surface-strong text-tertiary flex h-5 w-5 shrink-0 items-center justify-center rounded-md border">
                              <FileText size={10} />
                            </span>
                            <span className="text-primary min-w-0 flex-1 truncate text-xs font-medium">{ref.note.title}</span>
                            <span className="text-tertiary shrink-0 text-[11px]">{ref.kind}</span>
                          </button>
                        ))}
                        {events.map((event) => (
                          <div key={event.id} className="flex items-center gap-2 px-1 py-1">
                            <span className="border-subtle bg-surface-strong text-tertiary flex h-5 w-5 shrink-0 items-center justify-center rounded-md border">
                              <ChevronRight size={10} />
                            </span>
                            <span className="text-primary min-w-0 flex-1 truncate text-xs font-medium">{event.title}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>

        {menu && (
          <EntryMenu
            menu={menu}
            onClose={() => setMenu(null)}
            onRename={() => startRename(menu.path)}
            onDelete={() => {
              setMenu(null);
              onDeleteEntry(menu.path, menu.type === "folder");
            }}
            onSetColor={menu.type === "folder" ? (color) => onSetFolderColor(menu.path, color) : undefined}
            onOpenInNewWindow={menu.type === "note" ? () => onDuplicateNote(menu.path) : undefined}
          />
        )}
      </nav>
    </>
  );
}

/** Flat, non-expandable folder row shown among search results - clears the query and reveals
 * the folder in Home's middle portion, since there's no tree in the sidebar to expand into. */
function SearchFolderRow({
  entry,
  onOpen,
  onOpenMenu,
}: {
  entry: FolderEntry;
  onOpen: () => void;
  onOpenMenu: (e: React.MouseEvent) => void;
}) {
  const itemCount = entry.children.length;
  const colorHex = entry.color ? FOLDER_COLOR_HEX[entry.color] : undefined;

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-primary"
    >
      <Folder size={14} className={colorHex ? "text-icon-outline shrink-0" : "text-tertiary shrink-0"} fill={colorHex} fillOpacity={colorHex ? 1 : 0} />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium">{entry.title}</span>
        <p className="text-tertiary truncate text-xs">
          {itemCount} item{itemCount === 1 ? "" : "s"}
        </p>
      </div>
      <button
        type="button"
        onClick={onOpenMenu}
        className="btn-ghost h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
        title="Folder options"
        aria-label={`Options for ${entry.title}`}
      >
        <MoreHorizontal size={12} />
      </button>
    </div>
  );
}

/** Flat note row shown among search results, with inline rename (triggered from its context
 * menu) since there's no tree row elsewhere in the sidebar to host it. */
function SearchNoteRow({
  entry,
  isRenaming,
  onCommitRename,
  onCancelRename,
  onOpen,
  onOpenMenu,
  onToggleStar,
}: {
  entry: { path: string; title: string; parentPath: string; snippet?: SearchSnippet | null; starred?: boolean };
  isRenaming: boolean;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onOpenMenu: (e: React.MouseEvent) => void;
  onToggleStar: () => void;
}) {
  return (
    <div
      onClick={isRenaming ? undefined : onOpen}
      role="button"
      tabIndex={0}
      className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ${
        isRenaming ? "text-secondary" : "cursor-pointer text-secondary hover:bg-surface-hover hover:text-primary"
      }`}
    >
      <FileText size={14} className="text-icon-outline mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {isRenaming ? (
          <RenameInput initialValue={entry.title} onCommit={onCommitRename} onCancel={onCancelRename} />
        ) : (
          <span className="block truncate">{entry.title}</span>
        )}
        {entry.snippet ? (
          <p className="text-tertiary truncate text-xs">
            {entry.snippet.before}
            <span className="text-secondary font-semibold">{entry.snippet.match}</span>
            {entry.snippet.after}
          </p>
        ) : (
          <p className="text-tertiary truncate text-xs">{entry.parentPath || "All Notes"}</p>
        )}
      </div>
      {!isRenaming && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar();
            }}
            className={`btn-ghost h-5 w-5 ${entry.starred ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            title={entry.starred ? "Unstar" : "Star"}
            aria-label={entry.starred ? `Unstar ${entry.title}` : `Star ${entry.title}`}
          >
            <Star size={11} className={entry.starred ? "fill-current" : ""} />
          </button>
          <button
            type="button"
            onClick={onOpenMenu}
            className="btn-ghost h-5 w-5 opacity-0 group-hover:opacity-100"
            title="Note options"
            aria-label={`Options for ${entry.title}`}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact Recently Deleted row for the in-note file tree - a trimmed-down version of Home's
 * TrashRow without multi-select, since bulk actions don't fit the narrow sidebar. */
function SidebarTrashRow({
  item,
  selected,
  anySelected,
  onToggleSelect,
  onRestore,
  onDeleteForever,
}: {
  item: TrashItem;
  selected: boolean;
  anySelected: boolean;
  onToggleSelect: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
}) {
  return (
    <div
      onClick={onToggleSelect}
      role="button"
      tabIndex={0}
      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-secondary transition-colors duration-150 ${
        selected ? "bg-accent-soft" : "hover:bg-surface-hover"
      }`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        className={`btn-ghost flex h-5 w-5 shrink-0 items-center justify-center ${
          selected || anySelected ? "" : "opacity-0 group-hover:opacity-100"
        }`}
        title={selected ? "Deselect" : "Select"}
        aria-label={selected ? `Deselect ${item.title}` : `Select ${item.title}`}
      >
        {selected ? <CheckSquare size={13} className="text-accent" /> : <Square size={13} />}
      </button>
      {item.type === "folder" ? (
        <Folder size={14} className="text-tertiary shrink-0" />
      ) : (
        <FileText size={14} className="text-icon-outline shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className="block truncate">{item.title}</span>
        <p className="text-tertiary truncate text-xs">Deleted {formatRelativeTime(item.deletedAt)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          className="btn-ghost h-5 w-5"
          title="Restore"
          aria-label={`Restore ${item.title}`}
        >
          <RotateCcw size={11} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteForever();
          }}
          className="btn-ghost hover:text-danger h-5 w-5"
          title="Delete forever"
          aria-label={`Delete ${item.title} forever`}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

/** A single "Linked mentions" row - another note that links to the one currently open. Shows
 * which heading it points at only when that heading belongs to *this* (the open) note, since
 * every row in this list is already about "this note" as the target. */
function BacklinkRow({ hit, onOpen }: { hit: BacklinkHit; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hover:bg-surface-hover flex items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-secondary transition-colors duration-150 hover:text-primary"
    >
      <FileText size={14} className="text-icon-outline mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{hit.sourceTitle}</span>
          {hit.headingLabel && (
            <span className="text-tertiary shrink-0 truncate text-[11px]">→ §{hit.headingLabel}</span>
          )}
        </span>
        <p className="text-tertiary truncate text-xs">{hit.snippet}</p>
      </div>
    </button>
  );
}
