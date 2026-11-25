import { describe, expect, it, vi } from "vitest";
import { floatToPcm16, pcm16ToFloat, StreamingResampler } from "../src/lib/audio/pcm";
import { PcmPlayer, type PlaybackBuffer, type PlaybackContext, type PlaybackSource } from "../src/lib/audio/player";

describe("PCM conversion", () => {
  it("round-trips and clamps samples as little-endian PCM16", () => {
    const bytes = floatToPcm16(new Float32Array([0, 0.5, -0.5, 1.5, -2]));
    const view = new DataView(bytes);
    expect(view.getInt16(6, true)).toBe(0x7fff);
    expect(view.getInt16(8, true)).toBe(-0x8000);
    const back = pcm16ToFloat(bytes);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
  });
});

describe("StreamingResampler", () => {
  it("produces the right sample count across chunks (48 kHz -> 16 kHz)", () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    let total = 0;
    for (let i = 0; i < 25; i += 1) total += resampler.process(new Float32Array(1920)).length; // 1 s
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1);
  });

  it("handles non-integer ratios (44.1 kHz) and preserves a low tone", () => {
    const resampler = new StreamingResampler(44_100, 16_000);
    const input = Float32Array.from({ length: 44_100 }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / 44_100));
    const out = [...resampler.process(input.subarray(0, 20_000)), ...resampler.process(input.subarray(20_000))];
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
    const peak = Math.max(...out.slice(100).map(Math.abs));
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThanOrEqual(1);
  });
});

class FakeSource implements PlaybackSource {
  buffer: PlaybackBuffer | null = null;
  onended: ((event: Event) => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect = vi.fn();
  disconnect = vi.fn();
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
}

function fakeContext(): PlaybackContext & { currentTime: number; sources: FakeSource[] } {
  const sources: FakeSource[] = [];
  return {
    currentTime: 0,
    sources,
    createBuffer: (_channels, length, sampleRate) => ({ duration: length / sampleRate, copyToChannel: () => undefined }),
    createBufferSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  };
}

const chunk = (samples: number) => new ArrayBuffer(samples * 2);

describe("PcmPlayer", () => {
  it("schedules chunks back to back without gaps or overlap", () => {
    const ctx = fakeContext();
    const player = new PcmPlayer(ctx, {}, { sampleRate: 24_000, leadSeconds: 0.05 });
    player.enqueue(chunk(2400));
    player.enqueue(chunk(4800));
    const [a, b] = ctx.sources;
    expect(a!.startedAt).toBeCloseTo(0.05);
    expect(b!.startedAt).toBeCloseTo(0.15);
    expect(player.playing).toBe(true);
  });

  it("clears the queue immediately on interruption and restarts fresh", () => {
    const ctx = fakeContext();
    const onPlayingChange = vi.fn();
    const player = new PcmPlayer(ctx, {}, { sampleRate: 24_000, onPlayingChange });
    player.enqueue(chunk(24_000));
    player.enqueue(chunk(24_000));
    player.clear();
    expect(ctx.sources.every((source) => source.stopped)).toBe(true);
    expect(player.playing).toBe(false);
    expect(player.bufferedSeconds).toBe(0);
    expect(onPlayingChange.mock.calls).toEqual([[true], [false]]);

    ctx.currentTime = 3;
    player.enqueue(chunk(2400));
    expect(ctx.sources.at(-1)!.startedAt).toBeCloseTo(3.05);
  });

  it("bounds buffered audio", () => {
    const ctx = fakeContext();
    const player = new PcmPlayer(ctx, {}, { sampleRate: 24_000, maxBufferedSeconds: 2 });
    expect(player.enqueue(chunk(48_000))).toBe(true);
    expect(player.enqueue(chunk(48_000))).toBe(false);
    expect(player.dropped).toBe(1);
  });
});
