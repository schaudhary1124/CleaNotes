import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  LayoutGrid,
  List,
  MoreHorizontal,
  RotateCcw,
  Square,
  Star,
  Trash2,
} from "lucide-react";
import { flattenNotes, type TrashItem } from "../utils/fsNotes";
import { FOLDER_COLOR_HEX } from "../utils/folderColors";
import { formatRelativeTime } from "../utils/relativeTime";
import { NOTE_TEMPLATES } from "../utils/templates";
import type { SharedNoteSummary } from "../collab/acl";
import { EntryMenu, NoteTree, RenameInput } from "./NoteTree";
import { SharedNotesList } from "./SharedNotesList";
import type { BrowseFilter, FolderEntry, GuestJoinedNote, NoteEntry, NoteSummary, TreeEntry } from "../types";

interface MenuState {
  path: string;
  title: string;
  type: "note" | "folder";
  color?: string;
  x: number;
  y: number;
}

interface HomeProps {
  tree: TreeEntry[];
  trash: TrashItem[];
  filter: BrowseFilter;
  browseFolder: string;
  onBrowseFolderChange: (path: string) => void;
  onOpenNote: (path: string) => void;
  onCreateNote: (parentPath: string, title?: string, templateId?: string) => void;
  /** Opens the "new note"/"new folder" dialogs - used by the tree view's per-folder hover
   * buttons and the empty-vault CTA, distinct from `onCreateNote`'s direct template creation. */
  onPromptNewNote: (parentPath: string) => void;
  onPromptNewFolder: (parentPath: string) => void;
  onDuplicateNote: (path: string) => void;
  onRename: (path: string, isFolder: boolean, newTitle: string) => void;
  onDeleteEntry: (path: string, isFolder: boolean) => void;
  onMove: (path: string, targetParentPath: string) => void;
  onSetFolderColor: (path: string, color: string | null) => void;
  onSetStarred: (path: string, value: boolean) => void;
  onRestoreFromTrash: (items: TrashItem[]) => void;
  onRequestDeleteForever: (items: TrashItem[]) => void;
  /** For filter === "shared" - see App.tsx's ownedSharedNotes/guestNotes state. */
  ownedSharedNotes: SharedNoteSummary[];
  guestNotes: GuestJoinedNote[];
  guestRequestPhases: Record<string, "connecting" | "acknowledged" | "stalled">;
  onOpenSharedNote: (noteId: string) => void;
  onJoinSharedNote: () => void;
  onDismissGuestNote: (noteId: string) => void;
  onRetryGuestRequest: (noteId: string) => void;
  onUnshareOwned: (notePath: string) => void;
}

/** Finds the children directly under `path` ("" for the vault root) - used by the folder/note
 * grid below to drill in and out, independent of the sidebar's own state. */
function findChildren(tree: TreeEntry[], path: string): TreeEntry[] | null {
  if (!path) return tree;
  for (const entry of tree) {
    if (entry.type !== "folder") continue;
    if (entry.path === path) return entry.children;
    if (path.startsWith(`${entry.path}/`)) {
      const found = findChildren(entry.children, path);
      if (found) return found;
    }
  }
  return null;
}

function getBreadcrumbs(path: string): { path: string; label: string }[] {
  const crumbs = [{ path: "", label: "All Notes" }];
  if (!path) return crumbs;
  const segments = path.split("/");
  let acc = "";
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    crumbs.push({ path: acc, label: seg });
  }
  return crumbs;
}

