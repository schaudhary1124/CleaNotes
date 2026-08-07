import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Square, X } from "lucide-react";
import { hashAssetBytes } from "../collab/assetStore";
import { fsAssetStore } from "../utils/fsNotes";
import { VoiceRecording, computePeaks, decodeWav, formatDuration } from "../milkdown/voiceRecording";

/** Records a voice note for placement on a board.
 *
 * The capture, encoding and waveform work is entirely `milkdown/voiceRecording.ts`'s - the same
 * module the in-note recorder uses - so a board voice note is byte-identical to an inline one and
 * lands in the same content-addressed asset store. Only the surrounding UI is new: an inline modal
 * rather than a popover anchored to a document position, since a board has no such position.
 *
 * The "get ready" countdown honours the app-wide `voiceNoteCountdown` setting, and deliberately
 * doesn't open the microphone until it elapses (see VoiceRecording.start's own comment) - the mic
 * indicator should never be lit while nothing is being captured. */
export function VoiceCapture({
  countdownSeconds,
  onCancel,
  onComplete,
}: {
  countdownSeconds: number;
  onCancel: () => void;
  onComplete: (result: { src: string; durationMs: number; peaks: number[] }) => void;
}) {
  const [phase, setPhase] = useState<"countdown" | "recording" | "saving">(
    countdownSeconds > 0 ? "countdown" : "recording",
  );
  const [countdown, setCountdown] = useState(countdownSeconds);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);

  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      setPhase("recording");
      return;
    }
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, countdown]);

  useEffect(() => {
    if (phase !== "recording" || recordingRef.current) return;
    let cancelled = false;
    void VoiceRecording.start()
      .then((recording) => {
        if (cancelled) {
          recording.cancel();
          return;
        }
        recordingRef.current = recording;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't start recording");
      });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setElapsed(recordingRef.current?.elapsedMs() ?? 0), 200);
    return () => clearInterval(timer);
  }, [phase]);

  // Releases the microphone if this component goes away without a stop/cancel button press -
  // the note being closed mid-recording, say. Without it the OS mic indicator stays lit.
  useEffect(() => {
    return () => {
      recordingRef.current?.cancel();
      recordingRef.current = null;
    };
  }, []);

  async function stopAndSave() {
    const recording = recordingRef.current;
    if (!recording) {
      onCancel();
      return;
    }
    setPhase("saving");
    try {
      const { wav, durationMs } = await recording.stop();
      recordingRef.current = null;
      const hash = await hashAssetBytes(wav);
      await fsAssetStore.put(hash, wav);
      // 96 buckets is roughly one bar per 3px across a default-width voice element - dense enough
      // to read as a waveform, cheap enough to store inline in the board document.
      const peaks = computePeaks(await decodeWav(wav), 96);
      onComplete({ src: hash, durationMs, peaks });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that recording");
      setPhase("recording");
    }
  }

  function cancel() {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    onCancel();
  }

  return (
    <div
      className="animate-fade-in absolute inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onPointerDown={cancel}
    >
      <div
        className="glass-surface shadow-app-lg w-full max-w-xs rounded-2xl p-5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Mic size={15} className="text-accent" />
          <span className="text-primary text-sm font-medium">Voice note</span>
          <button type="button" className="btn-ghost ml-auto h-6 w-6" onClick={cancel} aria-label="Cancel">
            <X size={13} />
          </button>
        </div>

        {error ? (
          <p className="text-danger px-1 py-2 text-xs">{error}</p>
        ) : phase === "countdown" ? (
          <p className="text-secondary px-1 py-3 text-center text-2xl tabular-nums">{countdown}</p>
        ) : (
          <p className="px-1 py-3 text-center text-2xl tabular-nums">{formatDuration(elapsed)}</p>
        )}

        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            className="btn-ghost h-8 w-8"
            disabled={phase !== "recording" || !!error}
            onClick={() => {
              const recording = recordingRef.current;
              if (!recording) return;
              if (recording.isPaused()) {
                recording.resume();
                setPaused(false);
              } else {
                recording.pause();
                setPaused(true);
              }
            }}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            type="button"
            className="bg-accent-solid inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-white transition-colors duration-150 disabled:opacity-50"
            disabled={phase === "saving" || !!error}
            onClick={() => void stopAndSave()}
          >
            <Square size={12} />
            {phase === "saving" ? "Saving…" : "Stop & place"}
          </button>
        </div>
      </div>
    </div>
  );
}
