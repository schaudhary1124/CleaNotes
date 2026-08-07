import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import {
  BOARD_LOCAL_ORIGIN,
  readBoardElements,
  readBoardSurface,
  writeBoardElements,
  writeBoardSurface,
} from "../collab/boardSync";
import type { WhiteboardKindShared } from "../collab/kindSharedTypes";
import { emptyBoard, type BoardDoc, type BoardElement, type BoardSurface, type BoardViewport } from "./boardTypes";

/** Owns one board's document: where it comes from, every mutation to it, undo/redo, and - when
 * there's no collab session - persistence back to its sidecar.
 *
 * Two backing modes, chosen by whether `source` carries shared Yjs types:
 *
 *   local  - the `.whiteboard.json` sidecar is the document. This store loads it and writes it
 *            back, debounced.
 *   collab - the session's shared types are the document. This store mirrors them into React
 *            state and writes edits through; it never touches disk, because during a session the
 *            *host* is the single writer (see collab/kindPersistence.ts). That's the same
 *            single-writer rule Editor.tsx's sketch autosave already follows, and it matters more
 *            here: a board's host persists even when the owner doesn't have the board open.
 *
 * Undo/redo snapshots the whole element array rather than recording per-operation inverse deltas.
 * A board's elements are small plain objects and a snapshot is a shallow array copy sharing every
 * unchanged element, so the cost is one pointer per element per undo step - cheap enough that the
 * complexity of an inverse-delta system (and the class of bugs where one operation's inverse is
 * subtly wrong) buys nothing here. `HISTORY_LIMIT` bounds the worst case.
 *
 * History is deliberately local even in collab mode: undo means "take back what *I* just did",
 * and a shared undo stack that let one person revert another's work is the classic
 * multiplayer-undo footgun. The snapshot it restores is still written through as a normal edit,
 * so peers see the result like any other change.
 *
 * Only `elements` participates in history. Surface and viewport changes are persisted but are
 * deliberately not undoable: undoing a pan is the classic surprising-undo bug, and "undo" after
 * a stroke should remove the stroke no matter how much the user panned in between. */

const HISTORY_LIMIT = 100;
const SAVE_DEBOUNCE_MS = 400;

/** Reading and writing a board's `.whiteboard.json` sidecar.
 *
 * Injected rather than calling fsNotes.ts directly, for the same reason BoardAssets is: this
 * module is reachable from the browser-guest bundle (through SharedBoardView), and any path to
 * fsNotes.ts - even a lazy `import()`, which still emits its own chunk - drags Tauri APIs into
 * that build and fails the isolation check outright. See scripts/check-browser-bundle.mjs. */
export interface BoardFileStore {
  read(): Promise<BoardDoc | null>;
  write(doc: BoardDoc): Promise<void>;
}

/** Where a board's document lives. Only a device with the note in its own vault can supply a
 * `file`; a guest has nothing but the session. */
export type BoardSource =
  | { mode: "local"; file: BoardFileStore }
  | { mode: "collab"; shared: WhiteboardKindShared };