export function Home({
  tree,
  trash,
  filter,
  browseFolder,
  onBrowseFolderChange,
  onOpenNote,
  onCreateNote,
  onPromptNewNote,
  onPromptNewFolder,
  onDuplicateNote,
  onRename,
  onDeleteEntry,
  onMove,
  onSetFolderColor,
  onSetStarred,
  onRestoreFromTrash,
  onRequestDeleteForever,
  ownedSharedNotes,
  guestNotes,
  guestRequestPhases,
  onOpenSharedNote,
  onJoinSharedNote,
  onDismissGuestNote,
  onRetryGuestRequest,
  onUnshareOwned,
}: HomeProps) {
  const notes = useMemo(() => flattenNotes(tree), [tree]);
  const starredNotes = useMemo(() => notes.filter((n) => n.starred), [notes]);

  const [viewMode, setViewMode] = useState<"grid" | "tree">("grid");

  // Recently Deleted's multi-select (Gmail-style checkboxes) - only meaningful while
  // filter === "trash", reset whenever the user navigates away from it.
  const [selectedTrash, setSelectedTrash] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (filter !== "trash") setSelectedTrash(new Set());
  }, [filter]);
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

  // Rename/context-menu for grid and flat-row tiles - tree view gets its own copy of this
  // via NoteTree, since it's a separate, independently-scrollable subtree.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ path: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

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

  // The folder being browsed may have been renamed/moved/deleted out from under us since the
  // last tree refresh - fall back to root rather than silently showing a stale/empty grid.
  useEffect(() => {
    if (browseFolder && findChildren(tree, browseFolder) === null) onBrowseFolderChange("");
  }, [tree, browseFolder, onBrowseFolderChange]);
  const folderChildren = useMemo(() => findChildren(tree, browseFolder) ?? [], [tree, browseFolder]);
  const breadcrumbs = useMemo(() => getBreadcrumbs(browseFolder), [browseFolder]);
  const childFolders = useMemo(
    () => folderChildren.filter((e): e is FolderEntry => e.type === "folder"),
    [folderChildren],
  );
  const childNotes = useMemo(
    () => folderChildren.filter((e): e is NoteEntry => e.type === "note"),
    [folderChildren],
  );

  const nothingAnywhere = tree.length === 0;
  const filterTitle =
    filter === "starred" ? "Starred" : filter === "trash" ? "Recently Deleted" : filter === "shared" ? "Shared Notes" : null;

  return (
    <div ref={containerRef} className="@container relative flex h-full flex-col overflow-y-auto">
      <div className="flex flex-col gap-5 p-5 @max-md:gap-4 @max-md:p-4">
        <section>
          <p className="text-tertiary mb-2 text-xs font-semibold">Templates</p>
          <div className="flex gap-2.5 overflow-x-auto pb-1">
            {NOTE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onCreateNote(browseFolder, undefined, template.id)}
                className="border-subtle bg-surface-strong hover:border-subtle-strong flex h-24 w-20 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 text-center transition-colors duration-150"
              >
                <template.icon size={18} className="text-secondary" />
                <span className="text-secondary text-[11px] font-medium leading-tight">{template.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 text-sm">
              {filter === "all" ? (
                breadcrumbs.map((crumb, i) => (
                  <span key={crumb.path || "root"} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <ChevronRight size={12} className="text-tertiary shrink-0" />}
                    <button
                      type="button"
                      onClick={() => onBrowseFolderChange(crumb.path)}
                      className={`min-w-0 truncate rounded-md px-1 transition-colors duration-150 ${
                        i === breadcrumbs.length - 1
                          ? "text-primary font-semibold"
                          : "text-tertiary hover:text-primary"
                      }`}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-primary truncate px-1 text-sm font-semibold">{filterTitle}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {filter === "trash" ? (
                <>
                  <button
                    type="button"
                    onClick={toggleSelectAllTrash}
                    disabled={trash.length === 0}
                    className="btn-ghost border-subtle flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium disabled:opacity-40"
                  >
                    {allTrashSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                    {allTrashSelected ? "Deselect all" : "Select all"}
                  </button>
                  <button
                    type="button"
                    onClick={recoverSelectedTrash}
                    disabled={selectedTrashItems.length === 0}
                    className="btn-ghost border-subtle flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium disabled:opacity-40"
                  >
                    <RotateCcw size={13} /> Recover
                  </button>
                  <button
                    type="button"
                    onClick={removeSelectedTrashForever}
                    disabled={selectedTrashItems.length === 0}
                    className="btn-ghost border-subtle hover:text-danger flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium disabled:opacity-40"
                  >
                    <Trash2 size={13} /> Remove
                  </button>
                </>
              ) : filter !== "shared" ? (
                <>
                  <button
                    type="button"
                    onClick={() => onPromptNewFolder("")}
                    className="btn-ghost border-subtle flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium"
                  >
                    <FolderPlus size={13} /> Folder
                  </button>
                  <button
                    type="button"
                    onClick={() => onPromptNewNote("")}
                    className="btn-ghost border-subtle flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium"
                  >
                    <FilePlus size={13} /> Note
                  </button>
                </>
              ) : null}
            </div>

            {filter !== "trash" && filter !== "shared" && (
              <div className="border-subtle flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`btn-ghost h-6 w-6 ${viewMode === "grid" ? "bg-accent-soft text-accent" : ""}`}
                  title="Grid view"
                  aria-label="Grid view"
                  aria-pressed={viewMode === "grid"}
                >
                  <LayoutGrid size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("tree")}
                  className={`btn-ghost h-6 w-6 ${viewMode === "tree" ? "bg-accent-soft text-accent" : ""}`}
                  title="Tree view"
                  aria-label="Tree view"
                  aria-pressed={viewMode === "tree"}
                >
                  <List size={13} />
                </button>
              </div>
            )}
          </div>

          {filter === "all" &&
            (viewMode === "tree" ? (
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
            ) : nothingAnywhere ? (
              <div className="flex h-32 flex-col items-center justify-center gap-3 text-center">
                <p className="text-secondary text-sm">No notes yet.</p>
                <button
                  type="button"
                  onClick={() => onPromptNewNote("")}
                  className="btn-ghost bg-accent-soft text-accent h-9 rounded-lg px-4 text-sm"
                >
                  Create your first note
                </button>
              </div>
            ) : childFolders.length === 0 && childNotes.length === 0 ? (
              <p className="text-tertiary text-sm">Nothing here yet.</p>
            ) : (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(84px,calc((100%-12px)/2)),1fr))]">
                {childFolders.map((entry) => (
                  <FolderGridTile
                    key={entry.path}
                    entry={entry}
                    onOpen={() => onBrowseFolderChange(entry.path)}
                    isRenaming={renaming?.path === entry.path}
                    onCommitRename={(value) => commitRename(entry.path, true, value)}
                    onCancelRename={() => setRenaming(null)}
                    onOpenMenu={(e) => openMenu(e, { path: entry.path, title: entry.title, type: "folder", color: entry.color })}
                  />
                ))}
                {childNotes.map((entry) => (
                  <NoteGridTile
                    key={entry.path}
                    title={entry.title}
                    starred={entry.starred}
                    onOpen={() => onOpenNote(entry.path)}
                    onToggleStar={() => onSetStarred(entry.path, !entry.starred)}
                    isRenaming={renaming?.path === entry.path}
                    onCommitRename={(value) => commitRename(entry.path, false, value)}
                    onCancelRename={() => setRenaming(null)}
                    onOpenMenu={(e) => openMenu(e, { path: entry.path, title: entry.title, type: "note" })}
                  />
                ))}
              </div>
            ))}

          {filter === "starred" &&
            (starredNotes.length === 0 ? (
              <p className="text-tertiary text-sm">Star a note to see it here.</p>
            ) : viewMode === "grid" ? (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(84px,calc((100%-12px)/2)),1fr))]">
                {starredNotes.map((note) => (
                  <NoteGridTile
                    key={note.path}
                    title={note.title}
                    starred
                    onOpen={() => onOpenNote(note.path)}
                    onToggleStar={() => onSetStarred(note.path, false)}
                    isRenaming={renaming?.path === note.path}
                    onCommitRename={(value) => commitRename(note.path, false, value)}
                    onCancelRename={() => setRenaming(null)}
                    onOpenMenu={(e) => openMenu(e, { path: note.path, title: note.title, type: "note" })}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {starredNotes.map((note) => (
                  <FlatNoteRow
                    key={note.path}
                    note={note}
                    onOpen={() => onOpenNote(note.path)}
                    onToggleStar={() => onSetStarred(note.path, false)}
                    isRenaming={renaming?.path === note.path}
                    onCommitRename={(value) => commitRename(note.path, false, value)}
                    onCancelRename={() => setRenaming(null)}
                    onOpenMenu={(e) => openMenu(e, { path: note.path, title: note.title, type: "note" })}
                  />
                ))}
              </div>
            ))}

          {filter === "shared" && (
            <SharedNotesList
              ownedSharedNotes={ownedSharedNotes}
              guestNotes={guestNotes}
              requestPhases={guestRequestPhases}
              onOpenOwned={onOpenNote}
              onOpenGuest={onOpenSharedNote}
              onJoinSharedNote={onJoinSharedNote}
              onDismissGuestNote={onDismissGuestNote}
              onRetryGuestRequest={onRetryGuestRequest}
              onUnshareOwned={onUnshareOwned}
            />
          )}

          {filter === "trash" &&
            (trash.length === 0 ? (
              <p className="text-tertiary text-sm">Nothing in Recently Deleted.</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {trash.map((item) => (
                  <TrashRow
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
            ))}
        </section>
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
    </div>
  );
}

/** Grid tile: opens/drills in on click, with the same rename/delete/recolor context menu the
 * tree view offers via its "..." button - only reachable from tree view before, which left grid
 * view (the default) with no way to recolor a folder or rename anything. */
function FolderGridTile({
  entry,
  onOpen,
  isRenaming,
  onCommitRename,
  onCancelRename,
  onOpenMenu,
}: {
  entry: FolderEntry;
  onOpen: () => void;
  isRenaming: boolean;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onOpenMenu: (e: React.MouseEvent) => void;
}) {
  const itemCount = entry.children.length;
  const colorHex = entry.color ? FOLDER_COLOR_HEX[entry.color] : undefined;
  return (
    <div className="group relative flex min-w-0 w-full flex-col items-center gap-1 text-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-16 w-full items-center justify-center rounded-2xl transition-colors duration-150 group-hover:bg-surface-hover"
      >
        <Folder
          size={40}
          strokeWidth={1.25}
          className={colorHex ? "text-icon-outline shrink-0" : "text-tertiary shrink-0"}
          fill={colorHex}
          fillOpacity={colorHex ? 1 : 0}
        />
      </button>
      <button
        type="button"
        onClick={onOpenMenu}
        className="btn-ghost absolute right-0.5 top-0 h-5 w-5 opacity-0 group-hover:opacity-100"
        title="Folder options"
        aria-label={`Options for ${entry.title}`}
      >
        <MoreHorizontal size={12} />
      </button>
      {isRenaming ? (
        <RenameInput initialValue={entry.title} onCommit={onCommitRename} onCancel={onCancelRename} />
      ) : (
        <span className="text-primary w-full truncate text-xs font-medium">{entry.title}</span>
      )}
      <span className="text-tertiary text-[10px]">
        {itemCount} item{itemCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function NoteGridTile({
  title,
  starred,
  onOpen,
  onToggleStar,
  isRenaming,
  onCommitRename,
  onCancelRename,
  onOpenMenu,
}: {
  title: string;
  starred?: boolean;
  onOpen: () => void;
  onToggleStar: () => void;
  isRenaming: boolean;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onOpenMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="group relative flex min-w-0 w-full flex-col items-center gap-1 text-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-16 w-full items-center justify-center rounded-2xl transition-colors duration-150 group-hover:bg-surface-hover"
      >
        <FileText size={34} strokeWidth={1.25} className="text-icon-outline shrink-0" />
      </button>
      <div className="absolute right-0.5 top-0 flex items-center gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          className={`flex h-5 w-5 items-center justify-center rounded-full transition-opacity duration-150 ${
            starred ? "text-accent opacity-100" : "text-tertiary opacity-0 group-hover:opacity-100"
          }`}
          title={starred ? "Unstar" : "Star"}
          aria-label={starred ? `Unstar ${title}` : `Star ${title}`}
          aria-pressed={!!starred}
        >
          <Star size={12} className={starred ? "fill-current" : ""} />
        </button>
        <button
          type="button"
          onClick={onOpenMenu}
          className="btn-ghost h-5 w-5 opacity-0 group-hover:opacity-100"
          title="Note options"
          aria-label={`Options for ${title}`}
        >
          <MoreHorizontal size={12} />
        </button>
      </div>
      {isRenaming ? (
        <RenameInput initialValue={title} onCommit={onCommitRename} onCancel={onCancelRename} />
      ) : (
        <span className="text-primary w-full truncate text-xs font-medium">{title}</span>
      )}
    </div>
  );
}

/** Flat row used by Starred's tree/list view - notes there have no folder hierarchy worth
 * expanding, just their parent path as a hint. */
function FlatNoteRow({
  note,
  onOpen,
  onToggleStar,
  isRenaming,
  onCommitRename,
  onCancelRename,
  onOpenMenu,
}: {
  note: NoteSummary;
  onOpen: () => void;
  onToggleStar: () => void;
  isRenaming: boolean;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onOpenMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={isRenaming ? undefined : onOpen}
      role="button"
      tabIndex={0}
      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-secondary transition-colors duration-150 ${
        isRenaming ? "" : "cursor-pointer hover:bg-surface-hover hover:text-primary"
      }`}
    >
      <FileText size={14} className="text-icon-outline shrink-0" />
      <div className="min-w-0 flex-1">
        {isRenaming ? (
          <RenameInput initialValue={note.title} onCommit={onCommitRename} onCancel={onCancelRename} />
        ) : (
          <span className="block truncate">{note.title}</span>
        )}
        <p className="text-tertiary truncate text-xs">{note.parentPath || "All Notes"}</p>
      </div>
      {!isRenaming && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar();
            }}
            className="btn-ghost text-accent h-5 w-5"
            title="Unstar"
            aria-label={`Unstar ${note.title}`}
          >
            <Star size={11} className="fill-current" />
          </button>
          <button
            type="button"
            onClick={onOpenMenu}
            className="btn-ghost h-5 w-5 opacity-0 group-hover:opacity-100"
            title="Note options"
            aria-label={`Options for ${note.title}`}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function TrashRow({
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
        {selected ? <CheckSquare size={14} className="text-accent" /> : <Square size={14} />}
      </button>
      {item.type === "folder" ? (
        <Folder size={14} className="text-tertiary shrink-0" />
      ) : (
        <FileText size={14} className="text-tertiary shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className="block truncate">{item.title}</span>
        <p className="text-tertiary truncate text-xs">Deleted {formatRelativeTime(item.deletedAt)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          className="btn-ghost h-6 w-6 opacity-0 group-hover:opacity-100"
          title="Restore"
          aria-label={`Restore ${item.title}`}
        >
          <RotateCcw size={12} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteForever();
          }}
          className="btn-ghost hover:text-danger h-6 w-6 opacity-0 group-hover:opacity-100"
          title="Delete forever"
          aria-label={`Delete ${item.title} forever`}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
