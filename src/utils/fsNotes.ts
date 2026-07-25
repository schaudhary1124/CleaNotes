import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { extractStudyItemsAndStrip } from "./markdownParser";
import type { FolderEntry, NoteEntry, NoteLook, NoteSummary, SketchData, StudyItem, TreeEntry } from "../types";

/** Notes live under the user's OS Documents folder, e.g. ~/Documents/PlaiNotes */
export const NOTES_DIR = "PlaiNotes";
const NOTE_EXTENSION = ".md";
// No leading dot: Tauri's fs scope glob matching (`PlaiNotes/**`) doesn't match dotfiles,
// which would silently block reads/writes under this folder. Hidden from the notes tree
// via an explicit name check in buildTree instead.
const ASSETS_DIR = "assets";
// Same no-leading-dot reasoning as ASSETS_DIR. Deleted notes/folders are moved here (see
// deleteNote/deleteFolder) rather than removed outright, keyed flatly by a random id so two
// items with the same name/path can never collide inside trash - see trashName below.
const TRASH_DIR = "trash";
// Sibling file next to the note (not a dot-directory): Tauri's fs scope glob matching
// (`PlaiNotes/**`) doesn't match dotfiles, which would silently block reads/writes -
// see the META_FILE note below. A same-folder sidecar with a non-".md" extension is
// already invisible to buildTree without needing a leading dot.
const SKETCH_EXTENSION = ".sketch.json";
// Sidecar file next to the note holding its flashcards/MCQs, kept fully
// separate from the note's Markdown content/editor - see StudyView.tsx.
const STUDY_EXTENSION = ".study.json";
// No leading dot: Tauri's fs scope glob matching (`PlaiNotes/**`) doesn't match dotfiles,
// which would silently block reads/writes of this file.
const META_FILE = "plainotes-meta.json";
// No leading dot, same reasoning as META_FILE above. This is a cache the search
// index rebuilds from if missing or unreadable, so it's fine to skip it silently.
const SEARCH_INDEX_FILE = "plainotes-search-index.json";
// No leading dot, same reasoning as SEARCH_INDEX_FILE above - also just a rebuildable cache.
const BACKLINKS_INDEX_FILE = "plainotes-backlinks-index.json";
const BASE_DIR = BaseDirectory.Document;

export const STARTER_CONTENT = "";

/** A trashed note/folder's record in NotesMeta.trash, keyed by its current (flat, uuid-prefixed)
 * path under TRASH_DIR - see deleteNote/deleteFolder. */
interface TrashMetaEntry {
  /** Where this item lived before being trashed - used to restore it and to derive its
   * display title, so nothing about it needs to be kept in sync separately. */
  originalPath: string;
  deletedAt: number;
  type: "note" | "folder";
}

interface NotesMeta {
  /** Maps a folder's relative path to a preset color name from FOLDER_COLORS */
  folderColors: Record<string, string>;
  /** Maps a note's or folder's relative path to when it was created, in epoch ms.
   * Tracked explicitly rather than read off filesystem birthtime, which Tauri
   * notes "may not be available on all platforms" (notably Linux). */
  createdAt: Record<string, number>;
  /** Maps a note's relative path to its visual look (see NoteLook). Notes without
   * an entry here use the "plain" look. */
  noteLooks: Record<string, string>;
  /** Set of starred note paths (value is always `true` - only presence matters). */
  starred: Record<string, true>;
  /** Trashed items, keyed by their current path under TRASH_DIR. Deliberately NOT touched by
   * remapMetaPaths/dropMetaPaths (those operate on the other fields only) - trashing/restoring/
   * purging manage this field directly, since a trash entry's key IS the rename target/source. */
  trash: Record<string, TrashMetaEntry>;
}

async function readMeta(): Promise<NotesMeta> {
  try {
    const raw = await readTextFile(fullPath(META_FILE), { baseDir: BASE_DIR });
    const parsed = JSON.parse(raw);
    return {
      folderColors: parsed.folderColors ?? {},
      createdAt: parsed.createdAt ?? {},
      noteLooks: parsed.noteLooks ?? {},
      starred: parsed.starred ?? {},
      trash: parsed.trash ?? {},
    };
  } catch {
    return { folderColors: {}, createdAt: {}, noteLooks: {}, starred: {}, trash: {} };
  }
}

