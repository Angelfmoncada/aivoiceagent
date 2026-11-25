/**
 * PCM helpers for the Gemini Live audio formats:
 * input PCM16 LE mono 16 kHz, output PCM16 LE mono 24 kHz.
 */

/** Float32 [-1, 1] -> PCM16 little-endian bytes. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** PCM16 little-endian bytes -> Float32 [-1, 1). */
export function pcm16ToFloat(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(buffer);
  const out = new Float32Array(Math.floor(buffer.byteLength / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/**
 * Streaming resampler: box low-pass (anti-aliasing when downsampling) followed
 * by linear interpolation. Keeps state between chunks so there are no clicks
 * or gaps at chunk boundaries.
 */
export class StreamingResampler {
  private readonly ratio: number;
  private readonly boxSize: number;
  private history: Float32Array;
  /** Next output position, relative to the start of the next chunk (-1 = previous last sample). */
  private position = 0;
  private previous = 0;

  constructor(inputRate: number, outputRate: number) {
    if (inputRate <= 0 || outputRate <= 0) throw new Error("Sample rates must be positive");
    this.ratio = inputRate / outputRate;
    this.boxSize = this.ratio >= 2 ? Math.floor(this.ratio) : 1;
    this.history = new Float32Array(this.boxSize - 1);
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    const filtered = this.lowPass(input);
    const out: number[] = [];
    const last = filtered.length - 1;
    let t = this.position;
    while (t <= last) {
      const i0 = Math.floor(t);
      const frac = t - i0;
      const s0 = i0 < 0 ? this.previous : (filtered[i0] ?? 0);
      const s1 = i0 + 1 <= last ? (filtered[i0 + 1] ?? s0) : s0;
      out.push(s0 + (s1 - s0) * frac);
      t += this.ratio;
    }
    this.position = t - filtered.length;
    this.previous = filtered[last] ?? 0;
    return Float32Array.from(out);
  }

  private lowPass(input: Float32Array): Float32Array {
    if (this.boxSize === 1) return input;
    const extended = new Float32Array(this.history.length + input.length);
    extended.set(this.history);
    extended.set(input, this.history.length);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      let sum = 0;
      for (let k = 0; k < this.boxSize; k += 1) sum += extended[i + k] ?? 0;
      out[i] = sum / this.boxSize;
    }
    this.history = extended.slice(extended.length - (this.boxSize - 1));
    return out;
  }
}

/** Root-mean-square level of a block, 0..1. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
}
