/** Pure audio-recording/encoding logic for voice notes - no Milkdown/ProseMirror imports, so it
 * can be exercised standalone. See voiceNoteSchemaExtensions.ts for where the bytes this module
 * produces end up stored (as a note-relative asset path in a node's `voiceSrc` attr) and
 * voiceNoteGrips.ts for the margin UI that drives recording/playback.
 *
 * Every stored voice-note asset is normalized to 16-bit PCM WAV, mono, at VOICE_NOTE_SAMPLE_RATE
 * - never the raw container `MediaRecorder` produced. This is deliberate, not incidental: WKWebView
 * (macOS/iOS) can't record `audio/webm` at all, and even a container a given WebView *can* record
 * isn't guaranteed decodable if the notes folder is later opened on a different OS/WebView (e.g.
 * synced via iCloud/Dropbox) - a browser can always decode what it just encoded itself, so
 * decoding immediately on stop and re-encoding as plain PCM sidesteps cross-platform format
 * support entirely. It also makes "append more onto an existing voice note" simple: decode both
 * clips to PCM, concatenate, re-encode - see appendWav/concatAudioBuffers - rather than the
 * alternative of live-mixing old playback with new mic input through a second MediaRecorder pass
 * (real-time bound, fragile to get in sync, and still produces another arbitrary container). */

/** Candidate `MediaRecorder` mime types to try, most-preferred first. The exact codec barely
 * matters - every recording is immediately decoded and re-encoded as WAV before it's ever
 * written to disk (see stop() below) - this only needs to produce *something* the current
 * WebView's own MediaRecorder can both record and decode. Trying each in turn and falling back
 * to the browser's own default (`undefined`) covers WKWebView, WebView2, and WebKitGTK without
 * needing to special-case any of them. */
const CANDIDATE_MIME_TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Speech-adequate, small (~44 KB/s mono) - every asset this module writes is resampled to this
 * rate so two clips recorded in different sessions (a fresh recording and a later append) always
 * concatenate without needing to resample the *first* one. */
export const VOICE_NOTE_SAMPLE_RATE = 22050;

let sharedAudioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  // Created lazily on first use - recording only ever starts from a click handler (see
  // VoiceRecording.start), so this is never constructed outside a user gesture, which some
  // WebViews require.
  if (!sharedAudioContext) sharedAudioContext = new AudioContext();
  return sharedAudioContext;
}

async function decodeToAudioBuffer(bytes: Uint8Array): Promise<AudioBuffer> {
  // decodeAudioData detaches/consumes the buffer it's given - slice() so callers keep their own
  // usable copy of `bytes` afterward.
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return getAudioContext().decodeAudioData(arrayBuffer);
}

/** Decodes a stored `.wav` asset's bytes back into an AudioBuffer - decoding is lossless/trivial
 * since it's already PCM, exposed so append (below) can read the existing clip before
 * concatenating, and so playback code can share the same decode path if it ever needs raw
 * samples rather than just an `<audio src>`. */
export async function decodeWav(bytes: Uint8Array): Promise<AudioBuffer> {
  return decodeToAudioBuffer(bytes);
}

/** Resamples/rechannels `buffer` to `sampleRate`/`numberOfChannels` via an OfflineAudioContext -
 * a no-op fast path when it already matches. Needed before concatenating two clips recorded in
 * different sessions: browsers don't guarantee the same device sample rate twice, and an append
 * recorded through a different input device than the original could differ in channel count. */
async function matchFormat(buffer: AudioBuffer, sampleRate: number, numberOfChannels: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === numberOfChannels) return buffer;
  const length = Math.max(1, Math.ceil(buffer.duration * sampleRate));
  const offline = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

/** Concatenates `a` followed by `b` into one new AudioBuffer at `a`'s own sample rate/channel
 * count (resampling `b` to match first if needed - see matchFormat). This is the "append
 * produces one continuous clip" behavior, not a segment playlist and not an in-place overwrite. */
export async function concatAudioBuffers(a: AudioBuffer, b: AudioBuffer): Promise<AudioBuffer> {
  const matchedB = await matchFormat(b, a.sampleRate, a.numberOfChannels);
  const out = getAudioContext().createBuffer(a.numberOfChannels, a.length + matchedB.length, a.sampleRate);
  for (let channel = 0; channel < a.numberOfChannels; channel++) {
    const data = out.getChannelData(channel);
    data.set(a.getChannelData(channel), 0);
    data.set(matchedB.getChannelData(channel), a.length);
  }
  return out;
}

/** Hand-rolled 16-bit PCM WAV encoder (RIFF/`fmt `/`data`) - see this file's module comment for
 * why every stored asset is plain PCM rather than whatever `MediaRecorder` produced. */
export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  function writeString(offset: number, value: string) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let channel = 0; channel < numChannels; channel++) channels.push(buffer.getChannelData(channel));

  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      offset += 2;
    }
  }

  return new Uint8Array(out);
}

/** Appends `newWav` onto the end of `existingWav`, producing one continuous re-encoded clip.
 * Both inputs and the return value are already-normalized WAV bytes. */
export async function appendWav(
  existingWav: Uint8Array,
  newWav: Uint8Array,
): Promise<{ wav: Uint8Array; durationMs: number }> {
  const [existing, incoming] = await Promise.all([decodeWav(existingWav), decodeWav(newWav)]);
  const combined = await concatAudioBuffers(existing, incoming);
  return { wav: encodeWav(combined), durationMs: Math.round(combined.duration * 1000) };
}

/** Downsamples `buffer`'s first channel into `bucketCount` peak-amplitude values (each the
 * loudest sample in its slice, normalized to 0..1 against the clip's own loudest bucket) for
 * VoiceNotePopover.tsx's waveform bars - a cheap approximation, not a spectral analysis, since
 * it only needs to *look* like a waveform. */
