import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  Copy,
  MoreHorizontal,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTopClose,
  PanelTopOpen,
  Pin,
  PinOff,
  Settings,
  Square,
  X,
} from "lucide-react";
import { ModeToggle } from "./ModeToggle";
import type { AppMode } from "../types";

interface HeaderProps {
  view: "home" | "note";
  onBack: () => void;
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  onDuplicateWindow: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  toolbarVisible: boolean;
  onToggleToolbar: () => void;
  /** Whether the sidebar overlay is currently open - only meaningful once the app is narrow
   * enough for the sidebar to have become an overlay (see Sidebar.tsx's own @max-2xl: classes). */
  sidebarOpen: boolean;
  /** Opens the sidebar overlay - only rendered once the app is narrow enough for the sidebar to
   * have become an overlay (see Sidebar.tsx's own @max-2xl: classes, which this button matches). */
  onToggleSidebar: () => void;
  /** Whether the sidebar is manually collapsed at normal (non-overlay) widths. */
  sidebarCollapsed: boolean;
  /** Collapses/expands the sidebar - only rendered at widths where it isn't already an overlay,
   * complementing onToggleSidebar above. */
  onToggleSidebarCollapse: () => void;
  /** Whether the Study Mode feature is enabled - hides the Edit/Study ModeToggle when off. */
  studyModeFeatureEnabled: boolean;
  /** Whether the "Keep window on top" feature is enabled - hides the Pin button when off. */
  keepOnTopFeatureEnabled: boolean;
  /** Whether this window is currently pinned above others - lifted up to AppSettings so it's
   * also visible/settable from Settings, not just this button. */
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop: () => void;
  /** The open-tabs strip, rendered left-aligned next to the back button. */
  tabStrip?: React.ReactNode;
}

const appWindow = getCurrentWindow();

