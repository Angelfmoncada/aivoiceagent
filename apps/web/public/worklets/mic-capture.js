/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * Microphone capture worklet: batches mono Float32 frames into ~chunkMs blocks
 * at the context's native sample rate and transfers them to the main thread,
 * which resamples to 16 kHz PCM16 for Gemini.
 */
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkMs = (options && options.processorOptions && options.processorOptions.chunkMs) || 40;
    this.size = Math.max(128, Math.round((sampleRate * chunkMs) / 1000));
    this.buffer = new Float32Array(this.size);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, this.size - this.length);
        this.buffer.set(channel.subarray(offset, offset + count), this.length);
        this.length += count;
        offset += count;
        if (this.length === this.size) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.size);
          this.length = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
