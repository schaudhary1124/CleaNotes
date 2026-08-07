import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Mic, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { VoiceRecording, formatDuration } from "../milkdown/voiceRecording";

/** "countdown" holds the mic *closed* while the lead-in runs (see VoiceRecording's own comment on
 * why the microphone is never opened before there's something to capture); "starting" covers the
 * getUserMedia round-trip; "saving" the stop/decode/re-encode one. */
type Phase = "countdown" | "starting" | "recording" | "paused" | "saving" | "error";

// Module-level so ToolbarPopover's click-outside effect sees a stable `onClose` (an inline arrow
// would be a new function on every timer tick, re-subscribing the document listener 5x a second).
const IGNORE_OUTSIDE_CLICK = () => {};

function describeMicError(err: unknown): string {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    return "Microphone access denied";
  }
  if (err instanceof DOMException && err.name === "NotFoundError") return "No microphone found";
  if (err instanceof DOMException && err.name === "NotReadableError") return "Microphone is in use elsewhere";
  if (!window.isSecureContext) return "Microphone unavailable (insecure context)";
  return err instanceof Error && err.message ? err.message : "Couldn't start recording";
}

interface VoiceRecorderPopoverProps {
  /** The inline voice-note glyph this panel hangs off - it pulses for the whole session (see
   * voiceNoteInlineView.ts's live glyph), so the panel always reads as belonging to that spot in
   * the text rather than floating free. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Lead-in before capture starts, from AppSettings.voiceNoteCountdown. 0 skips straight in. */
  countdownSeconds: number;
  /** Whether this session appends onto a clip that already exists - only changes wording here
   * (the actual concatenation happens in voiceNoteInlineView.ts's completeRecording). */
  isAppend: boolean;
  /** Hands the finished, already-normalized WAV bytes back to the NodeView to persist. */
  onComplete: (wav: Uint8Array, durationMs: number) => void;
  /** Discards the session - deletes a brand-new voice note outright, or leaves an appended-to one
   * exactly as it was. */
  onCancel: () => void;
}

/** The recording UI for a voice note: a countdown, then a live session the user can pause/resume,
 * restart from scratch, or throw away - all without the panel closing, so one recording attempt
 * is one continuous piece of UI rather than a pill that has to be re-opened between actions.
 *
 * Deliberately outside-click-proof (ToolbarPopover's onClose is a no-op here): every way out of
 * this panel either keeps the audio (Save) or discards it on purpose (Delete), so a stray click
 * in the note can't silently drop a recording that's still running. */
