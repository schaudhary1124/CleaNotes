import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  Copy,
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
  tabStrip,
}: HeaderProps) {
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);

  async function toggleAlwaysOnTop() {
    const next = !alwaysOnTop;
    await appWindow.setAlwaysOnTop(next);
    setAlwaysOnTop(next);
  }

  const noteToolsDisabled = view !== "note" || mode !== "edit";

  return (
    <header
      data-tauri-drag-region="deep"
      className="glass-panel relative z-20 flex h-10 shrink-0 items-center gap-1.5 px-2.5 @max-sm:gap-1 @max-sm:px-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
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

      <div className="flex shrink-0 items-center">
        {!settingsOpen && (
          <>
            {view === "note" && <ModeToggle mode={mode} onChange={onModeChange} />}
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
            <button
              type="button"
              onClick={toggleAlwaysOnTop}
              className={`btn-ghost h-6 w-6 ${alwaysOnTop ? "bg-accent-soft text-accent" : ""}`}
              title={alwaysOnTop ? "Disable always on top" : "Keep window on top"}
              aria-pressed={alwaysOnTop}
              aria-label="Toggle always on top"
            >
              {alwaysOnTop ? <Pin size={15} /> : <PinOff size={15} />}
            </button>

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
