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

/** How often the in-progress state of a continuous gesture is pushed into the shared types.
 *
 * A drag, resize, endpoint drag or eraser sweep fires on every pointer sample - 120Hz on a
 * trackpad - and each one previously wrote straight through. That matters far more here than it
 * would for text, because a Y.Map keyed by element id has whole elements as its write granularity
 * (see kindSharedTypes.ts): moving one ink stroke by two pixels re-serializes its entire point
 * list, moving a table re-serializes every cell. A single two-second drag of a long stroke is
 * megabytes on the wire that way, and a multi-element selection can produce an update past
 * hostSession's MAX_UPDATE_BYTES cap - which the owner drops outright and silently, so a guest's
 * move simply never lands.
 *
 * So the two halves are decoupled: local React state still updates on every sample, so the person
 * dragging sees their own gesture at full frame rate, while the CRDT write is coalesced to this
 * interval - leading edge, so the first sample of a gesture goes out with no added latency, then
 * the most recent state per tick and once more on the trailing edge. Peers see ~15 updates/sec,
 * comfortably past what reads as smooth, for a fraction of the bytes.
 *
 * Deliberately a shade above sessionProtocol's CONTENT_BATCH_WINDOW_MS: writing faster than that
 * window buys nothing, since the transport merges those updates into one message anyway - but a
 * merged update still *carries* every intermediate full-element copy, which is why the coalescing
 * has to happen here, before the write, rather than on the wire. */
const TRANSIENT_WRITE_INTERVAL_MS = 65;

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
   * single `beginHistory()` at gesture start.
   *
   * In a session this is also the path whose write-through to collaborators is coalesced rather
   * than sent per sample - see TRANSIENT_WRITE_INTERVAL_MS. Local state still updates on every
   * call, so callers need do nothing differently; it is only what reaches the wire that thins out. */
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

  // ---- collab mode: coalesced write-through -------------------------------
  // See TRANSIENT_WRITE_INTERVAL_MS. The element list a throttle tick still owes the shared types,
  // and the tick that will write it - both null whenever nothing is queued.
  const pendingWriteRef = useRef<BoardElement[] | null>(null);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writeShared = useCallback(
    (next: readonly BoardElement[]) => {
      if (!shared) return;
      mirroredRef.current = writeBoardElements(shared, next, mirroredRef.current);
    },
    [shared],
  );

  /** Writes whatever a tick is still holding and stops the throttle - so a gesture's final state
   * can't be left sitting in `pendingWriteRef` when something needs the shared types to be current
   * right now (a discrete edit, a remote change, unmount). */
  const flushSharedWrite = useCallback(() => {
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    const pending = pendingWriteRef.current;
    pendingWriteRef.current = null;
    if (pending) writeShared(pending);
  }, [writeShared]);

  const scheduleSharedWrite = useCallback(
    (next: BoardElement[]) => {
      if (!shared) return;
      // Mid-window: hold the newest state and let the pending tick carry it. Only the latest is
      // kept - every intermediate frame of a drag is superseded by the one after it, so queueing
      // them would put states nobody ever needs to see on the wire.
      if (writeTimerRef.current) {
        pendingWriteRef.current = next;
        return;
      }
      writeShared(next); // leading edge
      const tick = () => {
        writeTimerRef.current = null;
        const pending = pendingWriteRef.current;
        pendingWriteRef.current = null;
        if (!pending) return; // gesture went idle - let the throttle lapse
        writeShared(pending);
        // Re-armed rather than rescheduled by the next sample, so a gesture still in flight keeps
        // ticking at a fixed rate instead of its cadence tracking the pointer's sample rate.
        writeTimerRef.current = setTimeout(tick, TRANSIENT_WRITE_INTERVAL_MS);
      };
      writeTimerRef.current = setTimeout(tick, TRANSIENT_WRITE_INTERVAL_MS);
    },
    [shared, writeShared],
  );

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
      // sync() re-reads the shared types wholesale, and whatever a gesture in progress hasn't
      // written yet isn't in them (see TRANSIENT_WRITE_INTERVAL_MS) - so land it first, or a
      // collaborator's edit arriving mid-drag would snap the element being dragged back to its
      // last written position until the next tick. Writing from inside an observer is a supported
      // Yjs pattern: it queues a separate transaction rather than nesting one (see yjs's own
      // comment in `transact`), and that transaction carries BOARD_LOCAL_ORIGIN, so it comes back
      // through here and is skipped by the guard above.
      flushSharedWrite();
      sync();
    };
    shared.yElements.observe(observer);
    shared.yOrder.observe(observer);
    shared.yMeta.observe(observer);
    return () => {
      shared.yElements.unobserve(observer);
      shared.yOrder.unobserve(observer);
      shared.yMeta.unobserve(observer);
      // Last-chance write for collab mode, mirroring the local-mode sidecar flush below: closing
      // the note within a throttle window of the final pointer sample would otherwise drop that
      // last sliver of the gesture for everyone else.
      flushSharedWrite();
    };
  }, [shared, flushSharedWrite]);

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

  /** React state and the digest callback - the half of a change that always happens per call,
   * whatever the shared types are doing. */
  const setLocal = useCallback(
    (next: BoardElement[]) => {
      apply({ ...docRef.current, elements: next });
      changedRef.current?.(next);
    },
    [apply],
  );

  /** A discrete edit - add, delete, restyle, undo, paste. Lands in the shared types immediately;
   * a throttled write still queued behind it is dropped rather than flushed, because `next` is the
   * whole document and writeBoardElements reconciles against it wholesale, so writing the stale
   * intermediate first would only produce a state this same call immediately overwrites. */
  const setElements = useCallback(
    (next: BoardElement[]) => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      pendingWriteRef.current = null;
      writeShared(next);
      setLocal(next);
    },
    [setLocal, writeShared],
  );

  /** The continuous phase of a gesture - see TRANSIENT_WRITE_INTERVAL_MS. */
  const setElementsTransient = useCallback(
    (next: BoardElement[]) => {
      scheduleSharedWrite(next);
      setLocal(next);
    },
    [scheduleSharedWrite, setLocal],
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
    commitTransient: setElementsTransient,
    beginHistory: pushHistory,
    setSurface,
    setViewport,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}