function writeMeta(meta: NotesMeta): Promise<void> {
  return writeTextFile(fullPath(META_FILE), JSON.stringify(meta, null, 2), { baseDir: BASE_DIR });
}

// Serializes every readMeta()->mutate->writeMeta() sequence in this window, so two rapid calls
// (e.g. quick double-clicks on a star toggle) can't race and silently clobber each other's write
// - each call was already an independent, non-atomic read-modify-write round trip before this.
// Scoped to this module instance only: it does NOT protect against two separate windows writing
// meta at the same time (see App.tsx's multi-window notes) - that stays an accepted, unchanged risk.
let metaQueue: Promise<unknown> = Promise.resolve();
function withMetaLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = metaQueue.then(fn, fn);
  metaQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Reads the persisted search index cache, or null if it doesn't exist yet / is unreadable. */
export async function readSearchIndexFile(): Promise<string | null> {
  try {
    return await readTextFile(fullPath(SEARCH_INDEX_FILE), { baseDir: BASE_DIR });
  } catch {
    return null;
  }
}

export function writeSearchIndexFile(json: string): Promise<void> {
  return writeTextFile(fullPath(SEARCH_INDEX_FILE), json, { baseDir: BASE_DIR });
}

/** Reads the persisted backlinks index cache, or null if it doesn't exist yet / is unreadable. */
export async function readBacklinksIndexFile(): Promise<string | null> {
  try {
    return await readTextFile(fullPath(BACKLINKS_INDEX_FILE), { baseDir: BASE_DIR });
  } catch {
    return null;
  }
}

export function writeBacklinksIndexFile(json: string): Promise<void> {
  return writeTextFile(fullPath(BACKLINKS_INDEX_FILE), json, { baseDir: BASE_DIR });
}

/** Last-modified time of a note, in epoch ms - used to detect notes changed outside the app. */
export async function noteMtimeMs(notePath: string): Promise<number> {
  const info = await stat(fullPath(notePath), { baseDir: BASE_DIR });
  return info.mtime?.getTime() ?? 0;
}

/** Repoints any entries under `oldPath` (exact match or nested) to `newPath`. */
function remapPathKeys<T>(map: Record<string, T>, oldPath: string, newPath: string): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key === oldPath) result[newPath] = value;
    else if (key.startsWith(`${oldPath}/`)) result[newPath + key.slice(oldPath.length)] = value;
    else result[key] = value;
  }
  return result;
}

/** Drops any entries at or under `path`. */
function dropPathKeys<T>(map: Record<string, T>, path: string): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key === path || key.startsWith(`${path}/`)) continue;
    result[key] = value;
  }
  return result;
}

/** Repoints any meta entries under `oldPath` to `newPath`, for renames/moves. Leaves `trash`
 * untouched - see its doc comment on NotesMeta. */
function remapMetaPaths(meta: NotesMeta, oldPath: string, newPath: string): NotesMeta {
  return {
    ...meta,
    folderColors: remapPathKeys(meta.folderColors, oldPath, newPath),
    createdAt: remapPathKeys(meta.createdAt, oldPath, newPath),
    noteLooks: remapPathKeys(meta.noteLooks, oldPath, newPath),
    starred: remapPathKeys(meta.starred, oldPath, newPath),
  };
}

/** Drops any meta entries at or under `path`, for permanent deletions. Leaves `trash`
 * untouched - see its doc comment on NotesMeta. */
function dropMetaPaths(meta: NotesMeta, path: string): NotesMeta {
  return {
    ...meta,
    folderColors: dropPathKeys(meta.folderColors, path),
    createdAt: dropPathKeys(meta.createdAt, path),
    noteLooks: dropPathKeys(meta.noteLooks, path),
    starred: dropPathKeys(meta.starred, path),
  };
}

