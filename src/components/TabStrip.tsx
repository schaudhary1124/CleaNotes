import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { createDetachedWindow, MERGE_TAB_EVENT, type MergeTabPayload } from "../utils/windowInstance";
import {
  broadcastTabStripRect,
  onTabStripRectRequested,
  otherTabStripRects,
  pointInRect,
  requestTabStripRects,
  type ScreenRect,
} from "../utils/tabStripRegistry";

// Temporary diagnostics for the cross-window merge feature - safe to remove once it's
// confirmed working end to end. Prefixed so it's easy to filter/find in devtools.
const log = (...args: unknown[]) => console.log("[tabstrip]", ...args);

export interface TabNote {
  path: string;
  title: string;
}

interface TabStripProps {
  tabs: TabNote[];
  activeNotePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => Promise<void>;
  onReorderTabs: (next: string[]) => void;
  onNewNote: () => void;
  /** Resolves a tab's latest content (flushing first if it's the active tab) once a drag
   * resolves into an actual detach - called at most once per gesture, at drop time. */
  onPrepareDetach: (path: string) => Promise<string>;
}

const CLICK_THRESHOLD = 4;
/** Vertical distance (px) past the strip before a tab-drag counts as "dragging out". */
const DRAG_OUT_THRESHOLD = 28;

/** Chrome-style tab sizing: tabs shrink together to fit the available width, down to a floor,
 * below which the least-recently-used tabs collapse into an overflow dropdown instead. */
const TAB_MAX_WIDTH = 176;
const TAB_MIN_WIDTH = 92;
/** Reserved strip width for the trailing controls, so tabs never grow to fill leftover space
 * and push those controls away from the last tab (measured to match their rendered classes). */
const NEW_TAB_BUTTON_WIDTH = 24;
const OVERFLOW_BUTTON_WIDTH = 44;

interface TabLayout {
  visible: string[];
  hidden: string[];
  tabWidth: number;
}

/** Decides which tabs stay in the strip and how wide each one gets. When everything fits, all
 * tabs shrink evenly toward TAB_MIN_WIDTH; once that floor is hit, the tabs accessed longest
 * ago move into the overflow dropdown so the ones still visible fit at the floor width. */
function computeTabLayout(
  order: string[],
  stripWidth: number,
  forcedPaths: string[],
  lastAccess: Map<string, number>,
): TabLayout {
  const n = order.length;
  if (n === 0) return { visible: [], hidden: [], tabWidth: TAB_MAX_WIDTH };
  if (stripWidth <= 0) return { visible: order, hidden: [], tabWidth: TAB_MAX_WIDTH };

  const areaWidth = stripWidth - NEW_TAB_BUTTON_WIDTH;
  const idealWidth = areaWidth / n;
  if (idealWidth >= TAB_MIN_WIDTH) {
    return { visible: order, hidden: [], tabWidth: Math.min(TAB_MAX_WIDTH, idealWidth) };
  }

  // Doesn't fit even at the floor width - the overflow control will show, so its width also
  // needs to come out of the budget before deciding how many tabs actually fit.
  const overflowAreaWidth = areaWidth - OVERFLOW_BUTTON_WIDTH;
  const maxFit = Math.max(0, Math.floor(overflowAreaWidth / TAB_MIN_WIDTH));

  const byRecency = [...order].sort((a, b) => (lastAccess.get(b) ?? 0) - (lastAccess.get(a) ?? 0));
  const visibleSet = new Set(byRecency.slice(0, maxFit));
  // A tab actively being viewed or dragged must stay visible, even if it'd otherwise lose out
  // to more-recently-accessed tabs - bumping the stalest non-forced tab out to make room. Skipped
  // entirely once there's no room for even one tab, so everything just collapses into the dropdown.
  for (const forced of maxFit > 0 ? forcedPaths : []) {
    if (!forced || visibleSet.has(forced)) continue;
    let leastRecent: string | null = null;
    let leastScore = Infinity;
    for (const path of visibleSet) {
      if (forcedPaths.includes(path)) continue;
      const score = lastAccess.get(path) ?? 0;
      if (score < leastScore) {
        leastScore = score;
        leastRecent = path;
      }
    }
    if (leastRecent) visibleSet.delete(leastRecent);
    visibleSet.add(forced);
  }

  return {
    visible: order.filter((p) => visibleSet.has(p)),
    hidden: order.filter((p) => !visibleSet.has(p)),
    tabWidth: TAB_MIN_WIDTH,
  };
}

