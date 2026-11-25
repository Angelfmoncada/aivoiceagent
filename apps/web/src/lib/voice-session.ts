import {
  AUDIO_INPUT,
  AUDIO_OUTPUT,
  parseServerMessage,
  type AgentId,
  type LanguageCode,
  type ServerMessage,
} from "@voice-studio/shared";
import { PcmPlayer } from "./audio/player";
import { floatToPcm16, rms, StreamingResampler } from "./audio/pcm";
import { voiceSocketUrl } from "./config";
import { describeStartError, type UiError } from "./errors";
import { applyTranscript, type TranscriptAction, type TranscriptEntry } from "./transcript";

export type SessionStatus = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "error";
export type AgentActivity = "listening" | "thinking" | "speaking";

export interface VoiceSessionSnapshot {
  readonly status: SessionStatus;
  readonly activity: AgentActivity;
  readonly muted: boolean;
  readonly transcript: readonly TranscriptEntry[];
  readonly error: UiError | null;
  /** Measured by the server: session.start -> Gemini setupComplete. */
  readonly setupMs: number | null;
  readonly startedAt: number | null;
  readonly model: string | null;
}

export interface StartOptions {
  readonly agentId: AgentId;
  readonly language: LanguageCode;
  readonly instructions?: string;
}

export interface AudioLevel {
  readonly source: "user" | "agent" | null;
  readonly level: number;
}

interface Resources {
  ctx: AudioContext | null;
  stream: MediaStream | null;
  nodes: AudioNode[];
  micAnalyser: AnalyserNode | null;
  playAnalyser: AnalyserNode | null;
  worklet: AudioWorkletNode | null;
  player: PcmPlayer | null;
  ws: WebSocket | null;
  ready: boolean;
  closed: boolean;
  connectTimer: ReturnType<typeof setTimeout> | null;
  thinkingTimer: ReturnType<typeof setTimeout> | null;
}

const CONNECT_TIMEOUT_MS = 20_000;
const THINKING_DELAY_MS = 800;
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;

const INITIAL: VoiceSessionSnapshot = {
  status: "idle",
  activity: "listening",
  muted: false,
  transcript: [],
  error: null,
  setupMs: null,
  startedAt: null,
  model: null,
};

/**
 * Owns one browser voice session: microphone -> AudioWorklet -> 16 kHz PCM16
 * -> WebSocket -> server, and server PCM16 24 kHz -> gapless playback.
 * Exposes an immutable snapshot for React via subscribe/getSnapshot.
 */
export class VoiceSessionController {
  private snapshot: VoiceSessionSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private res: Resources | null = null;
  private entryCounter = 0;
  private levelBuffer: Float32Array<ArrayBuffer> = new Float32Array(1024);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VoiceSessionSnapshot => this.snapshot;

  get isActive(): boolean {
    return this.res !== null;
  }

  /** Must be called from a user gesture (unlocks audio playback). */
  async start(options: StartOptions): Promise<void> {
    if (this.res) return; // prevents duplicate sessions from repeated clicks
    const unsupported = detectUnsupported();
    if (unsupported) {
      this.set({ ...INITIAL, status: "error", error: unsupported });
      return;
    }
    const res: Resources = {
      ctx: null, stream: null, nodes: [], micAnalyser: null, playAnalyser: null, worklet: null,
      player: null, ws: null, ready: false, closed: false, connectTimer: null, thinkingTimer: null,
    };
    this.res = res;
    this.set({ ...INITIAL, status: "connecting" });

    try {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      res.ctx = ctx;
      const resumed = ctx.resume(); // inside the click handler, before any await
      res.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      await resumed;
      await ctx.audioWorklet.addModule("/worklets/mic-capture.js");
      if (res.closed) return;
      this.buildAudioGraph(res, ctx, res.stream);
      this.openSocket(res, options);
    } catch (error) {
      this.fail(res, describeStartError(error));
    }
  }

