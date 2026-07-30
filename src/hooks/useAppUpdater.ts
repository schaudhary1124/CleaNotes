import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// CleaNotes tends to stay open for days at a time, so a launch-only check isn't enough -
// re-check periodically to catch releases published while the app is running.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type AppUpdaterState =
  | { phase: "idle" | "checking" }
  | { phase: "available"; version: string }
  | { phase: "downloading" }
  | { phase: "ready" }
  | { phase: "error"; message: string };

export function useAppUpdater(enabled: boolean) {
  const [state, setState] = useState<AppUpdaterState>({ phase: "idle" });
  const updateRef = useRef<Update | null>(null);

  const checkNow = useCallback(async () => {
    if (!enabled) return;
    setState((current) => (current.phase === "idle" ? { phase: "checking" } : current));
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setState({ phase: "available", version: update.version });
      } else {
        setState((current) => (current.phase === "checking" ? { phase: "idle" } : current));
      }
    } catch (err) {
      // Background check failures (offline, GitHub unreachable, no release published yet)
      // shouldn't surface to the user - just retry on the next interval.
      console.error("Update check failed:", err);
      setState((current) => (current.phase === "checking" ? { phase: "idle" } : current));
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void checkNow();
    const interval = setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, checkNow]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setState({ phase: "downloading" });
    try {
      await update.downloadAndInstall();
      setState({ phase: "ready" });
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : "Update failed" });
    }
  }, []);

  const restartNow = useCallback(() => {
    void relaunch();
  }, []);

  return { state, checkNow, installUpdate, restartNow };
}