export function VoiceRecorderPopover({
  anchorRef,
  countdownSeconds,
  isAppend,
  onComplete,
  onCancel,
}: VoiceRecorderPopoverProps) {
  const sessionRef = useRef<VoiceRecording | null>(null);
  // Bumped on every start attempt and once more on unmount, so a getUserMedia promise that
  // resolves after its start was superseded (Restart pressed again, panel closed, React
  // StrictMode's double-invoked mount effects in dev) releases its stream instead of leaving a
  // second microphone open behind the one actually in use.
  const startGenRef = useRef(0);
  const savedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("countdown");
  const [remaining, setRemaining] = useState(countdownSeconds);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const begin = useCallback(async () => {
    const generation = ++startGenRef.current;
    setError(null);
    setElapsedMs(0);
    setPhase("starting");
    try {
      const session = await VoiceRecording.start();
      if (startGenRef.current !== generation) {
        session.cancel();
        return;
      }
      sessionRef.current = session;
      setPhase("recording");
    } catch (err) {
      if (startGenRef.current !== generation) return;
      // Logged as well as shown: the panel has room for a sentence, but a DOMException's own
      // message often names the exact device/constraint that failed.
      console.error("[voice note] couldn't start recording:", err);
      setError(describeMicError(err));
      setPhase("error");
    }
  }, []);

  // Drives the lead-in one second at a time, and starts capture when it runs out - a
  // countdownSeconds of 0 falls straight through to begin() on the first pass.
  useEffect(() => {
    if (phase !== "countdown") return;
    if (remaining <= 0) {
      void begin();
      return;
    }
    const timeout = window.setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => window.clearTimeout(timeout);
  }, [phase, remaining, begin]);

  // 200ms rather than 1s: the readout is mm:ss, but sampling at exactly the display resolution
  // makes the visible second tick land up to a full second late.
  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => {
      if (sessionRef.current) setElapsedMs(sessionRef.current.elapsedMs());
    }, 200);
    return () => window.clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    return () => {
      startGenRef.current++;
      // Unmounting without having saved (the note was closed, the atom deleted out from under the
      // panel, ...) must not leave the mic open - Save clears sessionRef itself, so anything
      // still here is by definition unfinished.
      if (!savedRef.current) sessionRef.current?.cancel();
      sessionRef.current = null;
    };
  }, []);

  function handlePauseResume() {
    const session = sessionRef.current;
    if (!session) return;
    if (phase === "recording") {
      session.pause();
      setElapsedMs(session.elapsedMs());
      setPhase("paused");
    } else if (phase === "paused") {
      session.resume();
      setPhase("recording");
    }
  }

  /** Throws away what's been captured and runs the whole flow again from the countdown - the
   * lead-in is there to get ready, and re-recording is exactly when that's wanted again. Drops
   * the old session entirely (rather than reusing its stream) so the new clip starts from a
   * genuinely fresh recorder. */
  function handleRestart() {
    sessionRef.current?.cancel();
    sessionRef.current = null;
    setElapsedMs(0);
    setError(null);
    if (countdownSeconds > 0) {
      setRemaining(countdownSeconds);
      setPhase("countdown");
    } else {
      void begin();
    }
  }

  function handleDelete() {
    startGenRef.current++;
    sessionRef.current?.cancel();
    sessionRef.current = null;
    onCancel();
  }

  async function handleSave() {
    const session = sessionRef.current;
    if (!session) return;
    setPhase("saving");
    try {
      const { wav, durationMs } = await session.stop();
      savedRef.current = true;
      sessionRef.current = null;
      onComplete(wav, durationMs);
    } catch (err) {
      console.error("[voice note] couldn't finish recording:", err);
      sessionRef.current = null;
      setError(err instanceof Error && err.message ? err.message : "Couldn't save recording");
      setPhase("error");
    }
  }

  const live = phase === "recording";
  const counting = phase === "countdown";
  const hasAudio = (phase === "recording" || phase === "paused") && elapsedMs > 0;

  const status = (() => {
    switch (phase) {
      case "countdown":
        return isAppend ? "Recording more in…" : "Recording in…";
      case "starting":
        return "Opening microphone…";
      case "recording":
        return isAppend ? "Recording more" : "Recording";
      case "paused":
        return "Paused";
      case "saving":
        return "Saving…";
      case "error":
        return "Recording failed";
    }
  })();

  return (
    <ToolbarPopover
      anchorRef={anchorRef}
      onClose={IGNORE_OUTSIDE_CLICK}
      className="glass-panel shadow-app-lg border-subtle w-64 rounded-2xl border p-3"
    >
      <div className="flex items-center gap-3 px-0.5">
        {/* A button only while counting down - "I'm ready, go now" is the one thing the orb does,
            and leaving it clickable afterwards would invite clicking it to stop. */}
        <button
          type="button"
          onClick={counting ? () => setRemaining(0) : undefined}
          disabled={!counting}
          title={counting ? "Start recording now" : status}
          aria-label={counting ? "Start recording now" : status}
          className={`voice-rec-orb ${live ? "is-live" : ""} ${counting ? "is-counting" : ""}`}
        >
          {counting ? <span className="text-sm font-semibold tabular-nums">{remaining}</span> : <Mic size={17} />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-primary truncate text-sm font-medium">{status}</p>
          <p className="text-tertiary text-xs">
            {phase === "error" ? "Nothing was saved" : isAppend ? "Adds onto the existing clip" : "Voice note"}
          </p>
        </div>
        {phase !== "error" && (
          <span className="text-secondary shrink-0 text-sm tabular-nums">{formatDuration(elapsedMs)}</span>
        )}
      </div>

      {error && <p className="text-danger px-0.5 pt-2 text-xs">{error}</p>}

      <div className="border-subtle mt-2.5 flex items-center gap-1 border-t pt-2.5">
        {phase === "error" ? (
          <>
            <button
              type="button"
              onClick={handleRestart}
              className="btn-ghost border-subtle flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium"
            >
              <RotateCcw size={13} /> Try again
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="btn-ghost border-subtle flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium"
            >
              <X size={13} /> Close
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={handlePauseResume}
              disabled={!live && phase !== "paused"}
              title={phase === "paused" ? "Resume recording" : "Pause recording"}
              aria-label={phase === "paused" ? "Resume recording" : "Pause recording"}
              className="btn-ghost flex h-8 w-8 shrink-0 items-center justify-center rounded-lg disabled:opacity-30"
            >
              {phase === "paused" ? <Play size={14} className="ml-0.5" /> : <Pause size={14} />}
            </button>
            <button
              type="button"
              onClick={handleRestart}
              disabled={phase === "saving"}
              title="Restart recording"
              aria-label="Restart recording"
              className="btn-ghost flex h-8 w-8 shrink-0 items-center justify-center rounded-lg disabled:opacity-30"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={phase === "saving"}
              title={isAppend ? "Discard this addition" : "Delete recording"}
              aria-label={isAppend ? "Discard this addition" : "Delete recording"}
              className="btn-ghost hover:bg-danger-soft hover:text-danger flex h-8 w-8 shrink-0 items-center justify-center rounded-lg disabled:opacity-30"
            >
              <Trash2 size={14} />
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => void handleSave()}
              // hasAudio is only ever true mid-session, so this also covers "saving" (the stop is
              // already in flight) and the pre-roll phases (nothing captured yet to save).
              disabled={!hasAudio}
              title="Stop and save"
              aria-label="Stop and save voice note"
              className="bg-accent-solid flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-white transition-[filter,opacity] duration-150 hover:brightness-110 disabled:opacity-40"
            >
              <Check size={13} /> Save
            </button>
          </>
        )}
      </div>
    </ToolbarPopover>
  );
}
