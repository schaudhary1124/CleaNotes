import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { Home } from "./components/Home";
import { Editor } from "./components/Editor";
import { StudyView } from "./components/StudyView";
import ErrorBoundary from "./components/ErrorBoundary";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { NewItemDialog } from "./components/NewItemDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { ShareDialog } from "./components/ShareDialog";
import { JoinSharedNoteDialog } from "./components/JoinSharedNoteDialog";
import { ResizeHandles } from "./components/ResizeHandles";
import { TabStrip } from "./components/TabStrip";
import { useAppUpdater } from "./hooks/useAppUpdater";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteForever,
  deleteNote,
  ensureNotesDir,
  flattenNotes,
  listNoteTree,
  listTrash,
  migrateLegacyStudyItems,
  moveEntry,
  purgeExpiredTrash,
  readNote,
  renameEntry,
  restoreFromTrash,
  setFolderColor,
  setStarred,
  writeNote,
  type TrashItem,
} from "./utils/fsNotes";
import { getTemplate } from "./utils/templates";
import { applySettingsToDocument, loadSettings, saveSettings } from "./utils/settings";
import {
  detachInitPromise,
  getTargetFromLocation,
  openWindowInstance,
  MERGE_TAB_EVENT,
  type MergeTabPayload,
} from "./utils/windowInstance";
import { broadcastNoteSaved, listenForNoteSaved } from "./utils/noteSync";
import { getAcl, setLocked } from "./collab/acl";
import { loadOrCreateIdentity } from "./collab/identity";
import { hostSession, type HostedSession } from "./collab/yjsBridge";
import { usePresence } from "./collab/usePresence";
import type { NoteLinkTarget } from "./milkdown/noteLinkHref";
import { loadMainTabSession, saveMainTabSession } from "./utils/tabSession";
import {
  addNoteToIndex,
  loadPersistedSearchIndex,
  movePathInIndex,
  removePathFromIndex,
  syncSearchIndex,
  updateNoteInIndex,
} from "./utils/searchIndex";
import {
  addNoteToBacklinksIndex,
  loadPersistedBacklinksIndex,
  movePathInBacklinksIndex,
  removePathFromBacklinksIndex,
  syncBacklinksIndex,
  updateNoteInBacklinksIndex,
} from "./utils/backlinksIndex";
import type { AppMode, AppSettings, BrowseFilter, TreeEntry } from "./types";

type BootStatus = "loading" | "ready" | "error";

/** Recently Deleted's "Delete forever" is the only remaining destructive action that still
 * needs confirmation - normal delete is instant now that Recently Deleted is the undo path.
 * Holds one or more items so a multi-select "Remove" confirms/deletes them together. */
interface ConfirmAction {
  items: { trashPath: string; type: "note" | "folder"; title: string }[];
}

type NewItemDialogState = { kind: "note" | "folder"; parentPath: string };

const appWindow = getCurrentWindow();
/** Only the main window's tabs are persisted/restored across relaunches - secondary windows
 * (duplicated or detached) are spawned ad hoc and were never restored on relaunch either. */
const isMainWindow = appWindow.label === "main";

// Temporary diagnostics for the "why does a new window take so long" investigation - safe to
// remove once that's resolved. performance.now() is relative to when this document's
// navigation started, so timestamps here reveal how much of the delay happens before this
// module even starts executing (bundle fetch/parse) vs. inside the boot logic below.
const bootStartTime = performance.now();
const bootLog = (...args: unknown[]) =>
  console.log("[boot]", `+${(performance.now() - bootStartTime).toFixed(0)}ms`, ...args);
bootLog("module evaluating", { label: appWindow.label });

/** Repoints a tab's note path when its note (or an ancestor folder) is renamed/moved. */
function remapTabPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return path;
}

/** Picks which tab should become active after `removedPath` is closed: the tab that shifted
 * into its old slot (its right neighbor), falling back to the new last tab (its left neighbor). */
function neighborTabAfterRemoval(before: string[], removedPath: string, after: string[]): string | null {
  if (after.length === 0) return null;
  const idx = before.indexOf(removedPath);
  return after[Math.max(0, Math.min(idx, after.length - 1))];
}

/** Inserts `path` right after `activePath` (Chrome's "new tab opens next to the current
 * one" behavior), or leaves `tabs` untouched if it's already open. */
function insertTabNextToActive(tabs: string[], activePath: string | null, path: string): string[] {
  if (tabs.includes(path)) return tabs;
  const idx = activePath ? tabs.indexOf(activePath) : -1;
  const next = [...tabs];
  next.splice(idx + 1, 0, path);
  return next;
}

