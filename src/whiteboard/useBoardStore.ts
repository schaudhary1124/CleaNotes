import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { readBoard, writeBoard } from "../utils/fsNotes";
import { emptyBoard, type BoardDoc, type BoardElement, type BoardSurface, type BoardViewport } from "./boardTypes";

/** Owns one board's document: loading it from its sidecar, every mutation to it, undo/redo, and
 * debounced persistence back to disk.
 *
 * Undo/redo snapshots the whole element array rather than recording per-operation inverse deltas.
 * A board's elements are small plain objects and a snapshot is a shallow array copy sharing every
 * unchanged element, so the cost is one pointer per element per undo step - cheap enough that the
 * complexity of an inverse-delta system (and the class of bugs where one operation's inverse is
 * subtly wrong) buys nothing here. `HISTORY_LIMIT` bounds the worst case.
 *
 * Only `elements` participates in history. Surface and viewport changes are persisted but are
 * deliberately *not* undoable: undoing a pan is the classic surprising-undo bug, and "undo" after
 * a stroke should remove the stroke no matter how much the user panned in between. */

const HISTORY_LIMIT = 100;
const SAVE_DEBOUNCE_MS = 400;

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

export function useBoardStore(notePath: string, onElementsChanged?: (els: BoardElement[]) => void): BoardStore {
  const [doc, setDoc] = useState<BoardDoc>(() => emptyBoard());
  const [loading, setLoading] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const undoStack = useRef<BoardElement[][]>([]);
  const redoStack = useRef<BoardElement[][]>([]);
  const docRef = useRef(doc);
  docRef.current = doc;
  // Guards the save effect from writing the sidecar back out during the initial load - without it,
  // mounting a board would immediately persist the empty placeholder doc over the real file.
  const loadedRef = useRef(false);
  const changedRef = useRef(onElementsChanged);
  changedRef.current = onElementsChanged;

  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setLoading(true);
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
    void (async () => {
      const loaded = await readBoard(notePath);
      if (cancelled) return;
      setDoc(loaded ?? emptyBoard());
      loadedRef.current = true;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [notePath]);

  const persist = useDebouncedCallback((next: BoardDoc) => {
    void writeBoard(notePath, next);
  }, SAVE_DEBOUNCE_MS);

  // A single funnel for every state change, so persistence can never be forgotten at a call site.
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
      apply({ ...docRef.current, elements: next });
      changedRef.current?.(next);
    },
    [apply],
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
    (surface: BoardSurface) => apply({ ...docRef.current, surface }),
    [apply],
  );

  // Panning/zooming fires continuously and does have to re-render (the world transform reads it),
  // but the *only* consumer of the persisted value is the next time this board is opened - so
  // routing it through the same debounced writer as everything else collapses a whole pan gesture
  // into a single file write.
  const setViewport = useCallback(
    (viewport: BoardViewport) => apply({ ...docRef.current, viewport }),
    [apply],
  );

  // Last-chance flush: the debounced writer would otherwise drop a pending save when the note is
  // closed or the window unmounts within SAVE_DEBOUNCE_MS of the final edit.
  useEffect(() => {
    return () => {
      if (loadedRef.current) void writeBoard(notePath, docRef.current);
    };
  }, [notePath]);

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
