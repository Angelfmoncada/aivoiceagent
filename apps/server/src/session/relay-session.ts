import { VoiceActivityType, type LiveServerContent, type LiveServerMessage } from "@google/genai";
import {
  parseClientMessage,
  validateAudioChunk,
  type EndReason,
  type ErrorCode,
  type ServerMessage,
  type SessionStartMessage,
} from "@voice-studio/shared";
import { classifyUpstreamFailure, errorMessage, truncate } from "../gemini/errors";
import { buildLiveConfig, resolveSettings, type SessionSettings } from "../gemini/live-config";
import type { UpstreamCloseInfo, UpstreamConnector, UpstreamSession } from "../gemini/upstream";

/** Browser-facing side of the relay (a WebSocket in production, a fake in tests). */
export interface RelayTransport {
  sendJson(message: ServerMessage): void;
  sendAudio(pcm16: Buffer): void;
  bufferedBytes(): number;
  isOpen(): boolean;
  close(code: number, reason: string): void;
}

export interface SessionLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RelayLimits {
  /** Client must send session.start within this window. */
  readonly startTimeoutMs: number;
  /** Gemini must answer setup (initial or resumed) within this window. */
  readonly setupTimeoutMs: number;
  readonly maxSessionMs: number;
  /** Drop outgoing audio if the browser socket backs up beyond this. */
  readonly maxClientBufferedBytes: number;
  readonly maxResumeAttempts: number;
}

export type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: Extract<ErrorCode, "rate_limited" | "capacity">; readonly message: string };

export interface RelaySessionOptions {
  readonly id: string;
  readonly model: string;
  readonly transport: RelayTransport;
  readonly connect: UpstreamConnector;
  readonly logger: SessionLogger;
  readonly limits: RelayLimits;
  /** Admission control (rate limit + concurrency), checked on session.start. */
  readonly gate?: (session: RelaySession) => GateResult;
  readonly onEnded?: (session: RelaySession, reason: EndReason) => void;
  readonly now?: () => number;
}

export type RelayPhase = "awaiting_start" | "connecting" | "ready" | "reconnecting" | "ended";

interface RelayStats {
  audioChunksIn: number;
  audioBytesOut: number;
  droppedAudioIn: number;
  droppedAudioOut: number;
  resumes: number;
}

/**
 * One browser conversation <-> one Gemini Live session.
 *
 * Owns every timer and the upstream connection; `end()` is idempotent and
 * releases everything. Callbacks from superseded upstream connections are
 * ignored via a generation counter.
 */
export class RelaySession {
  readonly id: string;
  private phase: RelayPhase = "awaiting_start";
  private settings: SessionSettings | null = null;
  private upstream: UpstreamSession | null = null;
  private setupDone = false;
  private generation = 0;
  private resumeHandle: string | null = null;
  private resumeAttempts = 0;
  private startRequestedAt = 0;
  private readyAt = 0;
  private startTimer: NodeJS.Timeout | null;
  private setupTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private backpressureWarned = false;
  private readonly stats: RelayStats = {
    audioChunksIn: 0,
    audioBytesOut: 0,
    droppedAudioIn: 0,
    droppedAudioOut: 0,
    resumes: 0,
  };
  private readonly now: () => number;

  constructor(private readonly options: RelaySessionOptions) {
    this.id = options.id;
    this.now = options.now ?? (() => performance.now());
    this.startTimer = setTimeout(() => {
      this.fail("bad_request", "No session.start message was received in time.", true);
    }, options.limits.startTimeoutMs);
  }

  get currentPhase(): RelayPhase {
    return this.phase;
  }

  // -------------------------------------------------------------------------
  // Browser -> relay
  // -------------------------------------------------------------------------

