import type { TreeEntry } from "../types";
import { parseNoteLinkHref } from "../milkdown/noteLinkHref";
import { flattenNotes, noteMtimeMs, readBacklinksIndexFile, readNote, titleFromNotePath, writeBacklinksIndexFile } from "./fsNotes";

export interface OutgoingLink {
  targetPath: string;
  headingAnchor?: string;
  /** Best-effort human label for the anchor, derived from the slug itself (dashes -> spaces)
   * since this index only ever sees raw saved Markdown, never the live heading text. */
  headingLabel?: string;
  /** Set instead of headingAnchor when the link points at a `notePin` (see notePin.ts) planted
   * via the selection toolbar's "Copy link to this point", rather than a heading. */
  pinAnchor?: string;
  linkText: string;
  /** Plain-ish text surrounding the link occurrence, for the backlinks panel's preview. */
  snippet: string;
}

export interface BacklinkHit {
  sourcePath: string;
  sourceTitle: string;
  headingAnchor?: string;
  headingLabel?: string;
  pinAnchor?: string;
  snippet: string;
}

interface PersistedState {
  version: number;
  mtimes: Record<string, number>;
  outgoing: Record<string, OutgoingLink[]>;
}

/** Bump if OutgoingLink's shape changes, to invalidate old caches. */
const INDEX_VERSION = 1;

// Module-level singleton, same shape as searchIndex.ts: outgoing[path] = the note-links found
// in that note's own content. Backlinks ("who links to X") are derived by scanning this at query
// time (see getBacklinksFor) rather than maintaining a separately-synced inverted map - the two
// data structures could otherwise drift apart, and this index is small enough that an O(n) scan
// per lookup is cheap.
let outgoing = new Map<string, OutgoingLink[]>();
// Mirrors which paths are currently indexed and when they were last read, so a cold start only
// re-reads notes whose content actually changed since the index was last persisted.
let mtimes = new Map<string, number>();
let ready = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// No React state of its own (this is a plain module singleton, same as searchIndex.ts) - the
// Sidebar's backlinks section needs some way to know when to re-render, so it subscribes here.
const listeners = new Set<() => void>();

/** Notified after every mutation, so UI (e.g. Sidebar's backlinks section) can re-render without
 * polling or threading this module's state through App.tsx as props. */
export function subscribeToBacklinksIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  for (const listener of listeners) listener();
}

/** Whether the index has completed at least one build/reconciliation this session. */
export function isBacklinksIndexReady(): boolean {
  return ready;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persist();
  }, 2000);
}

async function persist(): Promise<void> {
  const state: PersistedState = {
    version: INDEX_VERSION,
    mtimes: Object.fromEntries(mtimes),
    outgoing: Object.fromEntries(outgoing),
  };
  await writeBacklinksIndexFile(JSON.stringify(state));
}

/** Loads the persisted index cache from disk, if any. Falls back to an empty index (rebuilt by
 * the next `syncBacklinksIndex` call) if it's missing or corrupt. */
export async function loadPersistedBacklinksIndex(): Promise<void> {
  const raw = await readBacklinksIndexFile();
  if (!raw) return;
  try {
    const state = JSON.parse(raw) as PersistedState;
    if (state.version !== INDEX_VERSION) return;
    outgoing = new Map(Object.entries(state.outgoing));
    mtimes = new Map(Object.entries(state.mtimes));
  } catch {
    outgoing = new Map();
    mtimes = new Map();
  }
}

// Asymmetric window kept small on both sides - this is a compact preview row in a list, not a
// search result, so it only needs to prove *that* a link exists, not read like an excerpt.
const SNIPPET_RADIUS = 60;

/** Reduces a raw Markdown window to roughly plain text for the backlinks panel's preview -
 * deliberately approximate, same spirit as searchIndex.ts's toPlainText. */
function plainize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinkSnippet(content: string, matchStart: number, matchEnd: number): string {
  const start = Math.max(0, matchStart - SNIPPET_RADIUS);
  const end = Math.min(content.length, matchEnd + SNIPPET_RADIUS);
  const before = start > 0 ? "…" : "";
  const after = end < content.length ? "…" : "";
  return before + plainize(content.slice(start, end)) + after;
}

// Matches `[text](note://...)` and `[text](note://... "title")`, same regex-over-raw-Markdown
// pragmatism searchIndex.ts already uses rather than parsing via ProseMirror.
const NOTE_LINK_PATTERN = /\[([^\]]*)\]\(\s*(note:\/\/[^\s)]+)(?:\s+"([^"]*)")?\s*\)/g;

// The toolbar/picker (see Editor.tsx's insertNoteLink) sets a heading-anchored link's title to
// exactly this shape, so the real heading text can be recovered for display here instead of
// falling back to a lossy slug-derived approximation.
const TITLE_HEADING_LABEL = /^(.*)\s·\s⌘-click to open$/;

function extractHeadingLabel(title: string | undefined, headingId: string | undefined): string | undefined {
  if (!headingId) return undefined;
  const fromTitle = title ? TITLE_HEADING_LABEL.exec(title)?.[1] : undefined;
  return fromTitle || headingId.replace(/-/g, " ");
}