/** Sets (or clears, when `color` is null) the preset color for the folder at `path`. */
export async function setFolderColor(path: string, color: string | null): Promise<void> {
  return withMetaLock(async () => {
    const meta = await readMeta();
    if (color) meta.folderColors[path] = color;
    else delete meta.folderColors[path];
    await writeMeta(meta);
  });
}

/** Reads the visual look for the note at `path`, or "plain" if unset. */
export async function getNoteLook(path: string): Promise<NoteLook> {
  const meta = await readMeta();
  return (meta.noteLooks[path] as NoteLook | undefined) ?? "plain";
}

/** Sets (or clears, when `look` is "plain") the visual look for the note at `path`. */
export async function setNoteLook(path: string, look: NoteLook): Promise<void> {
  return withMetaLock(async () => {
    const meta = await readMeta();
    if (look !== "plain") meta.noteLooks[path] = look;
    else delete meta.noteLooks[path];
    await writeMeta(meta);
  });
}

/** Sets (or clears) whether the note at `path` is starred. */
export async function setStarred(path: string, value: boolean): Promise<void> {
  return withMetaLock(async () => {
    const meta = await readMeta();
    if (value) meta.starred[path] = true;
    else delete meta.starred[path];
    await writeMeta(meta);
  });
}

function titleFromFileName(name: string): string {
  return name.endsWith(NOTE_EXTENSION) ? name.slice(0, -NOTE_EXTENSION.length) : name;
}

/** Derives a note's display title straight from its path, e.g. "Work/Todo.md" -> "Todo". */
export function titleFromNotePath(notePath: string): string {
  return titleFromFileName(nameOf(notePath));
}

function fullPath(relPath: string): string {
  return relPath ? `${NOTES_DIR}/${relPath}` : NOTES_DIR;
}

function parentOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

function nameOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Sidecar ink path for a note, e.g. "Work/Todo.md" -> "Work/Todo.sketch.json" */
function sketchPathFor(notePath: string): string {
  return notePath.slice(0, -NOTE_EXTENSION.length) + SKETCH_EXTENSION;
}

/** Sidecar study-items path for a note, e.g. "Work/Todo.md" -> "Work/Todo.study.json" */
function studyPathFor(notePath: string): string {
  return notePath.slice(0, -NOTE_EXTENSION.length) + STUDY_EXTENSION;
}

/** Creates the PlaiNotes folder in Documents on first run, if it doesn't exist yet. */
export async function ensureNotesDir(): Promise<void> {
  const dirExists = await exists(NOTES_DIR, { baseDir: BASE_DIR });
  if (!dirExists) {
    await mkdir(NOTES_DIR, { baseDir: BASE_DIR, recursive: true });
  }
}

async function buildTree(relDir: string, meta: NotesMeta): Promise<TreeEntry[]> {
  const entries = await readDir(fullPath(relDir), { baseDir: BASE_DIR });
  const relevant = entries.filter((entry) => {
    if (!entry.name || entry.name.startsWith(".")) return false;
    if (relDir === "" && (entry.name === ASSETS_DIR || entry.name === TRASH_DIR)) return false;
    return entry.isDirectory || (entry.isFile && entry.name.endsWith(NOTE_EXTENSION));
  });

  // Every sibling name in this directory (including sidecar files that `relevant` filters
  // out), used below to derive hasStudyItems for free from data already fetched - see its
  // comment inline. Cheaper than a separate exists()/readStudyItems() call per note, which
  // would mean parsing every .study.json in the vault on every refreshTree().
  const siblingNames = new Set(entries.map((e) => e.name).filter((n): n is string => Boolean(n)));

  // Subdirectories are read in parallel rather than one at a time: each
  // readDir is a Tauri IPC round-trip, and awaiting them sequentially made
  // the walk's latency scale with total folder count instead of tree depth.
  const result = await Promise.all(
    relevant.map(async (entry): Promise<TreeEntry> => {
      const relPath = joinPath(relDir, entry.name);
      // birthtime isn't reliable on every platform, so it's only a fallback
      // for entries that predate createdAt tracking in the meta file.
      const info = await stat(fullPath(relPath), { baseDir: BASE_DIR }).catch(() => null);
      const modifiedAt = info?.mtime?.getTime();
      const createdAt = meta.createdAt[relPath] ?? info?.birthtime?.getTime() ?? modifiedAt;
      if (entry.isDirectory) {
        const children = await buildTree(relPath, meta);
        const folder: FolderEntry = {
          type: "folder",
          path: relPath,
          title: entry.name,
          parentPath: relDir,
          children,
          color: meta.folderColors[relPath],
          createdAt,
          modifiedAt,
        };
        return folder;
      }
      const studySiblingName = entry.name.slice(0, -NOTE_EXTENSION.length) + STUDY_EXTENSION;
      const note: NoteEntry = {
        type: "note",
        path: relPath,
        title: titleFromFileName(entry.name),
        parentPath: relDir,
        createdAt,
        modifiedAt,
        starred: meta.starred[relPath],
        hasStudyItems: siblingNames.has(studySiblingName),
      };
      return note;
    }),
  );

  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  return result;
}