  handleText(raw: string): void {
    if (this.phase === "ended") return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.sendError("bad_request", parsed.error, true);
      return;
    }
    const message = parsed.value;
    switch (message.type) {
      case "session.start":
        this.start(message);
        return;
      case "audio.end":
        if (this.phase === "ready") this.upstream?.sendAudioStreamEnd();
        return;
      case "session.end":
        this.end("client_ended");
        return;
    }
  }

  handleBinary(data: Buffer): void {
    if (this.phase !== "ready" || !this.upstream) {
      this.stats.droppedAudioIn += 1;
      return;
    }
    const check = validateAudioChunk(data.byteLength);
    if (!check.ok) {
      this.sendError("bad_request", check.error, true);
      return;
    }
    this.stats.audioChunksIn += 1;
    this.upstream.sendAudio(data.toString("base64"));
  }

  handleClientDisconnect(): void {
    this.end("client_disconnected");
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private start(message: SessionStartMessage): void {
    if (this.phase !== "awaiting_start") {
      this.sendError("bad_request", "A conversation is already active on this connection.", true);
      return;
    }
    this.clearTimer("startTimer");
    const admission = this.options.gate?.(this) ?? { ok: true };
    if (!admission.ok) {
      this.fail(admission.code, admission.message, true);
      return;
    }
    this.settings = resolveSettings(message);
    this.startRequestedAt = this.now();
    this.options.logger.info(
      {
        agentId: this.settings.agentId,
        voice: this.settings.voice,
        language: this.settings.language,
        customInstructions: Boolean(this.settings.instructions),
        model: this.options.model,
      },
      "session starting",
    );
    void this.openUpstream(false);
  }

  private async openUpstream(isResume: boolean): Promise<void> {
    const settings = this.settings;
    if (!settings) return;
    const generation = ++this.generation;
    this.setupDone = false;
    this.phase = isResume ? "reconnecting" : "connecting";
    this.clearTimer("setupTimer");
    this.setupTimer = setTimeout(() => {
      if (generation === this.generation) this.onSetupTimeout();
    }, this.options.limits.setupTimeoutMs);

    let upstream: UpstreamSession;
    try {
      upstream = await this.options.connect({
        model: this.options.model,
        config: buildLiveConfig(settings, isResume ? this.resumeHandle : null),
        callbacks: {
          onMessage: (message) => generation === this.generation && this.onUpstreamMessage(message),
          onError: (error) => generation === this.generation && this.onUpstreamError(error),
          onClose: (info) => generation === this.generation && this.onUpstreamClose(info),
        },
      });
    } catch (error) {
      if (generation !== this.generation) return;
      const detail = errorMessage(error);
      this.options.logger.warn({ detail: truncate(detail), isResume }, "gemini connect failed");
      const failure = classifyUpstreamFailure(detail);
      this.fail(failure.code, failure.message, failure.recoverable);
      return;
    }

    if (generation !== this.generation) {
      upstream.close();
      return;
    }
    this.upstream = upstream;
    this.maybeReady();
  }

  private maybeReady(): void {
    if (!this.setupDone || !this.upstream || !this.settings) return;
    if (this.phase === "connecting") {
      this.phase = "ready";
      this.readyAt = this.now();
      this.clearTimer("setupTimer");
      const setupMs = Math.round(this.readyAt - this.startRequestedAt);
      this.send({
        type: "session.ready",
        sessionId: this.id,
        model: this.options.model,
        agentId: this.settings.agentId,
        voice: this.settings.voice,
        language: this.settings.language,
        setupMs,
      });
      this.sessionTimer = setTimeout(() => this.onTimeLimit(), this.options.limits.maxSessionMs);
      this.options.logger.info({ setupMs }, "session ready");
    } else if (this.phase === "reconnecting") {
      this.phase = "ready";
      this.clearTimer("setupTimer");
      this.resumeAttempts = 0;
      this.stats.resumes += 1;
      this.send({ type: "session.resumed" });
      this.options.logger.info({ resumes: this.stats.resumes }, "session resumed");
    }
  }

  /** Ends the conversation and releases all resources. Safe to call repeatedly. */
  end(reason: EndReason): void {
    if (this.phase === "ended") return;
    const wasStarted = this.settings !== null;
    this.phase = "ended";
    this.generation += 1;
    this.clearTimer("startTimer");
    this.clearTimer("setupTimer");
    this.clearTimer("sessionTimer");

    const upstream = this.upstream;
    this.upstream = null;
    if (upstream) {
      try {
        upstream.close();
      } catch (error) {
        this.options.logger.warn({ detail: truncate(errorMessage(error)) }, "closing gemini session failed");
      }
    }

    if (reason !== "client_disconnected" && this.options.transport.isOpen()) {
      this.options.transport.sendJson({ type: "session.ended", reason });
      this.options.transport.close(1000, "session ended");
    }

    if (wasStarted) {
      const durationMs = this.readyAt ? Math.round(this.now() - this.readyAt) : 0;
      this.options.logger.info({ reason, durationMs, ...this.stats }, "session ended");
    }
    this.options.onEnded?.(this, reason);
  }

  private fail(code: ErrorCode, message: string, recoverable: boolean, reason: EndReason = "error"): void {
    if (this.phase === "ended") return;
    this.sendError(code, message, recoverable);
    this.end(reason);
  }

  private onSetupTimeout(): void {
    const resuming = this.phase === "reconnecting";
    this.options.logger.warn({ resuming }, "gemini setup timed out");
    this.fail(
      "upstream_timeout",
      resuming
        ? "Lost the connection to Gemini and couldn't resume the conversation. Start a new one."
        : "Gemini took too long to start the conversation. Please try again.",
      true,
    );
  }

  private onTimeLimit(): void {
    const minutes = Math.round(this.options.limits.maxSessionMs / 60_000);
    this.fail(
      "session_limit",
      `Conversations are limited to ${minutes} minutes in this demo. Start a new one to continue.`,
      true,
      "time_limit",
    );
  }

  // -------------------------------------------------------------------------
  // Gemini -> relay
  // -------------------------------------------------------------------------

  private onUpstreamMessage(message: LiveServerMessage): void {
    if (message.setupComplete) {
      this.setupDone = true;
      this.maybeReady();
    }
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.resumeHandle = resumption.newHandle;
    }
    const activity = message.voiceActivity?.voiceActivityType;
    if (activity === VoiceActivityType.ACTIVITY_START) this.send({ type: "vad", activity: "start" });
    if (activity === VoiceActivityType.ACTIVITY_END) this.send({ type: "vad", activity: "end" });
    if (message.serverContent) this.forwardServerContent(message.serverContent);
    if (message.goAway) {
      this.options.logger.info({ timeLeft: message.goAway.timeLeft ?? null }, "gemini goAway received");
      this.tryResume();
    }
  }

  private forwardServerContent(content: LiveServerContent): void {
    if (content.interrupted) this.send({ type: "interrupted" });

    const interim = content.interimInputTranscription?.text;
    if (interim) this.send({ type: "transcript.interim", role: "user", text: interim });

    const input = content.inputTranscription;
    if (input && (input.text || input.finished)) {
      this.send({ type: "transcript", role: "user", text: input.text ?? "", final: input.finished === true });
    }

    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && inline.mimeType?.startsWith("audio/")) {
        this.sendAudio(Buffer.from(inline.data, "base64"));
      }
    }

    const output = content.outputTranscription;
    if (output && (output.text || output.finished)) {
      this.send({ type: "transcript", role: "agent", text: output.text ?? "", final: output.finished === true });
    }

    if (content.turnComplete) this.send({ type: "turn.complete" });
  }

  private onUpstreamError(error: Error): void {
    // A close event always follows; it decides whether to resume or fail.
    this.options.logger.warn({ detail: truncate(error.message) }, "gemini connection error");
  }

  private onUpstreamClose(info: UpstreamCloseInfo): void {
    this.upstream = null;
    if (this.phase === "ended") return;
    this.options.logger.info({ code: info.code, reason: truncate(info.reason), phase: this.phase }, "gemini closed");
    const failure = classifyUpstreamFailure(`${info.code} ${info.reason}`);
    const canResume = this.phase === "ready" && failure.code === "upstream_error";
    if (canResume && this.tryResume()) return;
    this.fail(failure.code, failure.message, failure.recoverable, "upstream_closed");
  }

  /** Reconnects with the latest resumption handle, keeping conversation context. */
  private tryResume(): boolean {
    if (this.phase !== "ready" || !this.resumeHandle) return false;
    if (this.resumeAttempts >= this.options.limits.maxResumeAttempts) return false;
    this.resumeAttempts += 1;
    const previous = this.upstream;
    this.upstream = null;
    this.send({ type: "session.reconnecting", attempt: this.resumeAttempts });
    void this.openUpstream(true); // bumps the generation synchronously
    previous?.close();
    return true;
  }

  // -------------------------------------------------------------------------
  // Relay -> browser
  // -------------------------------------------------------------------------

  private send(message: ServerMessage): void {
    if (this.options.transport.isOpen()) this.options.transport.sendJson(message);
  }

  private sendError(code: ErrorCode, message: string, recoverable: boolean): void {
    this.send({ type: "error", code, message, recoverable });
  }

  private sendAudio(pcm: Buffer): void {
    const transport = this.options.transport;
    if (!transport.isOpen()) return;
    if (transport.bufferedBytes() > this.options.limits.maxClientBufferedBytes) {
      this.stats.droppedAudioOut += 1;
      if (!this.backpressureWarned) {
        this.backpressureWarned = true;
        this.options.logger.warn({}, "browser socket backed up; dropping audio");
      }
      return;
    }
    this.stats.audioBytesOut += pcm.byteLength;
    transport.sendAudio(pcm);
  }

  private clearTimer(name: "startTimer" | "setupTimer" | "sessionTimer"): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }
}