export function computePeaks(buffer: AudioBuffer, bucketCount: number): number[] {
  const data = buffer.getChannelData(0);
  const bucketSize = Math.max(1, Math.floor(data.length / bucketCount));
  const peaks: number[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const start = i * bucketSize;
    const end = i === bucketCount - 1 ? data.length : start + bucketSize;
    let max = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(data[j]);
      if (abs > max) max = abs;
    }
    peaks.push(max);
  }
  const overallMax = Math.max(...peaks, 0.01);
  return peaks.map((peak) => Math.max(0.08, peak / overallMax));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** One in-progress microphone recording. `getUserMedia`+`MediaRecorder.start()` fire immediately
 * from `start()` - any "get ready" delay before that happens is the caller's business (see
 * VoiceRecorderPopover.tsx's countdown, which simply doesn't call this until it elapses), so the
 * microphone is never held open while nothing is being captured. */
export class VoiceRecording {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  /** `Date.now()` of the current pause, or 0 while running - see elapsedMs. */
  private pausedAt = 0;
  /** Total time spent paused across all previous pause/resume cycles. */
  private pausedTotalMs = 0;
  private stopped: Promise<Blob> | null = null;
  private resolveStopped: ((blob: Blob) => void) | null = null;
  private rejectStopped: ((err: unknown) => void) | null = null;

  private constructor() {}

  /** Rejects with whatever `getUserMedia` throws - `NotAllowedError` (permission denied),
   * `NotFoundError` (no microphone), `NotReadableError` (device busy elsewhere) - for the
   * caller to surface inline (see voiceNoteGrips.ts's recording widget). Also rejects (with a
   * plain Error, not a DOMException) if `navigator.mediaDevices` itself is missing - which
   * happens when the page isn't in a secure context. This matters specifically for `tauri dev`:
   * the dev server is served over plain `http://localhost:<port>` (see tauri.conf.json's
   * `devUrl`), and depending on the WebView/OS, that doesn't always get the same
   * "localhost is secure" exception a full browser grants - `mediaDevices` can end up simply
   * undefined there even though a production build (served from Tauri's own `tauri://`/
   * `https://tauri.localhost` origin, always secure) works fine. */
  static async start(): Promise<VoiceRecording> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        `navigator.mediaDevices.getUserMedia is unavailable (isSecureContext=${window.isSecureContext}) - ` +
          "the page isn't in a secure context, which the WebView can withhold even on http://localhost in dev mode",
      );
    }
    const recording = new VoiceRecording();
    recording.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const mimeType = pickRecorderMimeType();
    recording.recorder = mimeType ? new MediaRecorder(recording.stream, { mimeType }) : new MediaRecorder(recording.stream);
    recording.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recording.chunks.push(event.data);
    };
    recording.stopped = new Promise((resolve, reject) => {
      recording.resolveStopped = resolve;
      recording.rejectStopped = reject;
    });
    recording.recorder.onstop = () => {
      recording.resolveStopped?.(new Blob(recording.chunks, { type: recording.recorder?.mimeType }));
    };
    recording.recorder.onerror = (event) => {
      recording.rejectStopped?.(event);
    };
    recording.recorder.start();
    recording.startedAt = Date.now();
    return recording;
  }

  /** Wall-clock elapsed time for a *live* in-progress timer readout, excluding time spent paused
   * (a paused MediaRecorder captures nothing, so counting it would make the timer run ahead of
   * the audio it claims to describe) - the final persisted duration (see stop()) instead comes
   * from the decoded clip's own length, which can differ slightly from wall-clock time due to
   * encoding lag. */
  elapsedMs(): number {
    const currentPause = this.pausedAt > 0 ? Date.now() - this.pausedAt : 0;
    return Math.max(0, Date.now() - this.startedAt - this.pausedTotalMs - currentPause);
  }

  isPaused(): boolean {
    return this.recorder?.state === "paused";
  }

  /** Suspends capture without ending the recording - the mic stays open and `resume()` continues
   * into the *same* clip (MediaRecorder's own pause/resume, so the paused span simply isn't
   * present in the output rather than being stitched out afterwards). No-op if not recording. */
  pause() {
    if (this.recorder?.state !== "recording") return;
    this.recorder.pause();
    this.pausedAt = Date.now();
  }

  resume() {
    if (this.recorder?.state !== "paused") return;
    this.recorder.resume();
    if (this.pausedAt > 0) this.pausedTotalMs += Date.now() - this.pausedAt;
    this.pausedAt = 0;
  }

  private releaseStream() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  /** Stops recording and returns normalized WAV bytes + duration, ready for
   * `writeAttachment`/node attrs. */
  async stop(): Promise<{ wav: Uint8Array; durationMs: number }> {
    if (!this.recorder || !this.stopped) throw new Error("Recording was never started");
    // Calling stop() on a *paused* recorder is fine (it flushes and ends the same as from
    // "recording"), so stopping straight out of a pause needs no resume-first dance.
    this.recorder.stop();
    const blob = await this.stopped;
    this.releaseStream();
    // Guard the decode below: a recording stopped before the encoder emitted anything yields a
    // zero-byte blob, which decodeAudioData rejects with an opaque EncodingError.
    if (blob.size === 0) throw new Error("Nothing was recorded");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const decoded = await decodeToAudioBuffer(bytes);
    return { wav: encodeWav(decoded), durationMs: Math.round(decoded.duration * 1000) };
  }

  /** Discards the recording in progress: mic released, no file ever written. Used when the user
   * cancels, or when the line being recorded onto is deleted out from under the recording (see
   * voiceNoteGrips.ts). */
  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.releaseStream();
  }
}