interface DragSession {
  path: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer's offset within the tab element, so a new standalone window (if that's how this
   * resolves) is positioned with the grabbed point under the cursor. */
  grabOffsetX: number;
  grabOffsetY: number;
  mode: "pending" | "reorder" | "dragging-out";
  /** This window's own outer bounds, fetched once at drag-start - used so a drag that leaves
   * the window horizontally (e.g. toward an adjacent window) also counts as "dragging out",
   * not just a vertical drag past DRAG_OUT_THRESHOLD (which alone misses side-by-side window
   * layouts, where reaching a neighboring window's strip takes almost no vertical movement). */
  windowRect: ScreenRect | null;
}

/**
 * Chrome-style tab strip: click a tab to switch notes, drag to reorder, or drag it out of the
 * strip's band/window and drop it somewhere. Nothing is decided until the drop itself (no
 * live window-follow during the drag - a webview can't render outside its own OS window
 * bounds anyway, so trying to animate a real window under the cursor for the whole gesture
 * added a lot of failure modes for no functional benefit): dropping back on this strip is a
 * no-op, dropping on a *different* CleaNotes window's tab strip merges into it, and dropping
 * anywhere else opens the note in a new standalone window at the drop point.
 */
export function TabStrip({
  tabs,
  activeNotePath,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  onNewNote,
  onPrepareDetach,
}: TabStripProps) {
  const [liveOrder, setLiveOrderState] = useState<string[] | null>(null);
  const liveOrderRef = useRef<string[] | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Recency of each open tab, used to decide which tabs stay visible once there's no room for
  // all of them (see computeTabLayout) - not persisted, just an in-memory access order.
  const lastAccessRef = useRef(new Map<string, number>());
  const accessCounterRef = useRef(0);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => setStripWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const seen = lastAccessRef.current;
    for (const tab of tabs) {
      if (!seen.has(tab.path)) seen.set(tab.path, ++accessCounterRef.current);
    }
    const openPaths = new Set(tabs.map((t) => t.path));
    for (const path of seen.keys()) {
      if (!openPaths.has(path)) seen.delete(path);
    }
  }, [tabs]);

  useEffect(() => {
    if (activeNotePath) lastAccessRef.current.set(activeNotePath, ++accessCounterRef.current);
  }, [activeNotePath]);

  useEffect(() => {
    if (!overflowOpen) return;
    function onDocPointerDown(e: PointerEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [overflowOpen]);

  function setLiveOrder(order: string[] | null) {
    liveOrderRef.current = order;
    setLiveOrderState(order);
  }

  /** This strip's current screen-space rect, for the registry other windows use to detect a
   * tab being dropped on it, and for this window's own "dropped back on itself" check. */
  async function ownScreenRect(): Promise<ScreenRect | null> {
    const el = stripRef.current;
    if (!el) return null;
    try {
      const current = getCurrentWindow();
      const [pos, scale] = await Promise.all([current.outerPosition(), current.scaleFactor()]);
      const winPos = pos.toLogical(scale);
      const rect = el.getBoundingClientRect();
      return { x: winPos.x + rect.left, y: winPos.y + rect.top, width: rect.width, height: rect.height };
    } catch {
      return null;
    }
  }

  /** This whole window's current screen-space bounds (not just the strip) - used to detect
   * that a drag has left the window entirely. */
  async function ownWindowRect(): Promise<ScreenRect | null> {
    try {
      const current = getCurrentWindow();
      const [pos, size, scale] = await Promise.all([
        current.outerPosition(),
        current.outerSize(),
        current.scaleFactor(),
      ]);
      const p = pos.toLogical(scale);
      const s = size.toLogical(scale);
      return { x: p.x, y: p.y, width: s.width, height: s.height };
    } catch {
      return null;
    }
  }

  // Keeps every other window aware of where this strip is on screen, so a tab dragged out of
  // another window can be dropped here to merge in (see finishDragOut's counterpart there).
  // Since a window can mount after others already broadcast their rect, this also sends (and
  // answers) a catch-up request rather than only relying on the next move/resize elsewhere.
  useEffect(() => {
    let cancelled = false;
    let unlistenMoved: (() => void) | undefined;
    let unlistenRequest: (() => void) | undefined;

    async function publish() {
      const rect = await ownScreenRect();
      log("publishing own rect", rect);
      if (!cancelled) await broadcastTabStripRect(rect);
    }

    (async () => {
      unlistenRequest = await onTabStripRectRequested(() => {
        log("answering catch-up request from another window");
        void publish();
      });
      if (cancelled) {
        unlistenRequest();
        return;
      }
      await publish();
      await requestTabStripRects();
      log("mounted, listening + published own rect + sent catch-up request", {
        label: getCurrentWindow().label,
      });
    })();

    const el = stripRef.current;
    const observer = el ? new ResizeObserver(() => void publish()) : null;
    if (el && observer) observer.observe(el);
    void getCurrentWindow()
      .onMoved(() => void publish())
      .then((fn) => {
        if (cancelled) fn();
        else unlistenMoved = fn;
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      unlistenMoved?.();
      unlistenRequest?.();
      void broadcastTabStripRect(null);
    };
    // Runs once per mount - the strip only mounts while there's at least one tab open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function updateReorderPreview(e: PointerEvent) {
      const order = liveOrderRef.current;
      const drag = dragRef.current;
      if (!order || !drag) return;
      const currentIndex = order.indexOf(drag.path);
      let targetIndex = order.length - 1;
      for (let i = 0; i < order.length; i++) {
        const el = tabRefs.current.get(order[i]);
        if (!el) continue;
        if (e.clientX < el.getBoundingClientRect().left + el.offsetWidth / 2) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex === currentIndex) return;
      const next = order.filter((p) => p !== drag.path);
      next.splice(targetIndex, 0, drag.path);
      setLiveOrder(next);
    }

    // Vertical distance past the strip is the classic "tear off" gesture, but for windows
    // sitting side by side (same layout the merge feature is mostly used for) the cursor can
    // reach a neighboring window's tab strip with almost no vertical movement at all - so a
    // drag that has left this window's own bounds in *any* direction also counts.
    function isDraggingOut(drag: DragSession, e: PointerEvent): boolean {
      const dy = e.screenY - drag.startY;
      if (Math.abs(dy) > DRAG_OUT_THRESHOLD) return true;
      return drag.windowRect != null && !pointInRect({ x: e.screenX, y: e.screenY }, drag.windowRect);
    }

    async function finishDragOut(drag: DragSession, e: PointerEvent) {
      const point = { x: e.screenX, y: e.screenY };
      const ownRect = await ownScreenRect();
      const others = await otherTabStripRects();
      log("finishDragOut", { point, ownRect, others: Array.from(others.entries()) });

      if (ownRect && pointInRect(point, ownRect)) {
        log("finishDragOut: dropped back on own strip, no-op");
        return;
      }

      for (const [targetLabel, rect] of others) {
        if (!pointInRect(point, rect)) continue;
        log("finishDragOut: merging into", targetLabel);
        const content = await onPrepareDetach(drag.path);
        // Closing the tab here (state update + possibly flushing/reading a neighbor) doesn't
        // need to block the handoff - let it run alongside instead of in front of it.
        const closePromise = onCloseTab(drag.path);
        await emitTo(targetLabel, MERGE_TAB_EVENT, { path: drag.path, content } satisfies MergeTabPayload);
        await closePromise;
        return;
      }

      log("finishDragOut: no strip under drop point, opening a standalone window");
      const content = await onPrepareDetach(drag.path);
      // Same idea: don't make the new window wait on this window's own tab-close bookkeeping.
      const closePromise = onCloseTab(drag.path);
      await createDetachedWindow(
        drag.path,
        content,
        { x: point.x - drag.grabOffsetX, y: point.y - drag.grabOffsetY },
        drag.windowRect ? { width: drag.windowRect.width, height: drag.windowRect.height } : undefined,
      );
      await closePromise;
    }

    function handlePointerMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.screenX - drag.startX;
      const dy = e.screenY - drag.startY;

      if (drag.mode === "pending") {
        if (Math.abs(dx) < CLICK_THRESHOLD && Math.abs(dy) < CLICK_THRESHOLD) return;
        if (isDraggingOut(drag, e)) {
          log("pending -> dragging-out", { dx, dy });
          drag.mode = "dragging-out";
          return;
        }
        log("pending -> reorder");
        drag.mode = "reorder";
        setLiveOrder(tabs.map((t) => t.path));
        return;
      }

      if (drag.mode === "reorder") {
        if (isDraggingOut(drag, e)) {
          log("reorder -> dragging-out");
          drag.mode = "dragging-out";
          setLiveOrder(null);
          return;
        }
        updateReorderPreview(e);
        return;
      }

      // "dragging-out": nothing to track live - the outcome is resolved once at drop time.
    }

    function handlePointerUp(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      log("pointerup", { mode: drag.mode, screenX: e.screenX, screenY: e.screenY });
      if (drag.mode === "pending") {
        onSelectTab(drag.path);
      } else if (drag.mode === "reorder") {
        const order = liveOrderRef.current;
        setLiveOrder(null);
        if (order) onReorderTabs(order);
      } else if (drag.mode === "dragging-out") {
        void finishDragOut(drag, e);
      }
      dragRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [tabs, onSelectTab, onReorderTabs, onPrepareDetach, onCloseTab]);

  function handlePointerDown(e: React.PointerEvent, path: string) {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const drag: DragSession = {
      path,
      pointerId: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      grabOffsetX: e.clientX - rect.left,
      grabOffsetY: e.clientY - rect.top,
      mode: "pending",
      windowRect: null,
    };
    dragRef.current = drag;
    void ownWindowRect().then((r) => {
      if (dragRef.current === drag) drag.windowRect = r;
    });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  const byPath = new Map(tabs.map((t) => [t.path, t]));
  const order = liveOrder ?? tabs.map((t) => t.path);
  const draggingPath = liveOrder ? (dragRef.current?.path ?? null) : null;
  const { visible, hidden, tabWidth } = computeTabLayout(
    order,
    stripWidth,
    [activeNotePath, draggingPath].filter((p): p is string => p != null),
    lastAccessRef.current,
  );
  const hiddenTabs = hidden.map((p) => byPath.get(p)).filter((t): t is TabNote => t != null);

  return (
    <div ref={stripRef} className="flex min-w-0 flex-1 items-center">
      {/* No flex-grow here (unlike stripRef) - this box sizes to its tabs' natural width so the
       * trailing controls hug the last tab instead of drifting to the row's far edge. It stays
       * shrinkable + clipped so pathologically narrow windows crop overflow instead of letting
       * fixed-width tabs spill over the neighboring header buttons. */}
      <div className="flex min-w-0 items-center overflow-hidden">
        {visible.map((path, i) => {
          const tab = byPath.get(path);
          if (!tab) return null;
          const active = path === activeNotePath;
          const nextActive = visible[i + 1] === activeNotePath;
          const showDivider = i < visible.length - 1 && !active && !nextActive;
          return (
            <div
              key={path}
              ref={(el) => {
                if (el) tabRefs.current.set(path, el);
                else tabRefs.current.delete(path);
              }}
              onPointerDown={(e) => handlePointerDown(e, path)}
              role="tab"
              aria-selected={active}
              title={tab.title}
              className={`group box-border flex h-7 shrink-0 select-none items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors duration-100 ${
                active ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover hover:text-primary"
              }`}
              style={{
                width: tabWidth,
                borderRight: showDivider ? "1px solid var(--border)" : "1px solid transparent",
                touchAction: "none",
                cursor: "default",
                WebkitUserSelect: "none",
                userSelect: "none",
              }}
            >
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(path);
                }}
                className="hover:bg-surface-hover flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100"
                title="Close tab"
                aria-label={`Close ${tab.title}`}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
      {hiddenTabs.length > 0 && (
        <div ref={overflowRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setOverflowOpen((v) => !v)}
            className={`btn-ghost flex h-6 shrink-0 items-center gap-0.5 px-1 ${overflowOpen ? "bg-surface-hover" : ""}`}
            title={`${hiddenTabs.length} more tab${hiddenTabs.length === 1 ? "" : "s"}`}
            aria-label="Show more tabs"
            aria-expanded={overflowOpen}
          >
            <span className="text-xs">+{hiddenTabs.length}</span>
            <ChevronDown size={12} />
          </button>
          {overflowOpen && (
            <div className="glass-surface shadow-app-lg absolute left-0 top-full z-50 mt-1 max-h-72 w-52 overflow-y-auto rounded-xl p-1 text-sm">
              {hiddenTabs.map((tab) => (
                <div
                  key={tab.path}
                  className="menu-item group flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelectTab(tab.path);
                      setOverflowOpen(false);
                    }}
                    className="min-w-0 flex-1 truncate text-left"
                    title={tab.title}
                  >
                    {tab.title}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.path);
                    }}
                    className="hover:bg-surface-hover flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100"
                    title="Close tab"
                    aria-label={`Close ${tab.title}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onNewNote}
        className="btn-ghost h-6 w-6 shrink-0"
        title="New note here"
        aria-label="New note in this folder"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
