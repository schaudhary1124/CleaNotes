import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Calendar,
  Check,
  Code,
  Copy,
  Download,
  GraduationCap,
  KeyRound,
  Mic,
  Minus,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Brush,
  UserX,
} from "lucide-react";
import type { AppSettings, FeatureFlags, ThemeName } from "../types";
import type { AppUpdaterState } from "../hooks/useAppUpdater";
import { listSharedNotes, revokeCollaborator, type SharedNoteSummary } from "../collab/acl";
import { loadOrCreateIdentity } from "../collab/identity";
import { formatRelativeTime } from "../utils/relativeTime";
import { clampVoiceCountdown, VOICE_COUNTDOWN_MAX, VOICE_COUNTDOWN_MIN } from "../utils/settings";
import { Switch } from "./Switch";

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
  updaterState: AppUpdaterState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onRestart: () => void;
}

const THEMES: { value: ThemeName; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "midnight", label: "Midnight" },
];

const ACCENTS = [
  { value: "indigo", color: "rgb(99 102 241)" },
  { value: "violet", color: "rgb(139 92 246)" },
  { value: "blue", color: "rgb(59 130 246)" },
  { value: "rose", color: "rgb(244 63 94)" },
  { value: "amber", color: "rgb(217 119 6)" },
  { value: "emerald", color: "rgb(5 150 105)" },
];

const FEATURES: { key: keyof FeatureFlags; label: string; description: string; icon: typeof Calendar }[] = [
  { key: "calendar", label: "Calendar", description: "Mini calendar in the sidebar", icon: Calendar },
  { key: "sketch", label: "Sketch", description: "Freehand drawing on top of notes", icon: Brush },
  { key: "studyMode", label: "Study Mode", description: "Flashcards and quizzes for a note", icon: GraduationCap },
  { key: "codeBlock", label: "Code Block", description: "Insert syntax-highlighted code blocks", icon: Code },
  { key: "keepOnTop", label: "Keep window on top", description: "Pin this window above others", icon: Pin },
  { key: "voiceNotes", label: "Voice Notes", description: "Record audio notes inline", icon: Mic },
];

