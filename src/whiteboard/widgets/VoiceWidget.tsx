import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { formatDuration } from "../../milkdown/voiceRecording";
import { useAssetUrl } from "../useAssetUrl";
import type { VoiceElement } from "../boardTypes";

/** A free-floating voice note on the board: waveform, play/pause, scrubbing.
 *
 * The waveform is drawn from the `peaks` array captured at record time (see `computePeaks` in
 * milkdown/voiceRecording.ts), never by decoding the audio on mount - decoding a clip just to draw
 * a static picture of it would cost real time per element, on a canvas where many voice notes can
 * be visible at once. Playback still needs the real bytes, so those load lazily through
 * `useAssetUrl` alongside every other board asset. */
export function VoiceWidget({
  element,
  editable,
  onChange,
}: {
  element: VoiceElement;
  editable: boolean;
  onChange: (patch: Partial<VoiceElement>) => void;
}) {
  const url = useAssetUrl(element.src);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);

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

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play().then(() => setPlaying(true));
    }
  }

  function seek(e: React.PointerEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    if (!audio || !element.durationMs) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = (ratio * element.durationMs) / 1000;
    setPositionMs(ratio * element.durationMs);
  }

  const progress = element.durationMs > 0 ? positionMs / element.durationMs : 0;

  return (
    <div className="board-voice-widget">
      <button
        type="button"
        className="board-voice-play"
        onClick={toggle}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={!url}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div className="board-voice-body">
        <input
          className="board-voice-title"
          value={element.title ?? ""}
          placeholder="Voice note"
          readOnly={!editable}
          onChange={(e) => onChange({ title: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <div className="board-voice-wave" onPointerDown={seek}>
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
      </div>
      <span className="board-voice-time">
        {formatDuration(playing || positionMs > 0 ? positionMs : element.durationMs)}
      </span>
      {url && <audio ref={audioRef} src={url} preload="metadata" />}
    </div>
  );
}