  /** Ends the conversation; the transcript stays available for review. */
  end(): void {
    const res = this.res;
    if (!res) return;
    if (res.ws?.readyState === WebSocket.OPEN) res.ws.send(JSON.stringify({ type: "session.end" }));
    this.cleanup(res);
    this.set({ status: "ended", activity: "listening" });
  }

  setMuted(muted: boolean): void {
    const res = this.res;
    res?.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    if (muted && res?.ready && res.ws?.readyState === WebSocket.OPEN) {
      res.ws.send(JSON.stringify({ type: "audio.end" }));
    }
    this.set({ muted });
  }

  clearTranscript(): void {
    this.set({ transcript: [] });
  }

  dismissError(): void {
    this.set({ error: null, status: this.snapshot.status === "error" ? "idle" : this.snapshot.status });
  }

  /** Real signal level for the visualizer (agent playback wins while it plays). */
  getLevel(): AudioLevel {
    const res = this.res;
    if (!res?.ready) return { source: null, level: 0 };
    const agentPlaying = res.player?.playing ?? false;
    const analyser = agentPlaying ? res.playAnalyser : this.snapshot.muted ? null : res.micAnalyser;
    if (!analyser) return { source: null, level: 0 };
    if (this.levelBuffer.length !== analyser.fftSize) this.levelBuffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.levelBuffer);
    return { source: agentPlaying ? "agent" : "user", level: Math.min(1, rms(this.levelBuffer) * 5) };
  }

  // ---------------------------------------------------------------------------

  private buildAudioGraph(res: Resources, ctx: AudioContext, stream: MediaStream): void {
    const source = ctx.createMediaStreamSource(stream);
    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 1024;
    const worklet = new AudioWorkletNode(ctx, "mic-capture", { processorOptions: { chunkMs: 40 } });
    const sink = ctx.createGain();
    sink.gain.value = 0; // keeps the worklet pulled by the graph without echoing the mic
    source.connect(micAnalyser);
    source.connect(worklet);
    worklet.connect(sink).connect(ctx.destination);

    const output = ctx.createGain();
    const playAnalyser = ctx.createAnalyser();
    playAnalyser.fftSize = 1024;
    output.connect(playAnalyser).connect(ctx.destination);

    const resampler = new StreamingResampler(ctx.sampleRate, AUDIO_INPUT.sampleRate);
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!res.ready || this.snapshot.muted || res.ws?.readyState !== WebSocket.OPEN) return;
      if (res.ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return;
      res.ws.send(floatToPcm16(resampler.process(event.data)));
    };

    res.player = new PcmPlayer(ctx, output, {
      sampleRate: AUDIO_OUTPUT.sampleRate,
      onPlayingChange: (playing) => {
        if (this.res !== res) return;
        if (playing) this.clearThinking(res);
        this.set({ activity: playing ? "speaking" : "listening" });
      },
    });
    res.worklet = worklet;
    res.micAnalyser = micAnalyser;
    res.playAnalyser = playAnalyser;
    res.nodes = [source, micAnalyser, worklet, sink, output, playAnalyser];
  }

  private openSocket(res: Resources, options: StartOptions): void {
    const ws = new WebSocket(voiceSocketUrl());
    ws.binaryType = "arraybuffer";
    res.ws = ws;
    res.connectTimer = setTimeout(() => {
      this.fail(res, { code: "timeout", message: "The voice server didn't respond in time. Check that it's running, then try again." });
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "session.start",
          agentId: options.agentId,
          language: options.language,
          ...(options.instructions?.trim() ? { instructions: options.instructions.trim() } : {}),
        }),
      );
    };
    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.res !== res) return;
      if (typeof event.data === "string") this.onServerMessage(res, event.data);
      else if (res.ready) res.player?.enqueue(event.data);
    };
    ws.onclose = (event) => {
      if (this.res !== res) return;
      const wasLive = res.ready;
      this.fail(res, {
        code: "connection_lost",
        message: wasLive
          ? "The connection to the voice server was lost. This conversation can't be resumed; start a new one."
          : `Couldn't connect to the voice server (code ${event.code}). Make sure it's running on ${voiceSocketUrl()}.`,
      });
    };
  }

  private onServerMessage(res: Resources, raw: string): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) return; // unknown/invalid events are ignored by design
    this.handle(res, parsed.value);
  }

  private handle(res: Resources, message: ServerMessage): void {
    switch (message.type) {
      case "session.ready":
        if (res.connectTimer) clearTimeout(res.connectTimer);
        res.ready = true;
        this.set({ status: "live", activity: "listening", setupMs: message.setupMs, startedAt: Date.now(), model: message.model });
        return;
      case "transcript":
        this.transcript({ type: "delta", id: `t${++this.entryCounter}`, role: message.role, text: message.text, final: message.final, at: Date.now() });
        if (message.role === "user" && !res.player?.playing) this.userSpeaking(res);
        return;
      case "vad":
        if (message.activity === "start") this.userSpeaking(res);
        return;
      case "interrupted":
        res.player?.clear();
        this.transcript({ type: "finalize", interrupted: true });
        this.set({ activity: "listening" });
        return;
      case "turn.complete":
        this.clearThinking(res);
        this.transcript({ type: "finalize", interrupted: false });
        if (!res.player?.playing) this.set({ activity: "listening" });
        return;
      case "session.reconnecting":
        res.ready = false;
        this.set({ status: "reconnecting" });
        return;
      case "session.resumed":
        res.ready = true;
        this.set({ status: "live" });
        return;
      case "error":
        this.set({ error: { code: message.code, message: message.message } });
        return;
      case "session.ended":
        this.cleanup(res);
        this.set({ status: this.snapshot.error ? "error" : "ended", activity: "listening" });
        return;
      case "transcript.interim":
        return;
    }
  }

  /** User audio is being transcribed; show "thinking" once it pauses. */
  private userSpeaking(res: Resources): void {
    this.set({ activity: "listening" });
    this.clearThinking(res);
    res.thinkingTimer = setTimeout(() => {
      if (this.res === res && !res.player?.playing) this.set({ activity: "thinking" });
    }, THINKING_DELAY_MS);
  }

  private clearThinking(res: Resources): void {
    if (res.thinkingTimer) clearTimeout(res.thinkingTimer);
    res.thinkingTimer = null;
  }

  private transcript(action: TranscriptAction): void {
    this.set({ transcript: applyTranscript(this.snapshot.transcript, action) });
  }

  private fail(res: Resources, error: UiError): void {
    if (this.res !== res) return;
    this.cleanup(res);
    this.transcript({ type: "finalize", interrupted: false });
    this.set({ status: "error", activity: "listening", error: this.snapshot.error ?? error });
  }

  /** Releases mic tracks, audio nodes, the audio context, the socket and timers. Idempotent. */
  private cleanup(res: Resources): void {
    if (res.closed) return;
    res.closed = true;
    res.ready = false;
    if (res.connectTimer) clearTimeout(res.connectTimer);
    this.clearThinking(res);
    if (res.worklet) res.worklet.port.onmessage = null;
    res.player?.clear();
    res.nodes.forEach((node) => node.disconnect());
    res.stream?.getTracks().forEach((track) => track.stop());
    if (res.ws) {
      res.ws.onopen = res.ws.onmessage = res.ws.onclose = null;
      if (res.ws.readyState === WebSocket.OPEN || res.ws.readyState === WebSocket.CONNECTING) res.ws.close(1000);
    }
    void res.ctx?.close().catch(() => undefined); // already-closed contexts reject; nothing to recover
    if (this.res === res) this.res = null;
  }

  private set(patch: Partial<VoiceSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

function detectUnsupported(): UiError | null {
  if (typeof window === "undefined") return { code: "unsupported", message: "Voice is only available in the browser." };
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return { code: "unsupported", message: "Microphone access needs a secure context. Open the app on https or http://localhost." };
  }
  if (typeof AudioWorkletNode === "undefined" || typeof WebSocket === "undefined") {
    return { code: "unsupported", message: "This browser lacks AudioWorklet or WebSocket support. Use a current Chrome, Edge, Firefox or Safari." };
  }
  return null;
}
