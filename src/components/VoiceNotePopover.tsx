import { useEffect, useRef, useState } from "react";
import { Mic, MoreVertical, Pause, Play, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { readAttachment } from "../utils/fsNotes";
import { computePeaks, decodeWav, formatDuration } from "../milkdown/voiceRecording";

// Same resolve-to-data-URL-and-cache shape imageView.ts's resolveSrc/uint8ToBase64 use for
// images - audio needs no mime lookup since every stored asset is always WAV (see
// voiceRecording.ts's module comment). Bytes are cached separately from the data URL so the
// waveform decode (computePeaks) never re-reads the asset off disk just to get the same bytes
// the data URL was already built from.
const bytesCache = new Map<string, Uint8Array>();
const resolvedCache = new Map<string, string>();

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function resolveVoiceBytes(relPath: string): Promise<Uint8Array> {
  const cached = bytesCache.get(relPath);
  if (cached) return cached;
  const bytes = await readAttachment(relPath);
  bytesCache.set(relPath, bytes);
  return bytes;
}

function resolveVoiceSrc(relPath: string, bytes: Uint8Array): string {
  const cached = resolvedCache.get(relPath);
  if (cached) return cached;
  const url = `data:audio/wav;base64,${uint8ToBase64(bytes)}`;
  resolvedCache.set(relPath, url);
  return url;
}

// Tuned against the panel's own width (w-72, close to VoiceRecorderPopover's w-64 so the two
// voice-note panels read as the same object in two states): fewer bars than the width used to
// allow, keeping the ~2px gap between them rather than letting them close up into a solid block.
const WAVEFORM_BAR_COUNT = 34;
// Flat placeholder shown while the clip is still being decoded into real peaks (see
// computePeaks) - a constant, not a fake waveform shape, so it doesn't read as real data.
const PLACEHOLDER_PEAKS = Array.from({ length: WAVEFORM_BAR_COUNT }, () => 0.18);

interface WaveformProps {
  peaks: number[];
  progress: number;
  disabled: boolean;
  onSeek: (fraction: number) => void;
}

/** The scrubbable bar row - click or drag anywhere in it to seek. Bars left of `progress` are
 * rendered in the accent color to read as "played", matching the reference design's filled/
 * unfilled waveform split. */
function Waveform({ peaks, progress, disabled, onSeek }: WaveformProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  function fractionFromEvent(e: { clientX: number }): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    trackRef.current?.setPointerCapture(e.pointerId);
    onSeek(fractionFromEvent(e));
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled || e.buttons !== 1) return;
    onSeek(fractionFromEvent(e));
  }

  return (
    <div
      ref={trackRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      className={`flex h-8 flex-1 items-center justify-between ${disabled ? "" : "cursor-pointer"}`}
    >
      {peaks.map((peak, i) => (
        <span
          key={i}
          style={{ height: `${Math.max(15, peak * 100)}%` }}
          className={`w-[2.5px] rounded-full ${i / peaks.length < progress ? "bg-accent-solid" : "bg-surface-hover"}`}
        />
      ))}
    </div>
  );
}

interface VoiceNotePopoverProps {
  voiceSrc: string;
  voiceDur: number;
  anchorRef: React.RefObject<HTMLElement | null>;
  onAppend: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/** Opened by clicking an occupied line's voice-note pill (see voiceNoteGrips.ts) - play the
 * recording (with a scrubbable waveform and +-5s skip, mirroring a standard voice-memo player),
 * record more onto it (appendWav in voiceRecording.ts always produces one continuous clip, never
 * a playlist), or remove it outright via the overflow menu. Mirrors NotePinPopover's shell in
 * SelectionLinkToolbar.tsx (same ToolbarPopover host). */
export function VoiceNotePopover({ voiceSrc, voiceDur, anchorRef, onAppend, onRemove, onClose }: VoiceNotePopoverProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(voiceDur / 1000);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(false);
    setPeaks(null);
    setCurrentTime(0);
    setDuration(voiceDur / 1000);
    resolveVoiceBytes(voiceSrc)
      .then((bytes) => {
        if (cancelled) return;
        setSrc(resolveVoiceSrc(voiceSrc, bytes));
        decodeWav(bytes)
          .then((buffer) => {
            if (!cancelled) setPeaks(computePeaks(buffer, WAVEFORM_BAR_COUNT));
          })
          .catch(() => {
            // Peaks are cosmetic (the placeholder bar shape stays up) - playback itself doesn't
            // depend on this decode succeeding.
          });
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [voiceSrc, voiceDur]);

  // Popover closes on outside click (see ToolbarPopover) without necessarily unmounting through
  // a state change that would otherwise pause playback - stop the clip going instead of leaving
  // it playing to a detached element.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handle(e: MouseEvent) {
      if (!menuHostRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else void audio.play();
  }

  function seekToFraction(fraction: number) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const next = Math.min(duration, Math.max(0, fraction * duration));
    audio.currentTime = next;
    setCurrentTime(next);
  }

  function skip(deltaSeconds: number) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const next = Math.min(duration, Math.max(0, audio.currentTime + deltaSeconds));
    audio.currentTime = next;
    setCurrentTime(next);
  }

  const disabled = !src || error;
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const displayMs = (currentTime > 0 ? currentTime : duration) * 1000;

  return (
    <ToolbarPopover
      anchorRef={anchorRef}
      onClose={onClose}
      className="glass-panel shadow-app-lg border-subtle w-72 rounded-2xl border p-3"
    >
      <div className="flex items-center justify-between px-1 pb-2.5">
        <span className="text-primary text-sm font-medium">Voice Note</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => skip(-5)}
            disabled={disabled}
            title="Back 5 seconds"
            aria-label="Back 5 seconds"
            className="btn-ghost relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg disabled:opacity-40"
          >
            <RotateCcw size={15} />
            <span className="pointer-events-none absolute text-[8px] font-bold">5</span>
          </button>
          <button
            type="button"
            onClick={() => skip(5)}
            disabled={disabled}
            title="Forward 5 seconds"
            aria-label="Forward 5 seconds"
            className="btn-ghost relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg disabled:opacity-40"
          >
            <RotateCw size={15} />
            <span className="pointer-events-none absolute text-[8px] font-bold">5</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={togglePlay}
          disabled={disabled}
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
          className="bg-accent-solid flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-colors duration-150 hover:brightness-110 disabled:opacity-40"
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
        </button>

        <Waveform peaks={peaks ?? PLACEHOLDER_PEAKS} progress={progress} disabled={disabled} onSeek={seekToFraction} />

        <span className="text-secondary w-9 shrink-0 text-right text-xs tabular-nums">{formatDuration(displayMs)}</span>

        <div ref={menuHostRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title="More options"
            aria-label="More options"
            className="btn-ghost flex h-7 w-7 items-center justify-center rounded-lg"
          >
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <div className="glass-panel border-subtle shadow-app-lg absolute right-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-lg border p-1">
              <button
                type="button"
                onClick={() => {
                  onAppend();
                  onClose();
                }}
                className="hover:bg-surface-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              >
                <Mic size={14} /> Record more
              </button>
              <button
                type="button"
                onClick={() => {
                  onRemove();
                  onClose();
                }}
                className="hover:bg-danger-soft text-danger flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-danger px-1 pt-2 text-xs">Couldn't load recording</div>}
      {src && (
        <audio
          ref={audioRef}
          src={src}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setCurrentTime(0);
            if (audioRef.current) audioRef.current.currentTime = 0;
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d)) setDuration(d);
          }}
          className="hidden"
        />
      )}
    </ToolbarPopover>
  );
}
