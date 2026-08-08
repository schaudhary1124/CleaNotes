import { useEffect, useRef, useState } from "react";
import { Mic, MoreVertical, Pause, Play, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { formatDuration } from "../../milkdown/voiceRecording";
import { useAssetUrl, type BoardAssets } from "../useAssetUrl";
import { VOICE_SPEEDS, type VoiceElement } from "../boardTypes";

/** A free-floating voice note on the board: waveform, transport, scrubbing.
 *
 * Offers what the in-note player does (components/VoiceNotePopover.tsx, opened from a line's voice
 * pill) - play/pause, a draggable waveform, ±5s skip, "record more" onto the same clip, delete -
 * plus the two things only a canvas element can carry: a title, and a playback rate that is part of
 * the document rather than a transient control, so a clip recorded at speed keeps playing back that
 * way for everyone who opens the board.
 *
 * The waveform is drawn from the `peaks` array captured at record time (see `computePeaks` in
 * milkdown/voiceRecording.ts), never by decoding the audio on mount - decoding a clip just to draw
 * a static picture of it would cost real time per element, on a canvas where many voice notes can
 * be visible at once. Playback still needs the real bytes, so those load lazily through
 * `useAssetUrl` alongside every other board asset. */

/** Seconds the skip buttons jump, matching VoiceNotePopover's own ±5. */
const SKIP_SECONDS = 5;

export function VoiceWidget({
  element,
  editable,
  onChange,
  onAppend,
  onDelete,
  assets,
}: {
  element: VoiceElement;
  editable: boolean;
  onChange: (patch: Partial<VoiceElement>) => void;
  /** Opens the recorder to append onto this clip - owned by the workspace, since recording needs
   * the board's asset store and its modal surface. */
  onAppend: () => void;
  onDelete: () => void;
  assets: BoardAssets;
}) {
  const url = useAssetUrl(element.src, assets);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const speed = element.speed ?? 1;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setPositionMs(audio.currentTime * 1000);
    const onEnd = () => {
      setPlaying(false);
      setPositionMs(0);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnd);
    };
  }, [url]);

  // Applied imperatively rather than as a JSX attribute: `playbackRate` is a property of the media
  // element, not a reflected attribute, so React would never write it back after the element is
  // created. Re-run on `url` too, since a re-recorded clip mounts a fresh <audio>.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, url]);

  useEffect(() => {
    if (!editable) setMenuOpen(false);
  }, [editable]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (menuRef.current?.contains(target) || target?.closest("[data-board-menu-toggle]")) return;
      setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  // A clip that has been re-recorded (see onAppend) is longer than wherever playback had got to,
  // and one that was replaced outright may be shorter - either way the old position is meaningless.
  useEffect(() => {
    setPositionMs(0);
    setPlaying(false);
  }, [element.src]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play().then(
        () => setPlaying(true),
        () => {
          // Autoplay policy or a missing asset - either way there is nothing to play and nothing
          // useful to say about it on a canvas.
        },
      );
    }
  }

  function seekTo(fraction: number) {
    const audio = audioRef.current;
    if (!audio || !element.durationMs) return;
    const clamped = Math.min(1, Math.max(0, fraction));
    audio.currentTime = (clamped * element.durationMs) / 1000;
    setPositionMs(clamped * element.durationMs);
  }

  function skip(deltaSeconds: number) {
    const audio = audioRef.current;
    if (!audio || !element.durationMs) return;
    const next = Math.min(element.durationMs / 1000, Math.max(0, audio.currentTime + deltaSeconds));
    audio.currentTime = next;
    setPositionMs(next * 1000);
  }

  function fractionFromEvent(e: React.PointerEvent<HTMLDivElement>): number {
    const rect = waveRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return (e.clientX - rect.left) / rect.width;
  }

  /** Press-and-drag scrubbing, not just click-to-seek. Pointer capture is what makes the drag
   * survive leaving the waveform - without it the gesture would end the moment the pointer crossed
   * into the element beside it, which on a canvas is most of the time. */
  function handleWavePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!editable) return;
    e.stopPropagation();
    waveRef.current?.setPointerCapture(e.pointerId);
    seekTo(fractionFromEvent(e));
  }

  function handleWavePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!editable || e.buttons !== 1) return;
    if (!waveRef.current?.hasPointerCapture(e.pointerId)) return;
    e.stopPropagation();
    seekTo(fractionFromEvent(e));
  }

  const progress = element.durationMs > 0 ? positionMs / element.durationMs : 0;

  return (
    <>
      <div className="board-voice-widget">
        <div className="board-voice-head">
          <input
            className="board-voice-title"
            value={element.title ?? ""}
            placeholder="Voice note"
            readOnly={!editable}
            onChange={(e) => onChange({ title: e.target.value || undefined })}
            onKeyDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className={`board-widget-chip ${speed !== 1 ? "is-on" : ""}`}
            disabled={!editable}
            title="Playback speed"
            onClick={() => {
              // An unrecognized rate (a hand-edited board) lands on -1 and so cycles back to 1x.
              const next = VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(speed) + 1) % VOICE_SPEEDS.length];
              // 1x is the default and is stored as the absence of a rate (see VoiceElement.speed).
              onChange({ speed: next === 1 ? undefined : next });
            }}
          >
            {speed}×
          </button>
          <button
            type="button"
            className="board-widget-icon"
            data-board-menu-toggle
            disabled={!editable}
            title="More options"
            aria-label="More options"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreVertical size={13} />
          </button>
        </div>

        <div className="board-voice-transport">
          <button
            type="button"
            className="board-voice-play"
            onClick={toggle}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!url}
            title={playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            type="button"
            className="board-widget-icon board-voice-skip"
            onClick={() => skip(-SKIP_SECONDS)}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!url}
            title={`Back ${SKIP_SECONDS} seconds`}
            aria-label={`Back ${SKIP_SECONDS} seconds`}
          >
            <RotateCcw size={13} />
            <span>{SKIP_SECONDS}</span>
          </button>
          <button
            type="button"
            className="board-widget-icon board-voice-skip"
            onClick={() => skip(SKIP_SECONDS)}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!url}
            title={`Forward ${SKIP_SECONDS} seconds`}
            aria-label={`Forward ${SKIP_SECONDS} seconds`}
          >
            <RotateCw size={13} />
            <span>{SKIP_SECONDS}</span>
          </button>

          <div
            ref={waveRef}
            className="board-voice-wave"
            onPointerDown={handleWavePointerDown}
            onPointerMove={handleWavePointerMove}
          >
            {element.peaks.map((peak, i) => (
              <span
                key={i}
                // The played portion is coloured by comparing each bar's position to `progress`
                // rather than by overlaying a second clipped element - one class swap per bar keeps
                // scrubbing to a single re-render with no layout work.
                className={i / element.peaks.length <= progress ? "is-played" : ""}
                style={{ height: `${Math.max(8, peak * 100)}%` }}
              />
            ))}
          </div>

          <span className="board-voice-time">
            {/* Elapsed over total, rather than the single figure that used to flip between the two -
                a scrub has no meaning without knowing what it is a fraction of. */}
            {formatDuration(positionMs)} / {formatDuration(element.durationMs)}
          </span>
        </div>

        {url && <audio ref={audioRef} src={url} preload="metadata" />}
      </div>

      {/* Outside the widget box for the same reason the code block's language picker is - see
          `.board-widget-menu` in index.css. */}
      {menuOpen && editable && (
        <div className="board-widget-menu is-voice" ref={menuRef}>
          <button
            type="button"
            className="board-widget-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onAppend();
            }}
          >
            <Mic size={12} /> Record more
          </button>
          <button
            type="button"
            className="board-widget-menu-item is-danger"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </>
  );
}