export function Header({
  view,
  onBack,
  mode,
  onModeChange,
  onDuplicateWindow,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
  toolbarVisible,
  onToggleToolbar,
  sidebarOpen,
  onToggleSidebar,
  sidebarCollapsed,
  onToggleSidebarCollapse,
  studyModeFeatureEnabled,
  keepOnTopFeatureEnabled,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  tabStrip,
}: HeaderProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const noteToolsDisabled = view !== "note" || mode !== "edit";

  useEffect(() => {
    if (!moreOpen) return;
    function onDocPointerDown(e: PointerEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [moreOpen]);

  return (
    <header
      data-tauri-drag-region="deep"
      className="glass-panel relative z-20 flex h-10 shrink-0 items-center gap-1.5 px-2.5 @max-sm:gap-1 @max-sm:px-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5" data-tauri-drag-region="deep">
        {settingsOpen ? (
          <button
            type="button"
            onClick={onCloseSettings}
            className="btn-ghost h-6 w-6"
            title="Exit settings"
            aria-label="Exit settings"
          >
            <ArrowLeft size={15} />
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggleSidebar}
              className="btn-ghost hidden h-6 w-6 shrink-0 @max-2xl:flex"
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            >
              {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>
            <button
              type="button"
              onClick={onToggleSidebarCollapse}
              className="btn-ghost flex h-6 w-6 shrink-0 @max-2xl:hidden"
              title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
            {view === "note" && (
              <button
                type="button"
                onClick={onBack}
                className="btn-ghost h-6 w-6 shrink-0"
                title="Back to Home"
                aria-label="Back to Home"
              >
                <ArrowLeft size={15} />
              </button>
            )}
            {tabStrip}
          </>
        )}
      </div>

      {/* Fixed-width handle, always reserved (not flex-1) so there's still a spot to drag the
       * window from even when open tabs fill the whole flexible area to their left and leave
       * no slack of their own - see the flex-1 strip in TabStrip.tsx for the "plenty of room"
       * case, where the leftover space after the tabs is itself the drag region instead. */}
      <div className="h-full w-[26px] shrink-0" data-tauri-drag-region="deep" />

      <div className="flex shrink-0 items-center">
        {!settingsOpen && (
          <>
            {view === "note" && studyModeFeatureEnabled && <ModeToggle mode={mode} onChange={onModeChange} />}

            {/* Normal widths: each action gets its own button. */}
            <div className="flex items-center @max-lg:hidden">
              <button
                type="button"
                onClick={onOpenSettings}
                className="btn-ghost h-6 w-6"
                title="Settings"
                aria-label="Open settings"
              >
                <Settings size={15} />
              </button>
              {view === "note" && (
                <button
                  type="button"
                  onClick={onToggleToolbar}
                  disabled={noteToolsDisabled}
                  aria-disabled={noteToolsDisabled}
                  className={`btn-ghost h-6 w-6 ${!toolbarVisible ? "bg-accent-soft text-accent" : ""} ${noteToolsDisabled ? "cursor-not-allowed opacity-50" : ""}`}
                  title={noteToolsDisabled ? "Hide formatting toolbar (edit mode only)" : toolbarVisible ? "Hide formatting toolbar" : "Show formatting toolbar"}
                  aria-pressed={!toolbarVisible}
                  aria-label="Toggle formatting toolbar"
                >
                  {toolbarVisible ? <PanelTopClose size={15} /> : <PanelTopOpen size={15} />}
                </button>
              )}
              <button
                type="button"
                onClick={onDuplicateWindow}
                className="btn-ghost h-6 w-6"
                title={view === "note" ? "Open this note in a new window" : "Open a new window"}
                aria-label="Duplicate window"
              >
                <Copy size={14} />
              </button>
              {keepOnTopFeatureEnabled && (
                <button
                  type="button"
                  onClick={onToggleAlwaysOnTop}
                  className={`btn-ghost h-6 w-6 ${alwaysOnTop ? "bg-accent-soft text-accent" : ""}`}
                  title={alwaysOnTop ? "Disable always on top" : "Keep window on top"}
                  aria-pressed={alwaysOnTop}
                  aria-label="Toggle always on top"
                >
                  {alwaysOnTop ? <Pin size={15} /> : <PinOff size={15} />}
                </button>
              )}
            </div>

            {/* Narrow widths: the same actions collapse into one menu so the window stays
             * draggable/usable instead of the buttons getting crowded out. */}
            <div ref={moreRef} className="relative hidden shrink-0 @max-lg:block">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                className={`btn-ghost h-6 w-6 ${moreOpen ? "bg-surface-hover" : ""}`}
                title="More actions"
                aria-label="More actions"
                aria-expanded={moreOpen}
              >
                <MoreHorizontal size={15} />
              </button>
              {moreOpen && (
                <div className="glass-surface shadow-app-lg absolute right-0 top-full z-50 mt-1 w-56 rounded-xl p-1 text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      onOpenSettings();
                    }}
                    className="menu-item flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
                  >
                    <Settings size={14} />
                    Settings
                  </button>
                  {view === "note" && (
                    <button
                      type="button"
                      onClick={() => {
                        if (noteToolsDisabled) return;
                        setMoreOpen(false);
                        onToggleToolbar();
                      }}
                      disabled={noteToolsDisabled}
                      aria-disabled={noteToolsDisabled}
                      className={`menu-item flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${noteToolsDisabled ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      {toolbarVisible ? <PanelTopClose size={14} /> : <PanelTopOpen size={14} />}
                      {toolbarVisible ? "Hide formatting toolbar" : "Show formatting toolbar"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      onDuplicateWindow();
                    }}
                    className="menu-item flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
                  >
                    <Copy size={14} />
                    {view === "note" ? "Open this note in a new window" : "Open a new window"}
                  </button>
                  {keepOnTopFeatureEnabled && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        onToggleAlwaysOnTop();
                      }}
                      className="menu-item flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
                    >
                      {alwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
                      {alwaysOnTop ? "Disable always on top" : "Keep window on top"}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="divider mx-0.5 h-5 w-px" />
          </>
        )}

        <button
          type="button"
          onClick={() => appWindow.minimize()}
          className="btn-ghost h-6 w-6"
          title="Minimize"
          aria-label="Minimize window"
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          onClick={() => appWindow.toggleMaximize()}
          className="btn-ghost h-6 w-6"
          title="Maximize"
          aria-label="Maximize window"
        >
          <Square size={12} />
        </button>
        <button
          type="button"
          onClick={() => appWindow.close()}
          className="btn-ghost h-6 w-6 hover:bg-red-500/20 hover:text-red-500"
          title="Close"
          aria-label="Close window"
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