function App() {
  bootLog("App() rendering");
  const [bootStatus, setBootStatus] = useState<BootStatus>("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeNotePath, setActiveNotePath] = useState<string | null>(null);
  const [activeContent, setActiveContent] = useState("");
  const [tabModes, setTabModes] = useState<Record<string, AppMode>>({});
  const [sketchMode, setSketchMode] = useState(false);
  // Set by handleNavigateToNoteLink right before opening an anchored link's target note
  // (a heading or a notePin - see NoteLinkTarget), consumed by the Editor mount that opens it
  // (see scrollToAnchorId below), then cleared.
  const [pendingScrollAnchor, setPendingScrollAnchor] = useState<{ path: string; anchorId: string } | null>(null);
  const [view, setView] = useState<"home" | "note">("home");
  const [browseFilter, setBrowseFilter] = useState<BrowseFilter>("all");
  const [browseFolder, setBrowseFolder] = useState("");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndexReady, setSearchIndexReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [newItemDialog, setNewItemDialog] = useState<NewItemDialogState | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [joinSharedNoteOpen, setJoinSharedNoteOpen] = useState(false);
  // Bumped by ShareDialog after granting/revoking a collaborator, so the effect below re-checks
  // whether the active note should start (or could stop) hosting a live session - see its own
  // comment for why this, rather than the ACL object itself, is what it depends on.
  const [collabVersion, setCollabVersion] = useState(0);
  const [hasActiveCollaborators, setHasActiveCollaborators] = useState(false);
  const [noteLocked, setNoteLocked] = useState(false);
  const [activeCollabSession, setActiveCollabSession] = useState<HostedSession | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);

  // Update checks/prompts only make sense once, from the main window - see isMainWindow above.
  const { state: updaterState, checkNow, installUpdate, restartNow } = useAppUpdater(isMainWindow);

  const toolbarVisible = !settings.toolbarCollapsed;
  const handleToggleToolbar = () => setSettings((s) => ({ ...s, toolbarCollapsed: !s.toolbarCollapsed }));

  const sidebarCollapsed = settings.sidebarCollapsed;
  const handleToggleSidebarCollapse = () => setSettings((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed }));

  const handleToggleAlwaysOnTop = () => setSettings((s) => ({ ...s, alwaysOnTop: !s.alwaysOnTop }));

  const activeContentRef = useRef(activeContent);
  const activeNotePathRef = useRef(activeNotePath);
  const tabsRef = useRef(tabs);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Content last known to be on disk for the active note - used to tell whether this
  // window has local edits that haven't been persisted yet (see listenForNoteSaved below).
  const savedContentRef = useRef(activeContent);
  // Bumped to force the Editor to remount (and pick up fresh initialContent) when another
  // window's save is applied here, since Milkdown only reads its initial value on mount.
  const [reloadToken, setReloadToken] = useState(0);
  const activeMode = activeNotePath ? tabModes[activeNotePath] ?? "edit" : "edit";
  // Falls back to edit mode without touching tabModes, so a tab that was in Study before the
  // feature got disabled just quietly resumes in Study if it's re-enabled later.
  const effectiveMode = settings.features.studyMode ? activeMode : "edit";
  const effectiveSketchMode = settings.features.sketch && sketchMode;

  useEffect(() => {
    activeContentRef.current = activeContent;
  }, [activeContent]);
  useEffect(() => {
    activeNotePathRef.current = activeNotePath;
    // Closes the Share dialog rather than leaving it open against whatever note happens to be
    // active next - it has no "which note" of its own beyond the prop it was opened with.
    setShareDialogOpen(false);
  }, [activeNotePath]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const setTabMode = useCallback((path: string, nextMode: AppMode) => {
    setTabModes((current) => (current[path] === nextMode ? current : { ...current, [path]: nextMode }));
  }, []);

  const handleModeChange = useCallback(
    (nextMode: AppMode) => {
      const path = activeNotePathRef.current;
      if (!path) return;
      try {
        setTabMode(path, nextMode);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Error while changing mode:", err);
      }
    },
    [setTabMode],
  );

  // Persist the main window's open tabs so they can be restored on next launch (see the
  // boot effect below). Secondary windows never write this - see isMainWindow's definition.
  useEffect(() => {
    if (!isMainWindow || bootStatus !== "ready") return;
    saveMainTabSession(tabs, activeNotePath);
  }, [tabs, activeNotePath, bootStatus]);

  useEffect(() => {
    applySettingsToDocument(settings);
    saveSettings(settings);
  }, [settings]);

  // Applies the persisted pin state to this window - also covers un-pinning if the "Keep window
  // on top" feature is turned off while a window is currently pinned.
  useEffect(() => {
    void appWindow.setAlwaysOnTop(settings.alwaysOnTop && settings.features.keepOnTop);
  }, [settings.alwaysOnTop, settings.features.keepOnTop]);

  function showToast(message: string) {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 3500);
  }

  const flushActiveNote = useCallback(async () => {
    const path = activeNotePathRef.current;
    if (!path) return;
    const content = activeContentRef.current;
    // Nothing changed since the last save (the overwhelmingly common case when just switching
    // tabs without editing) - skip the write plus the full-text search/backlinks reindex and
    // cross-window broadcast it'd otherwise trigger on every single switch.
    if (content === savedContentRef.current) return;
    try {
      await writeNote(path, content);
      savedContentRef.current = content;
      updateNoteInIndex(path, content);
      updateNoteInBacklinksIndex(path, content);
      await broadcastNoteSaved(path, content);
    } catch {
      // The active note may have been deleted or moved outside the app;
      // don't let a failed save block switching to a different note.
    }
  }, []);

  const refreshTree = useCallback(async () => {
    const t = await listNoteTree();
    setTree(t);
    return t;
  }, []);

  const refreshTrash = useCallback(async () => {
    const t = await listTrash();
    setTrash(t);
    return t;
  }, []);

  const selectNote = useCallback(
    async (path: string) => {
      await flushActiveNote();
      const raw = await readNote(path);
      const content = await migrateLegacyStudyItems(path, raw);
      savedContentRef.current = content;
      setActiveNotePath(path);
      setActiveContent(content);
    },
    [flushActiveNote],
  );

  /** Opens `path` as a new tab next to the current one (Chrome's "open in new tab"
   * behavior) - or just switches to it if it's already open in this window. */
  const handleOpenNote = useCallback(
    async (path: string) => {
      const isNewTab = !tabsRef.current.includes(path);
      setTabs((current) => insertTabNextToActive(current, activeNotePathRef.current, path));
      await selectNote(path);
      setView("note");
      if (isNewTab) setTabMode(path, "edit");
    },
    [selectNote, setTabMode],
  );

  /** Cmd/Ctrl-clicking a note:// link (or, later, choosing a result from the `[[` picker) routes
   * here. Scrolls in place for a self-link (a note linking to its own heading or notePin) rather
   * than flushing/rereading/remounting the note that's already open, and shows a toast instead of
   * leaving a dead tab behind when the target note no longer exists (renamed/deleted since the
   * link was created - see backlinksIndex.ts's documented limitation on stale link targets).
   * A heading and a notePin (see notePinView.ts) both resolve the exact same way - a real DOM id
   * on the target element - so both funnel through one `anchorId` here rather than needing
   * separate heading/pin-shaped handling. */
  const handleNavigateToNoteLink = useCallback(
    async (target: NoteLinkTarget) => {
      const { path } = target;
      const anchorId = target.headingId ?? (target.pinId ? `note-pin-${target.pinId}` : undefined);
      if (path === activeNotePathRef.current) {
        if (!anchorId) return;
        const el = document.getElementById(anchorId);
        if (!el) {
          showToast(target.pinId ? "Couldn't find that point" : "Couldn't find that heading");
          return;
        }
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("note-link-highlight-flash");
        setTimeout(() => el.classList.remove("note-link-highlight-flash"), 1600);
        return;
      }
      if (anchorId) setPendingScrollAnchor({ path, anchorId });
      try {
        await handleOpenNote(path);
      } catch {
        setPendingScrollAnchor(null);
        setTabs((current) => current.filter((p) => p !== path));
        showToast("That note no longer exists");
      }
    },
    [handleOpenNote],
  );

  const handleSelectTab = useCallback(
    async (path: string) => {
      await selectNote(path);
      setView("note");
    },
    [selectNote],
  );

  /** Closes a tab. If it was active, activates a neighbor (or falls back to browse if it
   * was the last tab) - also used to finalize a drag-out once the new window is live. */
  const handleCloseTab = useCallback(
    async (path: string) => {
      const before = tabsRef.current;
      const after = before.filter((p) => p !== path);
      setTabs(after);
      if (activeNotePathRef.current !== path) return;
      const neighbor = neighborTabAfterRemoval(before, path, after);
      if (neighbor) {
        await selectNote(neighbor);
        return;
      }
      if (!isMainWindow) {
        // A secondary window that just lost its only tab (e.g. its tab got dragged/merged
        // elsewhere) has nothing left to show - close it, like a browser window with no tabs
        // left, rather than leaving it sitting there as an empty Home screen.
        await appWindow.close();
        return;
      }
      await flushActiveNote();
      setActiveNotePath(null);
      setActiveContent("");
      setView("home");
    },
    [selectNote, flushActiveNote],
  );

  const handleReorderTabs = useCallback((next: string[]) => {
    setTabs(next);
  }, []);

  /** Called once a tab-drag resolves into a detach (merge into another window, or a new
   * standalone window) - resolves the note's latest content: flushed in-memory content if
   * it's the active tab, otherwise a plain disk read (background tabs are never edited, so
   * disk is already current). */
  const handlePrepareDetach = useCallback(
    async (path: string): Promise<string> => {
      if (path === activeNotePathRef.current) {
        await flushActiveNote();
        return activeContentRef.current;
      }
      return readNote(path);
    },
    [flushActiveNote],
  );

  const handleBack = useCallback(async () => {
    await flushActiveNote();
    setView("home");
  }, [flushActiveNote]);

  /** Nav click in the sidebar (All Notes/Starred/Recently Deleted) - switches Home's filter
   * and brings it to the front, since a filter change is invisible while a note is open. */
  const handleSelectFilter = useCallback(
    async (filter: BrowseFilter) => {
      await flushActiveNote();
      setBrowseFilter(filter);
      setView("home");
    },
    [flushActiveNote],
  );

  /** Opening a folder from a sidebar search result - since the sidebar no longer has a tree of
   * its own to reveal it in, this hands off to Home's grid/tree browser instead. */
  const handleOpenFolder = useCallback(
    async (path: string) => {
      await flushActiveNote();
      setBrowseFilter("all");
      setBrowseFolder(path);
      setView("home");
    },
    [flushActiveNote],
  );

  /** Opens a note in a new window, regardless of what's currently active. */
  const handleDuplicateNote = useCallback(
    async (path: string) => {
      await flushActiveNote();
      await openWindowInstance({ notePath: path });
    },
    [flushActiveNote],
  );

  /** Mirrors the current window's active note into a new window, or just opens a fresh
   * window at Home if nothing's open here. */
  const handleDuplicateWindow = useCallback(async () => {
    await flushActiveNote();
    if (view === "note" && activeNotePathRef.current) {
      await openWindowInstance({ notePath: activeNotePathRef.current });
    } else {
      await openWindowInstance();
    }
  }, [flushActiveNote, view]);

  useEffect(() => {
    bootLog("boot effect running");
    (async () => {
      try {
        await ensureNotesDir();
        bootLog("ensureNotesDir done");
        const target = getTargetFromLocation();
        bootLog("target resolved", target);

        if (target.notePath) {
          // The editor only needs notePath+content, not the tree - skip waiting on a full
          // directory walk (slow for a big vault) before showing the note, so a freshly
          // detached (or duplicated) window feels instant. Tree/search index load after.
          try {
            // A window spawned mid tab-drag gets its content handed off directly instead of
            // reading disk, in case the drag started before an in-flight edit had autosaved.
            const handoff = target.detached ? await detachInitPromise : null;
            bootLog("detachInitPromise resolved", { gotHandoff: handoff !== null });
            if (handoff !== null) {
              savedContentRef.current = handoff;
              setActiveNotePath(target.notePath);
              setActiveContent(handoff);
            } else {
              await selectNote(target.notePath);
              bootLog("selectNote (disk read) done");
            }
            setTabs([target.notePath]);
            setView("note");
            setTabMode(target.notePath, "edit");
          } catch {
            // The requested note may have been deleted or moved since this
            // window was opened; fall back to the browse view.
          }
          bootLog("setting bootStatus ready");
          setBootStatus("ready");

          void (async () => {
            const initialTree = await refreshTree();
            await loadPersistedSearchIndex();
            await syncSearchIndex(initialTree);
            setSearchIndexReady(true);
            await loadPersistedBacklinksIndex();
            await syncBacklinksIndex(initialTree);
            await refreshTrash();
          })();
          return;
        }

        const initialTree = await refreshTree();
        if (isMainWindow) {
          const session = loadMainTabSession();
          const existingPaths = new Set(flattenNotes(initialTree).map((n) => n.path));
          const restoredTabs = session?.tabs.filter((p) => existingPaths.has(p)) ?? [];
          if (restoredTabs.length > 0) {
            setTabs(restoredTabs);
            const activePath =
              session?.activePath && restoredTabs.includes(session.activePath)
                ? session.activePath
                : restoredTabs[0];
            try {
              await selectNote(activePath);
              setView("note");
              setTabMode(activePath, "edit");
            } catch {
              // Fall back to Home if even the first restored note can't be read.
            }
          }
        }
        setBootStatus("ready");

        // Runs after first paint so a cold, unindexed vault never delays
        // startup - search falls back to a plain title filter until this
        // resolves (see Sidebar), then switches over to the full index.
        void (async () => {
          await loadPersistedSearchIndex();
          await syncSearchIndex(initialTree);
          setSearchIndexReady(true);
          await loadPersistedBacklinksIndex();
          await syncBacklinksIndex(initialTree);
          // Only the main window sweeps expired trash, so two windows never race the same
          // purge - every cold launch creates exactly one main-labeled window (see
          // tauri.conf.json), so this still runs once per launch without extra machinery.
          if (isMainWindow) {
            await purgeExpiredTrash().catch(() => {});
          }
          await refreshTrash();
        })();
      } catch (err) {
        setBootError(err instanceof Error ? err.message : String(err));
        setBootStatus("error");
      }
    })();
    // Runs once on mount; refreshTree/selectNote are stable (ref-backed, no changing deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-window sync: when another window saves the note we currently have open, adopt
  // its content here too - otherwise each window keeps its own stale in-memory copy and
  // silently overwrites the other's changes on its next autosave. Skipped if this window
  // has local edits that haven't been persisted yet, to avoid clobbering active typing.
  useEffect(() => {
    // `listen` resolves asynchronously; if this effect is torn down (e.g. by a
    // hot reload) before that resolves, `unlisten` would still be undefined when
    // cleanup runs below, leaking this listener forever with a stale closure -
    // guard with `cancelled` so a late resolution unregisters itself instead.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const fn = await listenForNoteSaved((path, content) => {
        updateNoteInIndex(path, content);
        updateNoteInBacklinksIndex(path, content);
        if (path !== activeNotePathRef.current) return;
        if (activeContentRef.current !== savedContentRef.current) return;
        // Already showing this exact content (e.g. the other window's save just
        // echoed ours back unchanged) - skip the remount. Forcing one anyway would
        // re-mount a fresh Milkdown instance, whose first internal update event
        // fires unconditionally (no prevMarkdown yet), which looks like a genuine
        // edit and triggers another identical autosave + broadcast - ping-ponging
        // between two windows with the same note open forever.
        if (content === activeContentRef.current) return;
        savedContentRef.current = content;
        setActiveContent(content);
        setReloadToken((token) => token + 1);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Cross-window tab merging, target side: another window's tab was dropped on this window's
  // tab strip (see TabStrip.tsx's finishDragOut) - adopt it as a new tab here, next to whatever
  // is currently active, using the handed-off content directly rather than reading disk.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      // `listen` defaults to receiving events addressed to *any* window - without this target
      // filter, every window (including whichever one sent the emitTo below) would receive
      // this, so the sender would immediately re-insert the tab it had just removed.
      const fn = await listen<MergeTabPayload>(
        MERGE_TAB_EVENT,
        async (event) => {
          const { path, content } = event.payload;
          await flushActiveNote();
          setTabs((current) => insertTabNextToActive(current, activeNotePathRef.current, path));
          savedContentRef.current = content;
          setActiveNotePath(path);
          setActiveContent(content);
          setView("note");
          setTabMode(path, "edit");
          await appWindow.setFocus();
        },
        { target: appWindow.label },
      );
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [flushActiveNote]);

  // Window chrome: track maximize state so the shell can go edge-to-edge,
  // and flush any pending edit before the window actually closes.
  useEffect(() => {
    let cancelled = false;
    let unlistenResize: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    let maximizeCheckTimer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      setIsMaximized(await appWindow.isMaximized());
      // A live edge-drag fires onResized dozens of times a second, and isMaximized() is an
      // async IPC round trip - awaiting one on every single tick built up a backlog of
      // in-flight calls faster than they could resolve. The maximize/restore transition this
      // is actually watching for only ever happens at the start or end of a drag, so it's
      // enough to check once resizing has paused rather than on every tick.
      const resizeFn = await appWindow.onResized(() => {
        if (maximizeCheckTimer) clearTimeout(maximizeCheckTimer);
        maximizeCheckTimer = setTimeout(async () => {
          maximizeCheckTimer = undefined;
          setIsMaximized(await appWindow.isMaximized());
        }, 120);
      });
      const closeFn = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        await flushActiveNote();
        await appWindow.destroy();
      });
      if (cancelled) {
        resizeFn();
        closeFn();
        return;
      }
      unlistenResize = resizeFn;
      unlistenClose = closeFn;
    })();
    return () => {
      cancelled = true;
      if (maximizeCheckTimer) clearTimeout(maximizeCheckTimer);
      unlistenResize?.();
      unlistenClose?.();
    };
  }, [flushActiveNote]);

  const handleCreateNote = useCallback(
    async (parentPath: string, title?: string, templateId: string = "blank") => {
      await flushActiveNote();
      const template = getTemplate(templateId);
      const content = template.buildContent();
      const note = await createNote(parentPath, title, content, template.look);
      await refreshTree();
      addNoteToIndex(note.path, content);
      addNoteToBacklinksIndex(note.path, content);
      savedContentRef.current = content;
      setTabs((current) => insertTabNextToActive(current, activeNotePathRef.current, note.path));
      setActiveNotePath(note.path);
      setActiveContent(content);
      setTabMode(note.path, "edit");
      setView("note");
    },
    [flushActiveNote, refreshTree, setTabMode],
  );

  const handleCreateFolder = useCallback(
    async (parentPath: string, name?: string, color?: string | null) => {
      await createFolder(parentPath, name, color);
      await refreshTree();
    },
    [refreshTree],
  );

  const promptNewNote = useCallback((parentPath: string) => {
    setNewItemDialog({ kind: "note", parentPath });
  }, []);

  const promptNewFolder = useCallback((parentPath: string) => {
    setNewItemDialog({ kind: "folder", parentPath });
  }, []);

  const handleRename = useCallback(
    async (path: string, isFolder: boolean, newTitle: string) => {
      try {
        const newPath = await renameEntry(path, newTitle, isFolder);
        await refreshTree();
        movePathInIndex(path, newPath);
        movePathInBacklinksIndex(path, newPath);
        setTabs((current) => current.map((p) => remapTabPath(p, path, newPath)));
        const current = activeNotePathRef.current;
        if (current) {
          setActiveNotePath(remapTabPath(current, path, newPath));
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Rename failed");
      }
    },
    [refreshTree],
  );

  const handleSetFolderColor = useCallback(
    async (path: string, color: string | null) => {
      try {
        await setFolderColor(path, color);
        await refreshTree();
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Couldn't set folder color");
      }
    },
    [refreshTree],
  );

  const handleMove = useCallback(
    async (path: string, targetParentPath: string) => {
      try {
        const newPath = await moveEntry(path, targetParentPath);
        await refreshTree();
        movePathInIndex(path, newPath);
        movePathInBacklinksIndex(path, newPath);
        setTabs((current) => current.map((p) => remapTabPath(p, path, newPath)));
        const current = activeNotePathRef.current;
        if (current) {
          setActiveNotePath(remapTabPath(current, path, newPath));
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Move failed");
      }
    },
    [refreshTree],
  );

  /** Soft-deletes a note/folder immediately - no confirmation, since Recently Deleted (see
   * Sidebar) is now the undo path. Closes any open tabs it affects, same as before. */
  const handleDeleteEntry = useCallback(
    async (path: string, isFolder: boolean) => {
      try {
        if (isFolder) await deleteFolder(path);
        else await deleteNote(path);
        removePathFromIndex(path);
        removePathFromBacklinksIndex(path);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Delete failed");
        return;
      }
      await refreshTree();
      await refreshTrash();
      const affected = (p: string) => p === path || p.startsWith(`${path}/`);
      const tabsBefore = tabsRef.current;
      const tabsAfter = tabsBefore.filter((p) => !affected(p));
      setTabs(tabsAfter);
      const current = activeNotePathRef.current;
      if (current && affected(current)) {
        const neighbor = neighborTabAfterRemoval(tabsBefore, current, tabsAfter);
        if (neighbor) {
          await selectNote(neighbor);
        } else if (!isMainWindow && tabsAfter.length === 0) {
          await appWindow.close();
          return;
        } else {
          setActiveNotePath(null);
          setActiveContent("");
          if (view === "note") setView("home");
        }
      }
    },
    [refreshTree, refreshTrash, selectNote, view],
  );

  const handleSetStarred = useCallback(
    async (path: string, value: boolean) => {
      try {
        await setStarred(path, value);
        await refreshTree();
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Couldn't update starred");
      }
    },
    [refreshTree],
  );

  const handleRestoreFromTrash = useCallback(
    async (items: TrashItem[]) => {
      const restoredToRootTitles: string[] = [];
      const restoredPaths: string[] = [];
      let failures = 0;
      for (const item of items) {
        try {
          const result = await restoreFromTrash(item.trashPath);
          restoredPaths.push(result.path);
          if (result.restoredToRoot) restoredToRootTitles.push(item.title);
        } catch {
          failures += 1;
        }
      }
      const restoredTree = await refreshTree();
      await refreshTrash();
      // The restored note(s) fell out of the search index while trashed - add them back
      // rather than waiting for a full syncSearchIndex pass over the whole vault.
      const restoredNotes = flattenNotes(restoredTree).filter((n) =>
        restoredPaths.some((p) => n.path === p || n.path.startsWith(`${p}/`)),
      );
      await Promise.all(
        restoredNotes.map(async (n) => {
          const content = await readNote(n.path).catch(() => "");
          addNoteToIndex(n.path, content);
          addNoteToBacklinksIndex(n.path, content);
        }),
      );
      if (restoredToRootTitles.length === 1) {
        showToast(`Original folder no longer exists — restored "${restoredToRootTitles[0]}" to All Notes`);
      } else if (restoredToRootTitles.length > 1) {
        showToast(`Original folders no longer exist — restored ${restoredToRootTitles.length} items to All Notes`);
      }
      if (failures > 0) {
        showToast(failures === 1 ? "Couldn't restore 1 item" : `Couldn't restore ${failures} items`);
      }
    },
    [refreshTree, refreshTrash],
  );

  const handleRequestDeleteForever = useCallback((items: TrashItem[]) => {
    setConfirmAction({
      items: items.map((item) => ({ trashPath: item.trashPath, type: item.type, title: item.title })),
    });
  }, []);

  async function performDeleteForever(action: ConfirmAction) {
    try {
      for (const item of action.items) {
        await deleteForever(item.trashPath, item.type);
      }
      await refreshTrash();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed");
    }
    setConfirmAction(null);
  }

  const activeNote = useMemo(
    () => flattenNotes(tree).find((n) => n.path === activeNotePath) ?? null,
    [tree, activeNotePath],
  );

  // Every note in the vault, for the editor's "link to a note" picker - not just the active one.
  const allNotes = useMemo(() => flattenNotes(tree), [tree]);

  // Whether the active note currently has anyone actively granted access - re-checked whenever
  // the active note changes or ShareDialog bumps collabVersion after a grant/revoke. Kept as its
  // own boolean (rather than having the hosting effect below read the ACL directly) so that
  // effect only restarts the session on an actual "should we be hosting at all" flip, not on
  // every unrelated ACL tweak (a role change or an additional grant to an already-active session
  // is instead picked up by hostSession's own internal ACL polling - see yjsBridge.ts).
  useEffect(() => {
    if (view !== "note" || !activeNote) {
      setHasActiveCollaborators(false);
      setNoteLocked(false);
      return;
    }
    let cancelled = false;
    void getAcl(activeNote.path).then((acl) => {
      if (cancelled) return;
      setHasActiveCollaborators(!!acl?.collaborators.some((c) => c.status === "active"));
      setNoteLocked(!!acl?.locked);
    });
    return () => {
      cancelled = true;
    };
  }, [view, activeNote, collabVersion]);

  // Starts hosting the moment the open note has any active collaborator, and tears the session
  // down on cleanup (note closed/switched, or the last collaborator revoked) - "as long as the
  // note is open and the device is on" is the whole point of the owner-as-server model, so this
  // deliberately doesn't wait for the Share dialog to be open.
  useEffect(() => {
    if (!hasActiveCollaborators || view !== "note" || !activeNote) {
      setActiveCollabSession(null);
      return;
    }
    let cancelled = false;
    let session: HostedSession | null = null;
    (async () => {
      try {
        const identity = await loadOrCreateIdentity();
        if (cancelled) return;
        const started = await hostSession(activeNote.path, identity);
        if (cancelled) {
          started.close();
          return;
        }
        session = started;
        setActiveCollabSession(started);
      } catch {
        // Note stopped being shared, or the identity/keychain call failed - either way there's
        // nothing to host right now; hasActiveCollaborators's own next poll will reconcile.
      }
    })();
    return () => {
      cancelled = true;
      session?.close();
      setActiveCollabSession(null);
    };
  }, [hasActiveCollaborators, view, activeNote]);

  // Who else is currently present on the open note, for Header's avatar row - see usePresence's
  // own comment for why this reads awareness directly rather than App tracking its own list.
  const collabPresence = usePresence(activeCollabSession?.awareness);

  /** Toggles the note's "instant lock" - every collaborator becomes temporarily read-only
   * without revoking anyone. Pushes the change live to whoever's currently connected, on top of
   * the persisted ACL write (see notifyAclChanged's own comment on why both). */
  async function handleToggleLock() {
    if (!activeNote) return;
    const next = !noteLocked;
    setNoteLocked(next);
    await setLocked(activeNote.path, next);
    setCollabVersion((v) => v + 1);
    void activeCollabSession?.notifyAclChanged();
  }

  /** New-note action for the tab strip's "+" button: creates a sibling of the active tab's
   * note, or falls back to the vault root if no note is open. */
  const handleNewNoteInActiveFolder = useCallback(() => {
    promptNewNote(activeNote ? activeNote.parentPath : "");
  }, [promptNewNote, activeNote]);


  const tabNotes = useMemo(() => {
    const byPath = new Map(flattenNotes(tree).map((n) => [n.path, n]));
    return tabs.map((path) => ({ path, title: byPath.get(path)?.title ?? path.split("/").pop() ?? path }));
  }, [tree, tabs]);

  // Global shortcuts: Cmd/Ctrl+N new note (sibling of the active note, if one is open),
  // Cmd/Ctrl+W close the active tab, Cmd/Ctrl+F focus search.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        promptNewNote(view === "note" && activeNote ? activeNote.parentPath : "");
      } else if (e.key.toLowerCase() === "w") {
        if (activeNotePathRef.current) {
          e.preventDefault();
          void handleCloseTab(activeNotePathRef.current);
        }
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSettings((s) => (s.sidebarCollapsed ? { ...s, sidebarCollapsed: false } : s));
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [promptNewNote, view, activeNote, handleCloseTab]);

  return (
    <div className="h-screen w-screen">
      <div
        className={`app-shell @container relative flex h-full w-full flex-col overflow-hidden border transition-[border-radius] duration-150 ${
          isMaximized ? "rounded-none border-transparent" : "rounded-3xl border-subtle"
        }`}
      >
        <ResizeHandles />

        <Header
          view={view}
          onBack={handleBack}
          mode={effectiveMode}
          onModeChange={handleModeChange}
          onDuplicateWindow={handleDuplicateWindow}
          onOpenShare={view === "note" && activeNote ? () => setShareDialogOpen(true) : undefined}
          collabActive={!!activeCollabSession}
          noteLocked={noteLocked}
          onToggleLock={() => void handleToggleLock()}
          collabPresence={collabPresence}
          settingsOpen={settingsOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onCloseSettings={() => setSettingsOpen(false)}
          toolbarVisible={toolbarVisible}
          onToggleToolbar={handleToggleToolbar}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebarCollapse={handleToggleSidebarCollapse}
          studyModeFeatureEnabled={settings.features.studyMode}
          keepOnTopFeatureEnabled={settings.features.keepOnTop}
          alwaysOnTop={settings.alwaysOnTop}
          onToggleAlwaysOnTop={handleToggleAlwaysOnTop}
          tabStrip={
            tabNotes.length > 0 ? (
              <TabStrip
                tabs={tabNotes}
                activeNotePath={view === "note" ? activeNotePath : null}
                onSelectTab={handleSelectTab}
                onCloseTab={handleCloseTab}
                onReorderTabs={handleReorderTabs}
                onNewNote={handleNewNoteInActiveFolder}
                onPrepareDetach={handlePrepareDetach}
              />
            ) : undefined
          }
        />

        <div className="relative flex flex-1 overflow-hidden">
          {settingsOpen ? (
            <SettingsPanel
              settings={settings}
              onChange={setSettings}
              onClose={() => setSettingsOpen(false)}
              updaterState={updaterState}
              onCheckForUpdates={checkNow}
              onInstallUpdate={() => void installUpdate()}
              onRestart={() => setShowRestartConfirm(true)}
            />
          ) : (
            <>
              <Sidebar
                tree={tree}
                trash={trash}
                activeNotePath={view === "note" ? activeNotePath : null}
                collapsed={sidebarCollapsed}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                searchIndexReady={searchIndexReady}
                searchInputRef={searchInputRef}
                filter={browseFilter}
                onSelectFilter={handleSelectFilter}
                onOpenFolder={handleOpenFolder}
                onOpenNote={handleOpenNote}
                onDuplicateNote={handleDuplicateNote}
                onPromptNewNote={promptNewNote}
                onPromptNewFolder={promptNewFolder}
                onJoinSharedNote={() => setJoinSharedNoteOpen(true)}
                onRename={handleRename}
                onDeleteEntry={handleDeleteEntry}
                onMove={handleMove}
                onSetFolderColor={handleSetFolderColor}
                onSetStarred={handleSetStarred}
                onRestoreFromTrash={handleRestoreFromTrash}
                onRequestDeleteForever={handleRequestDeleteForever}
                showCalendar={settings.features.calendar}
              />

              <main className="glass-panel shadow-app relative flex-1 overflow-hidden">
                {bootStatus === "loading" && (
                  <div className="text-secondary flex h-full items-center justify-center text-sm">
                    Loading notes…
                  </div>
                )}

                {bootStatus === "error" && (
                  <div className="flex h-full items-center justify-center p-10 text-center">
                    <div className="border-danger-soft bg-danger-soft text-danger max-w-md rounded-2xl border p-6 text-sm">
                      <p className="font-medium">Couldn't access your notes folder</p>
                      <p className="mt-1 opacity-80">{bootError}</p>
                    </div>
                  </div>
                )}

                {bootStatus === "ready" && view === "home" && (
                  <Home
                    tree={tree}
                    trash={trash}
                    filter={browseFilter}
                    browseFolder={browseFolder}
                    onBrowseFolderChange={setBrowseFolder}
                    onOpenNote={handleOpenNote}
                    onCreateNote={handleCreateNote}
                    onPromptNewNote={promptNewNote}
                    onPromptNewFolder={promptNewFolder}
                    onDuplicateNote={handleDuplicateNote}
                    onRename={handleRename}
                    onDeleteEntry={handleDeleteEntry}
                    onMove={handleMove}
                    onSetFolderColor={handleSetFolderColor}
                    onSetStarred={handleSetStarred}
                    onRestoreFromTrash={handleRestoreFromTrash}
                    onRequestDeleteForever={handleRequestDeleteForever}
                  />
                )}

                {bootStatus === "ready" && view === "note" && activeNote && effectiveMode === "edit" && (
                  <Editor
                    key={`${activeNote.path}:${reloadToken}:${settings.features.voiceNotes}:${activeCollabSession ? "collab" : "solo"}`}
                    notePath={activeNote.path}
                    initialContent={activeContent}
                    onChange={(value) => {
                      // Not setActiveContent: that's a useState setter, and calling it on every
                      // keystroke re-renders all of App (including Sidebar/Header) for no
                      // rendering purpose - activeContent's only JSX use is initialContent above,
                      // which just seeds a freshly-keyed Editor mount. Every "read the live
                      // value" consumer already goes through activeContentRef, so updating it
                      // directly here keeps them correct without the unnecessary re-render.
                      activeContentRef.current = value;
                    }}
                    onSave={async (content) => {
                      await writeNote(activeNote.path, content);
                      savedContentRef.current = content;
                      updateNoteInIndex(activeNote.path, content);
                      updateNoteInBacklinksIndex(activeNote.path, content);
                      await broadcastNoteSaved(activeNote.path, content);
                    }}
                    toolbarVisible={toolbarVisible}
                    sketchMode={effectiveSketchMode}
                    onToggleSketchMode={() => setSketchMode((v) => !v)}
                    sketchEnabled={settings.features.sketch}
                    codeBlockEnabled={settings.features.codeBlock}
                    voiceNotesEnabled={settings.features.voiceNotes}
                    noteChoices={allNotes}
                    onNavigateToNoteLink={handleNavigateToNoteLink}
                    scrollToAnchorId={
                      pendingScrollAnchor?.path === activeNote.path ? pendingScrollAnchor.anchorId : undefined
                    }
                    onScrolledToAnchor={() => setPendingScrollAnchor(null)}
                    collabSession={
                      activeCollabSession
                        ? { yXmlFragment: activeCollabSession.yXmlFragment, canEdit: true, awareness: activeCollabSession.awareness }
                        : undefined
                    }
                  />
                )}

                {bootStatus === "ready" && view === "note" && activeNote && effectiveMode === "study" && (
                  <ErrorBoundary>
                    <StudyView key={activeNote.path} notePath={activeNote.path} />
                  </ErrorBoundary>
                )}
              </main>
            </>
          )}
        </div>

        {confirmAction && (
          <ConfirmDialog
            title={
              confirmAction.items.length === 1
                ? `Delete "${confirmAction.items[0].title}" forever?`
                : `Delete ${confirmAction.items.length} items forever?`
            }
            description={
              confirmAction.items.some((item) => item.type === "folder")
                ? "This permanently deletes the selected items, including everything inside any folders. This cannot be undone."
                : "This cannot be undone."
            }
            confirmLabel="Delete Forever"
            onConfirm={() => performDeleteForever(confirmAction)}
            onCancel={() => setConfirmAction(null)}
          />
        )}

        {newItemDialog && (
          <NewItemDialog
            kind={newItemDialog.kind}
            defaultName={newItemDialog.kind === "folder" ? "New Folder" : "Untitled"}
            onCreate={(name, color) => {
              setNewItemDialog(null);
              if (newItemDialog.kind === "folder") {
                handleCreateFolder(newItemDialog.parentPath, name, color);
              } else {
                handleCreateNote(newItemDialog.parentPath, name);
              }
            }}
            onCancel={() => setNewItemDialog(null)}
          />
        )}

        {shareDialogOpen && activeNote && (
          <ShareDialog
            notePath={activeNote.path}
            noteTitle={activeNote.title}
            onClose={() => setShareDialogOpen(false)}
            onAclChanged={() => {
              setCollabVersion((v) => v + 1);
              void activeCollabSession?.notifyAclChanged();
            }}
          />
        )}

        {joinSharedNoteOpen && <JoinSharedNoteDialog onClose={() => setJoinSharedNoteOpen(false)} />}

        {toast && (
          <div className="glass-surface shadow-app-lg animate-fade-in absolute bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm">
            <span className="text-primary">{toast}</span>
          </div>
        )}

        {updaterState.phase !== "idle" && updaterState.phase !== "checking" && (
          <div className="glass-surface shadow-app-lg animate-fade-in absolute bottom-6 right-6 z-50 flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm">
            <span className="text-primary">
              {updaterState.phase === "available" && `Update available — v${updaterState.version}`}
              {updaterState.phase === "downloading" && "Downloading update…"}
              {updaterState.phase === "ready" && "Update ready to install"}
              {updaterState.phase === "error" && "Couldn't install update"}
            </span>
            {updaterState.phase === "available" && (
              <button
                type="button"
                onClick={() => void installUpdate()}
                className="bg-accent-solid h-7 shrink-0 rounded-lg px-3 text-xs font-medium text-white transition-colors duration-150 hover:brightness-110"
              >
                Install
              </button>
            )}
            {updaterState.phase === "ready" && (
              <button
                type="button"
                onClick={() => setShowRestartConfirm(true)}
                className="bg-accent-solid h-7 shrink-0 rounded-lg px-3 text-xs font-medium text-white transition-colors duration-150 hover:brightness-110"
              >
                Restart Now
              </button>
            )}
            {updaterState.phase === "error" && (
              <button
                type="button"
                onClick={() => void installUpdate()}
                className="btn-ghost h-7 shrink-0 rounded-lg px-3 text-xs"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {showRestartConfirm && (
          <ConfirmDialog
            title="Restart to finish updating?"
            description="Your notes are saved automatically, so it's safe to restart now."
            confirmLabel="Restart Now"
            danger={false}
            onConfirm={restartNow}
            onCancel={() => setShowRestartConfirm(false)}
          />
        )}
      </div>
    </div>
  );
}

export default App;