export interface BoardStore {
  doc: BoardDoc;
  loading: boolean;
  /** Replaces the element list and pushes the previous one onto the undo stack. */
  commit: (next: BoardElement[]) => void;
  /** Replaces the element list *without* touching history - for the continuous phase of a drag,
   * where every pointer move would otherwise push its own undo step. Callers pair this with a
   * single `beginHistory()` at gesture start. */
  commitTransient: (next: BoardElement[]) => void;
  /** Snapshots the current elements onto the undo stack ahead of a multi-step gesture. */
  beginHistory: () => void;
  setSurface: (surface: BoardSurface) => void;
  setViewport: (viewport: BoardViewport) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useBoardStore(
  source: BoardSource,
  onElementsChanged?: (els: BoardElement[]) => void,
): BoardStore {
  const [doc, setDoc] = useState<BoardDoc>(() => emptyBoard());
  const [loading, setLoading] = useState(source.mode === "local");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const undoStack = useRef<BoardElement[][]>([]);
  const redoStack = useRef<BoardElement[][]>([]);
  const docRef = useRef(doc);
  docRef.current = doc;
  // Guards the save path from writing the sidecar back out during the initial load - without it,
  // mounting a board would immediately persist the empty placeholder doc over the real file.
  const loadedRef = useRef(false);
  const changedRef = useRef(onElementsChanged);
  changedRef.current = onElementsChanged;

  // What this device last wrote to (or read from) the shared types, for reference-diffing writes -
  // see boardSync.ts's writeBoardElements. Unused in local mode.
  const mirroredRef = useRef<Map<string, BoardElement>>(new Map());

  const shared = source.mode === "collab" ? source.shared : null;
  // Null during a session: the host's own persistence becomes the single writer then, even on the
  // owner's device (see collab/kindPersistence.ts).
  const file = source.mode === "local" ? source.file : null;

  // ---- local mode: load from the sidecar ----------------------------------
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    loadedRef.current = false;
    setLoading(true);
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
    void (async () => {
      const loaded = await file.read();
      if (cancelled) return;
      setDoc(loaded ?? emptyBoard());
      loadedRef.current = true;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  // ---- collab mode: mirror the shared types -------------------------------
  useEffect(() => {
    if (!shared) return;
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);

    const sync = () => {
      const elements = readBoardElements(shared);
      // The mirror is refreshed from the same objects handed to React state, so the next local
      // write diffs against exactly what the shared types hold - see writeBoardElements.
      mirroredRef.current = new Map(elements.map((el) => [el.id, el]));
      const next: BoardDoc = {
        version: 1,
        surface: readBoardSurface(shared),
        elements,
        // The camera is per-device and never shared, so it survives every remote change.
        viewport: docRef.current.viewport,
      };
      setDoc(next);
      docRef.current = next;
      changedRef.current?.(elements);
    };

    // The session's types are already populated by the time a board mounts (the host seeds from
    // disk before exposing them; a guest applies the welcome snapshot before resolving), so this
    // first read is a real hydration, not an empty placeholder.
    sync();
    loadedRef.current = true;
    setLoading(false);

    const observer = (_event: unknown, transaction: { origin: unknown }) => {
      // Our own writes are already in local state - re-reading them would be redundant, and would
      // also replace the element objects mid-drag with equal-but-different ones, defeating the
      // reference diffing that keeps a drag cheap.
      if (transaction.origin === BOARD_LOCAL_ORIGIN) return;
      sync();
    };
    shared.yElements.observe(observer);
    shared.yOrder.observe(observer);
    shared.yMeta.observe(observer);
    return () => {
      shared.yElements.unobserve(observer);
      shared.yOrder.unobserve(observer);
      shared.yMeta.unobserve(observer);
    };
  }, [shared]);

  const persist = useDebouncedCallback((next: BoardDoc) => {
    void file?.write(next); // null during a session - the host owns the file then, see the header
  }, SAVE_DEBOUNCE_MS);

  // A single funnel for every state change, so neither persistence nor the collab write-through
  // can be forgotten at a call site.
  const apply = useCallback(
    (next: BoardDoc) => {
      setDoc(next);
      docRef.current = next;
      if (loadedRef.current) persist(next);
    },
    [persist],
  );

  const pushHistory = useCallback(() => {
    undoStack.current.push(docRef.current.elements);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const setElements = useCallback(
    (next: BoardElement[]) => {
      if (shared) mirroredRef.current = writeBoardElements(shared, next, mirroredRef.current);
      apply({ ...docRef.current, elements: next });
      changedRef.current?.(next);
    },
    [apply, shared],
  );

  const commit = useCallback(
    (next: BoardElement[]) => {
      pushHistory();
      setElements(next);
    },
    [pushHistory, setElements],
  );

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(docRef.current.elements);
    setElements(previous);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, [setElements]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(docRef.current.elements);
    setElements(next);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, [setElements]);

  const setSurface = useCallback(
    (surface: BoardSurface) => {
      if (shared) writeBoardSurface(shared, surface);
      apply({ ...docRef.current, surface });
    },
    [apply, shared],
  );

  // Panning/zooming fires continuously and does have to re-render (the world transform reads it),
  // but it is never shared and the only consumer of the persisted value is the next time this
  // board is opened - so routing it through the same debounced writer as everything else collapses
  // a whole pan gesture into a single file write.
  const setViewport = useCallback(
    (viewport: BoardViewport) => apply({ ...docRef.current, viewport }),
    [apply],
  );

  // Last-chance flush for local mode: the debounced writer would otherwise drop a pending save
  // when the note is closed or the window unmounts within SAVE_DEBOUNCE_MS of the final edit. In
  // collab mode there is nothing to flush here - the host's own persistence handle does it.
  useEffect(() => {
    if (!file) return;
    return () => {
      if (loadedRef.current) void file.write(docRef.current);
    };
  }, [file]);

  return {
    doc,
    loading,
    commit,
    commitTransient: setElements,
    beginHistory: pushHistory,
    setSurface,
    setViewport,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}