export function SettingsPanel({
  settings,
  onChange,
  onClose,
  updaterState,
  onCheckForUpdates,
  onInstallUpdate,
  onRestart,
}: SettingsPanelProps) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [devicePublicKey, setDevicePublicKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [sharedNotes, setSharedNotes] = useState<SharedNoteSummary[] | null>(null);
  // Set the moment a manual check is kicked off, so once the phase settles back to "idle" we
  // know that was in response to this check (rather than just the hook's initial idle state) and
  // can show "You're up to date" instead of nothing.
  const justCheckedRef = useRef(false);
  const [justCheckedIdle, setJustCheckedIdle] = useState(false);

  useEffect(() => {
    void getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    void loadOrCreateIdentity().then((identity) => setDevicePublicKey(identity.publicKeyHex));
    void refreshSharedNotes();
  }, []);

  function refreshSharedNotes() {
    return listSharedNotes().then(setSharedNotes);
  }

  async function handleRevokeFromSettings(notePath: string, pubKey: string) {
    await revokeCollaborator(notePath, pubKey);
    void refreshSharedNotes();
  }

  async function handleCopyKey() {
    if (!devicePublicKey) return;
    await navigator.clipboard.writeText(devicePublicKey);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  }

  useEffect(() => {
    if (updaterState.phase === "checking") {
      justCheckedRef.current = true;
      setJustCheckedIdle(false);
    } else if (updaterState.phase === "idle" && justCheckedRef.current) {
      justCheckedRef.current = false;
      setJustCheckedIdle(true);
    } else if (updaterState.phase !== "idle") {
      setJustCheckedIdle(false);
    }
  }, [updaterState.phase]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function toggleFeature(key: keyof FeatureFlags) {
    onChange({ ...settings, features: { ...settings.features, [key]: !settings.features[key] } });
  }

  function setVoiceCountdown(seconds: number) {
    onChange({ ...settings, voiceNoteCountdown: clampVoiceCountdown(seconds) });
  }

  // The button drives whatever action the current phase calls for, rather than only ever
  // re-checking - so the user explicitly opts in to each step (download, then restart).
  const updateButton = (() => {
    switch (updaterState.phase) {
      case "checking":
        return { label: "Checking…", icon: RefreshCw, spin: true, disabled: true, onClick: onCheckForUpdates };
      case "available":
        return {
          label: `Update to v${updaterState.version}`,
          icon: Download,
          spin: false,
          disabled: false,
          onClick: onInstallUpdate,
        };
      case "downloading":
        return { label: "Downloading…", icon: Download, spin: true, disabled: true, onClick: onInstallUpdate };
      case "ready":
        return { label: "Restart Application", icon: RotateCcw, spin: false, disabled: false, onClick: onRestart };
      default:
        return { label: "Check for Updates", icon: RefreshCw, spin: false, disabled: false, onClick: onCheckForUpdates };
    }
  })();

  return (
    <div className="glass-panel shadow-app animate-fade-in relative flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-md p-5 @max-sm:p-4">
        <div className="border-subtle mb-4 border-b pb-3">
          <p className="text-primary text-base font-semibold">Settings</p>
        </div>

        <div className="space-y-5">
          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Theme
            </p>
            <div className="flex gap-2">
              {THEMES.map((theme) => (
                <button
                  key={theme.value}
                  type="button"
                  onClick={() => onChange({ ...settings, theme: theme.value })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors duration-150 ${
                    settings.theme === theme.value
                      ? "border-accent-soft bg-accent-soft text-accent font-medium"
                      : "border-subtle text-secondary hover:bg-surface-hover"
                  }`}
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Accent color
            </p>
            <div className="flex flex-wrap gap-3">
              {ACCENTS.map((accent) => {
                const selected = settings.accent === accent.value;
                return (
                  <button
                    key={accent.value}
                    type="button"
                    onClick={() => onChange({ ...settings, accent: accent.value })}
                    title={accent.value}
                    aria-label={`Accent ${accent.value}`}
                    aria-pressed={selected}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110"
                    style={{
                      backgroundColor: accent.color,
                      boxShadow: selected ? `0 0 0 2px var(--surface-strong), 0 0 0 4px ${accent.color}` : "none",
                    }}
                  >
                    {selected && <Check size={14} className="text-white" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Features
            </p>
            <div className="space-y-1">
              {FEATURES.map((feature) => (
                <div
                  key={feature.key}
                  className="border-subtle flex items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <feature.icon size={16} className="text-secondary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-primary text-sm font-medium">{feature.label}</p>
                    <p className="text-tertiary text-xs">{feature.description}</p>
                  </div>
                  {/* Voice Notes carries one extra setting - the recording countdown - inline in
                      its own row rather than in a section of its own: it's a single number that
                      only means anything while the feature is on, so it belongs next to the
                      switch that turns it on. Hidden entirely when off, for the same reason. */}
                  {feature.key === "voiceNotes" && settings.features.voiceNotes && (
                    <div className="border-subtle flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5">
                      <button
                        type="button"
                        onClick={() => setVoiceCountdown(settings.voiceNoteCountdown - 1)}
                        disabled={settings.voiceNoteCountdown <= VOICE_COUNTDOWN_MIN}
                        title="Shorter countdown before recording starts"
                        aria-label="Shorter countdown before recording starts"
                        className="btn-ghost flex h-6 w-6 items-center justify-center rounded-md disabled:opacity-30"
                      >
                        <Minus size={12} />
                      </button>
                      <span
                        title="Countdown before recording starts"
                        className="text-primary w-8 text-center text-xs font-medium tabular-nums"
                      >
                        {settings.voiceNoteCountdown === 0 ? "Off" : `${settings.voiceNoteCountdown}s`}
                      </span>
                      <button
                        type="button"
                        onClick={() => setVoiceCountdown(settings.voiceNoteCountdown + 1)}
                        disabled={settings.voiceNoteCountdown >= VOICE_COUNTDOWN_MAX}
                        title="Longer countdown before recording starts"
                        aria-label="Longer countdown before recording starts"
                        className="btn-ghost flex h-6 w-6 items-center justify-center rounded-md disabled:opacity-30"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  )}
                  <Switch
                    checked={settings.features[feature.key]}
                    onChange={() => toggleFeature(feature.key)}
                    label={`Toggle ${feature.label}`}
                  />
                </div>
              ))}
            </div>
          </section>

          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Collaboration
            </p>
            <div className="space-y-3">
              <div className="border-subtle flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <KeyRound size={16} className="text-secondary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-primary text-sm font-medium">This device's identity</p>
                  <p className="text-tertiary truncate font-mono text-xs">
                    {devicePublicKey ? `${devicePublicKey.slice(0, 12)}…${devicePublicKey.slice(-12)}` : "Generating…"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyKey()}
                  disabled={!devicePublicKey}
                  className="btn-ghost h-8 w-8 shrink-0"
                  title="Copy full public key"
                  aria-label="Copy full public key"
                >
                  {keyCopied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>

              {sharedNotes && sharedNotes.some((s) => s.acl.collaborators.some((c) => c.status === "active")) && (
                <div>
                  <p className="text-tertiary mb-1.5 text-xs">Notes you've shared</p>
                  <div className="space-y-2">
                    {sharedNotes
                      .filter((s) => s.acl.collaborators.some((c) => c.status === "active"))
                      .map((shared) => (
                        <div key={shared.notePath} className="border-subtle rounded-lg border px-3 py-2">
                          <p className="text-primary truncate text-sm font-medium">{shared.noteTitle}</p>
                          <div className="mt-1.5 space-y-1">
                            {shared.acl.collaborators
                              .filter((c) => c.status === "active")
                              .map((c) => (
                                <div key={c.pubKey} className="flex items-center gap-2">
                                  <span className="text-secondary flex-1 truncate text-xs">
                                    {c.displayName} · {c.role}
                                    {c.lastSeenAt ? ` · seen ${formatRelativeTime(c.lastSeenAt)}` : ""}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => void handleRevokeFromSettings(shared.notePath, c.pubKey)}
                                    className="btn-ghost h-6 w-6 shrink-0 hover:bg-red-500/20 hover:text-red-500"
                                    title={`Revoke ${c.displayName}'s access`}
                                    aria-label={`Revoke ${c.displayName}'s access`}
                                  >
                                    <UserX size={12} />
                                  </button>
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section>
            <p className="text-secondary mb-2 text-xs font-semibold uppercase tracking-wider">
              Updates
            </p>
            <div className="border-subtle flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-primary text-sm font-medium">
                  {appVersion ? `CleaNotes v${appVersion}` : "CleaNotes"}
                </p>
                <p className="text-tertiary text-xs">
                  {updaterState.phase === "checking" && "Checking for updates…"}
                  {updaterState.phase === "idle" && justCheckedIdle && "You're up to date"}
                  {updaterState.phase === "idle" && !justCheckedIdle && "Check for the latest version"}
                  {updaterState.phase === "available" && `Update available — v${updaterState.version}`}
                  {updaterState.phase === "downloading" && "Downloading update…"}
                  {updaterState.phase === "ready" && "Update ready — restart to install"}
                  {updaterState.phase === "error" && "Couldn't check for updates"}
                </p>
              </div>
              <button
                type="button"
                onClick={updateButton.onClick}
                disabled={updateButton.disabled}
                className="btn-ghost border-subtle flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                <updateButton.icon size={13} className={updateButton.spin ? "animate-spin" : ""} />
                {updateButton.label}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