function parseOutgoingLinks(content: string): OutgoingLink[] {
  const links: OutgoingLink[] = [];
  for (const match of content.matchAll(NOTE_LINK_PATTERN)) {
    const target = parseNoteLinkHref(match[2]);
    if (!target) continue;
    const matchStart = match.index ?? 0;
    links.push({
      targetPath: target.path,
      headingAnchor: target.headingId,
      headingLabel: extractHeadingLabel(match[3], target.headingId),
      pinAnchor: target.pinId,
      linkText: match[1],
      snippet: extractLinkSnippet(content, matchStart, matchStart + match[0].length),
    });
  }
  return links;
}

function setOutgoing(path: string, links: OutgoingLink[], mtime: number) {
  outgoing.set(path, links);
  mtimes.set(path, mtime);
  scheduleSave();
  notifyListeners();
}

export function addNoteToBacklinksIndex(path: string, content: string): void {
  setOutgoing(path, parseOutgoingLinks(content), Date.now());
}

export const updateNoteInBacklinksIndex = addNoteToBacklinksIndex;

export function removeNoteFromBacklinksIndex(path: string): void {
  if (!outgoing.has(path)) return;
  outgoing.delete(path);
  mtimes.delete(path);
  scheduleSave();
  notifyListeners();
}

/** Removes a note, or every indexed note nested under a deleted folder. */
export function removePathFromBacklinksIndex(path: string): void {
  removeNoteFromBacklinksIndex(path);
  const prefix = `${path}/`;
  for (const indexed of [...outgoing.keys()]) {
    if (indexed.startsWith(prefix)) removeNoteFromBacklinksIndex(indexed);
  }
}

/** Re-keys a note's (or a folder's nested notes') own outgoing-links entry after a rename/move.
 * Deliberately does NOT rewrite other notes' stored `note://oldPath` hrefs that pointed at it -
 * see the plan's "known limitations" for why that's out of scope. Those links simply stop
 * resolving (and drop out of this note's backlinks) until the linking note is itself re-edited. */
export function movePathInBacklinksIndex(oldPath: string, newPath: string): void {
  if (outgoing.has(oldPath)) {
    const links = outgoing.get(oldPath) as OutgoingLink[];
    const mtime = mtimes.get(oldPath) ?? Date.now();
    removeNoteFromBacklinksIndex(oldPath);
    setOutgoing(newPath, links, mtime);
  }

  const prefix = `${oldPath}/`;
  for (const indexed of [...outgoing.keys()]) {
    if (!indexed.startsWith(prefix)) continue;
    const links = outgoing.get(indexed) as OutgoingLink[];
    const mtime = mtimes.get(indexed) ?? Date.now();
    const rest = indexed.slice(oldPath.length);
    removeNoteFromBacklinksIndex(indexed);
    setOutgoing(newPath + rest, links, mtime);
  }
}

/** Builds/refreshes the index against the current note tree. Only reads a note's content from
 * disk if it's new or its mtime changed since it was last indexed. */
export async function syncBacklinksIndex(tree: TreeEntry[]): Promise<void> {
  const notes = flattenNotes(tree);

  if (notes.length > 0) {
    const currentPaths = new Set(notes.map((n) => n.path));
    for (const path of [...mtimes.keys()]) {
      if (!currentPaths.has(path)) removeNoteFromBacklinksIndex(path);
    }
  }

  await Promise.all(
    notes.map(async (note) => {
      let mtime: number;
      try {
        mtime = await noteMtimeMs(note.path);
      } catch {
        return; // Deleted mid-scan; the next sync will reconcile it.
      }
      if (mtimes.get(note.path) === mtime && outgoing.has(note.path)) return;

      const content = await readNote(note.path).catch(() => "");
      setOutgoing(note.path, parseOutgoingLinks(content), mtime);
    }),
  );

  ready = true;
  scheduleSave();
}

/** Notes that link to `targetPath`, each with a preview snippet and (if the link targets a
 * specific heading) that heading's anchor/label. Excludes a note linking to itself - that's an
 * internal jump, not another note's "backlink". */
export function getBacklinksFor(targetPath: string): BacklinkHit[] {
  const hits: BacklinkHit[] = [];
  for (const [sourcePath, links] of outgoing) {
    if (sourcePath === targetPath) continue;
    for (const link of links) {
      if (link.targetPath !== targetPath) continue;
      hits.push({
        sourcePath,
        sourceTitle: titleFromNotePath(sourcePath),
        headingAnchor: link.headingAnchor,
        headingLabel: link.headingLabel,
        pinAnchor: link.pinAnchor,
        snippet: link.snippet,
      });
    }
  }
  return hits;
}

/** Notes linking to one specific pinned point within `targetPath` (see notePin.ts), for that
 * pin's popover - a narrower version of getBacklinksFor filtered down to just that anchor,
 * rather than every link into the note. Deduped by source note: the popover just lists *which*
 * notes link here, so a note linking to the same point twice shouldn't show up twice. */
export function getBacklinksForAnchor(targetPath: string, pinId: string): BacklinkHit[] {
  const hits = getBacklinksFor(targetPath).filter((hit) => hit.pinAnchor === pinId);
  const seen = new Set<string>();
  return hits.filter((hit) => (seen.has(hit.sourcePath) ? false : (seen.add(hit.sourcePath), true)));
}