/** Recursively reads the notes folder into a tree of folders and notes. */
export async function listNoteTree(): Promise<TreeEntry[]> {
  const meta = await readMeta();
  return buildTree("", meta);
}

export function flattenNotes(tree: TreeEntry[]): NoteSummary[] {
  const notes: NoteSummary[] = [];
  for (const entry of tree) {
    if (entry.type === "note") {
      notes.push({
        path: entry.path,
        title: entry.title,
        parentPath: entry.parentPath,
        createdAt: entry.createdAt,
        modifiedAt: entry.modifiedAt,
        starred: entry.starred,
        hasStudyItems: entry.hasStudyItems,
      });
    } else {
      notes.push(...flattenNotes(entry.children));
    }
  }
  return notes;
}

export function flattenFolders(tree: TreeEntry[]): FolderEntry[] {
  const folders: FolderEntry[] = [];
  for (const entry of tree) {
    if (entry.type !== "folder") continue;
    folders.push(entry);
    folders.push(...flattenFolders(entry.children));
  }
  return folders;
}

export function readNote(path: string): Promise<string> {
  return readTextFile(fullPath(path), { baseDir: BASE_DIR });
}

export function writeNote(path: string, content: string): Promise<void> {
  return writeTextFile(fullPath(path), content, { baseDir: BASE_DIR });
}

/** A flat, collision-proof name for a trashed item - not a mirror of its original nested
 * path, so trashing the same original path twice (delete, recreate, delete again) can never
 * clash inside trash/. Restore relies solely on the recorded originalPath, not this name. */
function trashName(originalRelPath: string): string {
  return `${crypto.randomUUID()}-${nameOf(originalRelPath)}`;
}

/** Soft-deletes the note at `path`: moves it (with its sketch/study sidecars intact) into
 * trash/ instead of removing it, so it can be restored - see restoreFromTrash. Permanently
 * removed only via deleteForever, or automatically after 30 days - see purgeExpiredTrash. */
export async function deleteNote(path: string): Promise<void> {
  return withMetaLock(async () => {
    const trashPath = joinPath(TRASH_DIR, trashName(path));
    await mkdir(fullPath(TRASH_DIR), { baseDir: BASE_DIR, recursive: true });
    await rename(fullPath(path), fullPath(trashPath), {
      oldPathBaseDir: BASE_DIR,
      newPathBaseDir: BASE_DIR,
    });
    await relocateSketch(path, trashPath);
    await relocateStudyItems(path, trashPath);

    const meta = await readMeta();
    const next = remapMetaPaths(meta, path, trashPath);
    next.trash[trashPath] = { originalPath: path, deletedAt: Date.now(), type: "note" };
    await writeMeta(next);
  });
}

/** Soft-deletes the folder at `path` and everything inside it - see deleteNote. A folder's
 * sidecars move for free since the whole subtree relocates in one rename() call. */
