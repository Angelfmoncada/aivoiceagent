import { pcm16ToFloat } from "./pcm";

/** Minimal Web Audio surface the player needs (lets tests use a fake context). */
export interface PlaybackBuffer {
  readonly duration: number;
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void;
}

export interface PlaybackSource {
  buffer: PlaybackBuffer | null;
  onended: ((event: Event) => void) | null;
  connect(destination: never): unknown;
  disconnect(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface PlaybackContext {
  readonly currentTime: number;
  createBuffer(channels: number, length: number, sampleRate: number): PlaybackBuffer;
  createBufferSource(): PlaybackSource;
}

export interface PcmPlayerOptions {
  readonly sampleRate: number;
  /** Small jitter buffer before the first chunk of a burst. */
  readonly leadSeconds?: number;
  /** Bound on scheduled-but-unplayed audio; extra chunks are dropped. */
  readonly maxBufferedSeconds?: number;
  readonly onPlayingChange?: (playing: boolean) => void;
}

/**
 * Gapless PCM16 playback: each chunk is scheduled exactly where the previous
 * one ends. `clear()` stops everything immediately (barge-in).
 */
export class PcmPlayer {
  private sources = new Set<PlaybackSource>();
  private nextStartTime = 0;
  private droppedChunks = 0;

  constructor(
    private readonly context: PlaybackContext,
    private readonly destination: unknown,
    private readonly options: PcmPlayerOptions,
  ) {}

  get playing(): boolean {
    return this.sources.size > 0;
  }

  get dropped(): number {
    return this.droppedChunks;
  }

  get bufferedSeconds(): number {
    return Math.max(0, this.nextStartTime - this.context.currentTime);
  }

  enqueue(pcm16: ArrayBuffer): boolean {
    const samples = pcm16ToFloat(pcm16);
    if (samples.length === 0) return false;
    const now = this.context.currentTime;
    // New burst (idle or underrun): start after a small jitter buffer.
    if (this.sources.size === 0 || this.nextStartTime < now) {
      this.nextStartTime = now + (this.options.leadSeconds ?? 0.05);
    }
    if (this.nextStartTime - now > (this.options.maxBufferedSeconds ?? 120)) {
      this.droppedChunks += 1;
      return false;
    }

    const buffer = this.context.createBuffer(1, samples.length, this.options.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination as never);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (this.sources.size === 0) this.options.onPlayingChange?.(false);
    };

    const wasIdle = this.sources.size === 0;
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
    this.sources.add(source);
    if (wasIdle) this.options.onPlayingChange?.(true);
    return true;
  }

  /** Stops current audio and drops everything queued. */
  clear(): void {
    const wasPlaying = this.sources.size > 0;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources = new Set();
    this.nextStartTime = 0;
    if (wasPlaying) this.options.onPlayingChange?.(false);
  }
}