export async function deleteFolder(path: string): Promise<void> {
  return withMetaLock(async () => {
    const trashPath = joinPath(TRASH_DIR, trashName(path));
    await mkdir(fullPath(TRASH_DIR), { baseDir: BASE_DIR, recursive: true });
    await rename(fullPath(path), fullPath(trashPath), {
      oldPathBaseDir: BASE_DIR,
      newPathBaseDir: BASE_DIR,
    });

    const meta = await readMeta();
    const next = remapMetaPaths(meta, path, trashPath);
    next.trash[trashPath] = { originalPath: path, deletedAt: Date.now(), type: "folder" };
    await writeMeta(next);
  });
}

/** An item currently sitting in Recently Deleted, ready to display. */
export interface TrashItem {
  /** Its current path under trash/ - pass this to restoreFromTrash/deleteForever. */
  trashPath: string;
  originalPath: string;
  type: "note" | "folder";
  title: string;
  deletedAt: number;
}

/** Lists everything in Recently Deleted, most recently deleted first. Reads only the meta
 * file - trash contents are never walked directly. */
export async function listTrash(): Promise<TrashItem[]> {
  const meta = await readMeta();
  return Object.entries(meta.trash)
    .map(([trashPath, entry]) => ({
      trashPath,
      originalPath: entry.originalPath,
      type: entry.type,
      title: entry.type === "note" ? titleFromNotePath(entry.originalPath) : nameOf(entry.originalPath),
      deletedAt: entry.deletedAt,
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

export interface RestoreResult {
  /** Where the item actually ended up - may differ from its original path if that name is
   * now taken (deduped, same as create) or its parent folder no longer exists (see below). */
  path: string;
  /** True if the original parent folder was gone (deleted/moved/itself still trashed), so
   * this was restored to the vault root instead - callers should surface this in a toast. */
  restoredToRoot: boolean;
}

/** Restores a trashed note or folder back out of Recently Deleted. */
export async function restoreFromTrash(trashPath: string): Promise<RestoreResult> {
  return withMetaLock(async () => {
    const meta = await readMeta();
    const record = meta.trash[trashPath];
    if (!record) throw new Error("This item is no longer in Recently Deleted");
    const { originalPath, type } = record;

    let targetParent = parentOf(originalPath);
    const restoredToRoot = targetParent !== "" && !(await exists(fullPath(targetParent), { baseDir: BASE_DIR }));
    if (restoredToRoot) targetParent = "";

    const desiredName = nameOf(originalPath);
    let finalPath: string;
    if (type === "folder") {
      const name = await uniqueName(targetParent, desiredName, "");
      finalPath = joinPath(targetParent, name);
    } else {
      const title = await uniqueNoteTitle(titleFromFileName(desiredName));
      finalPath = joinPath(targetParent, `${title}${NOTE_EXTENSION}`);
    }

    await rename(fullPath(trashPath), fullPath(finalPath), {
      oldPathBaseDir: BASE_DIR,
      newPathBaseDir: BASE_DIR,
    });

    const next = remapMetaPaths(meta, trashPath, finalPath);
    delete next.trash[trashPath];
    await writeMeta(next);

    if (type === "note") {
      await relocateSketch(trashPath, finalPath);
      await relocateStudyItems(trashPath, finalPath);
    }

    return { path: finalPath, restoredToRoot };
  });
}

/** Permanently removes a trashed note or folder - this is the one truly irreversible action. */
export async function deleteForever(trashPath: string, type: "note" | "folder"): Promise<void> {
  return withMetaLock(async () => {
    if (type === "folder") {
      await remove(fullPath(trashPath), { baseDir: BASE_DIR, recursive: true });
    } else {
      await remove(fullPath(trashPath), { baseDir: BASE_DIR });
      await deleteSketch(trashPath);
      await deleteStudyItems(trashPath);
    }
    const meta = await readMeta();
    // dropMetaPaths cleans up the color/createdAt/noteLook/starred entries that were
    // *remapped* (not dropped) to this trash-relative key when the item was trashed -
    // skipping this would leak them forever, keyed to a path that no longer exists.
    const next = dropMetaPaths(meta, trashPath);
    delete next.trash[trashPath];
    await writeMeta(next);
  });
}

const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Permanently removes anything that's been in Recently Deleted longer than `maxAgeMs`
 * (default 30 days). Meant to run once at boot - see App.tsx. Returns how many were purged. */
export async function purgeExpiredTrash(maxAgeMs: number = TRASH_MAX_AGE_MS): Promise<number> {
  return withMetaLock(async () => {
    const meta = await readMeta();
    const cutoff = Date.now() - maxAgeMs;
    const expired = Object.entries(meta.trash).filter(([, entry]) => entry.deletedAt < cutoff);
    if (expired.length === 0) return 0;

    for (const [trashPath, entry] of expired) {
      try {
        if (entry.type === "folder") {
          await remove(fullPath(trashPath), { baseDir: BASE_DIR, recursive: true });
        } else {
          await remove(fullPath(trashPath), { baseDir: BASE_DIR });
          await deleteSketch(trashPath);
          await deleteStudyItems(trashPath);
        }
      } catch {
        // Already gone from disk somehow - still drop its meta entry below.
      }
    }

    let next = meta;
    for (const [trashPath] of expired) next = dropMetaPaths(next, trashPath);
    for (const [trashPath] of expired) delete next.trash[trashPath];
    await writeMeta(next);
    return expired.length;
  });
}

async function uniqueName(parentPath: string, base: string, ext: string): Promise<string> {
  const dirExists = await exists(fullPath(parentPath), { baseDir: BASE_DIR });
  const taken = new Set<string>();
  if (dirExists) {
    const entries = await readDir(fullPath(parentPath), { baseDir: BASE_DIR });
    entries.forEach((entry) => entry.name && taken.add(entry.name));
  }

  let name = `${base}${ext}`;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${base} ${suffix}${ext}`;
    suffix += 1;
  }
  return name;
}

/** All note titles currently in use across the whole vault, optionally excluding one path. */
async function allNoteTitles(excludePath?: string): Promise<Set<string>> {
  const tree = await listNoteTree();
  const titles = new Set<string>();
  for (const note of flattenNotes(tree)) {
    if (note.path === excludePath) continue;
    titles.add(note.title);
  }
  return titles;
}

/** Finds a unique note title (unique across the whole vault, matching how notes are already
 * addressed by title alone in tabs/search) by appending " 2", " 3", etc. if `base` is taken -
 * shared by createNote and restoreFromTrash. */
async function uniqueNoteTitle(base: string, excludePath?: string): Promise<string> {
  const taken = await allNoteTitles(excludePath);
  let title = base;
  let suffix = 2;
  while (taken.has(title)) {
    title = `${base} ${suffix}`;
    suffix += 1;
  }
  return title;
}

/** Creates a new note with a unique name (unique across the whole vault) inside `parentPath`. */
export async function createNote(
  parentPath: string,
  desiredTitle?: string,
  content: string = STARTER_CONTENT,
  look: NoteLook = "plain",
): Promise<NoteSummary> {
  return withMetaLock(async () => {
    const title = await uniqueNoteTitle(desiredTitle?.trim() || "Untitled");
    const relPath = joinPath(parentPath, `${title}${NOTE_EXTENSION}`);
    await writeNote(relPath, content);

    const meta = await readMeta();
    meta.createdAt[relPath] = Date.now();
    if (look !== "plain") meta.noteLooks[relPath] = look;
    await writeMeta(meta);

    return { path: relPath, title, parentPath };
  });
}

/** Creates a new folder with a unique name inside `parentPath`, optionally with a preset color. */
export async function createFolder(
  parentPath: string,
  desiredName?: string,
  color?: string | null,
): Promise<string> {
  return withMetaLock(async () => {
    const base = desiredName?.trim() || "New Folder";
    const name = await uniqueName(parentPath, base, "");
    const relPath = joinPath(parentPath, name);
    await mkdir(fullPath(relPath), { baseDir: BASE_DIR, recursive: true });

    const meta = await readMeta();
    meta.createdAt[relPath] = Date.now();
    if (color) meta.folderColors[relPath] = color;
    await writeMeta(meta);

    return relPath;
  });
}

/** Renames a note or folder in place, keeping it in the same parent folder. */
export async function renameEntry(
  path: string,
  newTitle: string,
  isFolder: boolean,
): Promise<string> {
  return withMetaLock(async () => {
    const trimmed = newTitle.trim();
    if (!trimmed) throw new Error("Name cannot be empty");

    const parent = parentOf(path);
    const newName = isFolder ? trimmed : `${trimmed}${NOTE_EXTENSION}`;
    const newPath = joinPath(parent, newName);
    if (newPath === path) return path;

    if (isFolder) {
      const clash = await exists(fullPath(newPath), { baseDir: BASE_DIR });
      if (clash) throw new Error(`"${trimmed}" already exists here`);
    } else {
      const taken = await allNoteTitles(path);
      if (taken.has(trimmed)) throw new Error(`A note named "${trimmed}" already exists`);
    }

    await rename(fullPath(path), fullPath(newPath), {
      oldPathBaseDir: BASE_DIR,
      newPathBaseDir: BASE_DIR,
    });

    const meta = await readMeta();
    await writeMeta(remapMetaPaths(meta, path, newPath));
    if (!isFolder) {
      await relocateSketch(path, newPath);
      await relocateStudyItems(path, newPath);
    }

    return newPath;
  });
}

/** Moves a note or folder to live under `targetParentPath`. */
export async function moveEntry(path: string, targetParentPath: string): Promise<string> {
  return withMetaLock(async () => {
    const name = nameOf(path);
    const newPath = joinPath(targetParentPath, name);
    if (newPath === path) return path;
    if (targetParentPath === path || targetParentPath.startsWith(`${path}/`)) {
      throw new Error("Can't move a folder into itself");
    }

    if (path.endsWith(NOTE_EXTENSION)) {
      const title = titleFromFileName(name);
      const taken = await allNoteTitles(path);
      if (taken.has(title)) throw new Error(`A note named "${title}" already exists`);
    } else {
      const clash = await exists(fullPath(newPath), { baseDir: BASE_DIR });
      if (clash) throw new Error(`"${name}" already exists in that folder`);
    }

    await rename(fullPath(path), fullPath(newPath), {
      oldPathBaseDir: BASE_DIR,
      newPathBaseDir: BASE_DIR,
    });

    const meta = await readMeta();
    await writeMeta(remapMetaPaths(meta, path, newPath));
    if (path.endsWith(NOTE_EXTENSION)) {
      await relocateSketch(path, newPath);
      await relocateStudyItems(path, newPath);
    }

    return newPath;
  });
}

/** Moves a note's ink sidecar (if any) alongside a rename/move of the note itself. */
async function relocateSketch(oldNotePath: string, newNotePath: string): Promise<void> {
  const oldSketchPath = fullPath(sketchPathFor(oldNotePath));
  const sketchExists = await exists(oldSketchPath, { baseDir: BASE_DIR });
  if (!sketchExists) return;
  const newSketchPath = sketchPathFor(newNotePath);
  await mkdir(fullPath(parentOf(newSketchPath)), { baseDir: BASE_DIR, recursive: true });
  await rename(oldSketchPath, fullPath(newSketchPath), {
    oldPathBaseDir: BASE_DIR,
    newPathBaseDir: BASE_DIR,
  });
}

/** Reads a note's ink strokes, or null if it has none. */
export async function readSketch(notePath: string): Promise<SketchData | null> {
  try {
    const raw = await readTextFile(fullPath(sketchPathFor(notePath)), { baseDir: BASE_DIR });
    return JSON.parse(raw) as SketchData;
  } catch {
    return null;
  }
}

/** Persists a note's ink strokes to its sidecar file. */
export async function writeSketch(notePath: string, data: SketchData): Promise<void> {
  const relPath = sketchPathFor(notePath);
  await mkdir(fullPath(parentOf(relPath)), { baseDir: BASE_DIR, recursive: true });
  await writeTextFile(fullPath(relPath), JSON.stringify(data), { baseDir: BASE_DIR });
}

/** Removes a note's ink sidecar, if any. */
export async function deleteSketch(notePath: string): Promise<void> {
  try {
    await remove(fullPath(sketchPathFor(notePath)), { baseDir: BASE_DIR });
  } catch {
    // No sketch existed for this note - nothing to clean up.
  }
}

interface StudyData {
  version: 1;
  items: StudyItem[];
}

/** Reads a note's flashcards/MCQs, or an empty list if it has none. */
export async function readStudyItems(notePath: string): Promise<StudyItem[]> {
  try {
    const raw = await readTextFile(fullPath(studyPathFor(notePath)), { baseDir: BASE_DIR });
    const parsed = JSON.parse(raw) as StudyData;
    return parsed.items ?? [];
  } catch {
    return [];
  }
}

/** Persists a note's flashcards/MCQs to its sidecar file. */
export async function writeStudyItems(notePath: string, items: StudyItem[]): Promise<void> {
  const relPath = studyPathFor(notePath);
  await mkdir(fullPath(parentOf(relPath)), { baseDir: BASE_DIR, recursive: true });
  const data: StudyData = { version: 1, items };
  await writeTextFile(fullPath(relPath), JSON.stringify(data), { baseDir: BASE_DIR });
}

/** Removes a note's study-items sidecar, if any. */
export async function deleteStudyItems(notePath: string): Promise<void> {
  try {
    await remove(fullPath(studyPathFor(notePath)), { baseDir: BASE_DIR });
  } catch {
    // No study items existed for this note - nothing to clean up.
  }
}

/** Moves a note's study-items sidecar (if any) alongside a rename/move of the note itself. */
async function relocateStudyItems(oldNotePath: string, newNotePath: string): Promise<void> {
  const oldStudyPath = fullPath(studyPathFor(oldNotePath));
  const studyExists = await exists(oldStudyPath, { baseDir: BASE_DIR });
  if (!studyExists) return;
  const newStudyPath = studyPathFor(newNotePath);
  await mkdir(fullPath(parentOf(newStudyPath)), { baseDir: BASE_DIR, recursive: true });
  await rename(oldStudyPath, fullPath(newStudyPath), {
    oldPathBaseDir: BASE_DIR,
    newPathBaseDir: BASE_DIR,
  });
}

/**
 * One-time migration for notes saved before Study mode had its own storage:
 * if `notePath` has no study-items sidecar yet, pulls any legacy `Q:`/`MCQ:`
 * lines out of `content` into one, strips them from the note body, and
 * persists both. Returns the (possibly stripped) content the caller should
 * use going forward; a no-op returns `content` unchanged.
 */
export async function migrateLegacyStudyItems(notePath: string, content: string): Promise<string> {
  const alreadyMigrated = await exists(fullPath(studyPathFor(notePath)), { baseDir: BASE_DIR });
  if (alreadyMigrated) return content;

  const { items, content: stripped } = extractStudyItemsAndStrip(content);
  if (items.length === 0) return content;

  const withIds = items.map((item) => ({ ...item, id: crypto.randomUUID() }));
  await writeStudyItems(notePath, withIds);
  await writeNote(notePath, stripped);
  return stripped;
}

/** Saves an image attachment for `notePath` and returns its path relative to the notes root. */
export async function writeAttachment(
  notePath: string,
  fileName: string,
  data: Uint8Array,
): Promise<string> {
  const parent = parentOf(notePath);
  const assetsFolder = joinPath(ASSETS_DIR, parent);
  await mkdir(fullPath(assetsFolder), { baseDir: BASE_DIR, recursive: true });

  const unique = `${crypto.randomUUID()}-${fileName}`;
  const relPath = joinPath(assetsFolder, unique);
  await writeFile(fullPath(relPath), data, { baseDir: BASE_DIR });
  return relPath;
}

export function readAttachment(relPath: string): Promise<Uint8Array> {
  return readFile(fullPath(relPath), { baseDir: BASE_DIR });
}
