import type { LiveServerMessage } from "@google/genai";
import type { ServerMessage } from "@voice-studio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamCallbacks, UpstreamConnectOptions } from "../src/gemini/upstream";
import { RelaySession, type RelayLimits, type RelayTransport } from "../src/session/relay-session";

const LIMITS: RelayLimits = {
  startTimeoutMs: 1_000,
  setupTimeoutMs: 1_000,
  maxSessionMs: 60_000,
  maxClientBufferedBytes: 1_000_000,
  maxResumeAttempts: 2,
};

function harness(overrides: Partial<{ gate: ConstructorParameters<typeof RelaySession>[0]["gate"] }> = {}) {
  const sent: ServerMessage[] = [];
  const audio: Buffer[] = [];
  let open = true;
  const transport: RelayTransport = {
    sendJson: (message) => sent.push(message),
    sendAudio: (pcm) => audio.push(pcm),
    bufferedBytes: () => 0,
    isOpen: () => open,
    close: vi.fn(() => {
      open = false;
    }),
  };
  const upstreams: Array<{ options: UpstreamConnectOptions; sendAudio: ReturnType<typeof vi.fn>; sendAudioStreamEnd: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(async (options: UpstreamConnectOptions) => {
    const upstream = { options, sendAudio: vi.fn(), sendAudioStreamEnd: vi.fn(), close: vi.fn() };
    upstreams.push(upstream);
    return upstream;
  });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onEnded = vi.fn();
  const session = new RelaySession({ id: "s1", model: "test-model", transport, connect, logger, limits: LIMITS, onEnded, ...overrides });
  const callbacks = (index = 0): UpstreamCallbacks => upstreams[index]!.options.callbacks;
  const emit = (message: Partial<LiveServerMessage>, index = 0) => callbacks(index).onMessage(message as LiveServerMessage);
  const types = () => sent.map((message) => message.type);
  return { session, transport, connect, upstreams, callbacks, emit, sent, audio, types, onEnded };
}

async function startReady(h: ReturnType<typeof harness>) {
  h.session.handleText(JSON.stringify({ type: "session.start", agentId: "general-assistant" }));
  await vi.waitFor(() => expect(h.upstreams).toHaveLength(1));
  h.emit({ setupComplete: {} });
}

describe("RelaySession", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("opens one Gemini session with the documented config and reports ready", async () => {
    const h = harness();
    await startReady(h);
    const { model, config } = h.upstreams[0]!.options;
    expect(model).toBe("test-model");
    expect(config.responseModalities).toEqual(["AUDIO"]);
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Zephyr");
    expect(config.tools).toEqual([{ googleSearch: {} }]);
    expect(h.sent[0]).toMatchObject({ type: "session.ready", sessionId: "s1", voice: "Zephyr", language: "auto" });
  });

  it("forwards mic audio as base64 only once ready, and rejects bad chunks", async () => {
    const h = harness();
    h.session.handleBinary(Buffer.alloc(320)); // before start: dropped
    await startReady(h);
    h.session.handleBinary(Buffer.from([1, 0, 2, 0]));
    expect(h.upstreams[0]!.sendAudio).toHaveBeenCalledWith(Buffer.from([1, 0, 2, 0]).toString("base64"));
    h.session.handleBinary(Buffer.alloc(3));
    expect(h.upstreams[0]!.sendAudio).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)).toMatchObject({ type: "error", code: "bad_request" });
  });

  it("relays audio, transcripts, interruption and turn completion", async () => {
    const h = harness();
    await startReady(h);
    const pcm = Buffer.from([1, 2, 3, 4]);
    h.emit({ serverContent: { inputTranscription: { text: " Hi" } } });
    h.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm.toString("base64") } }] } } });
    h.emit({ serverContent: { outputTranscription: { text: "Hello", finished: true } } });
    h.emit({ serverContent: { interrupted: true } });
    h.emit({ serverContent: { turnComplete: true } });
    expect(h.audio).toEqual([pcm]);
    expect(h.sent.slice(1)).toEqual([
      { type: "transcript", role: "user", text: " Hi", final: false },
      { type: "transcript", role: "agent", text: "Hello", final: true },
      { type: "interrupted" },
      { type: "turn.complete" },
    ]);
  });

  it("session.end closes upstream, notifies the client and releases once", async () => {
    const h = harness();
    await startReady(h);
    h.session.handleText(JSON.stringify({ type: "session.end" }));
    h.session.handleClientDisconnect();
    expect(h.upstreams[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)).toEqual({ type: "session.ended", reason: "client_ended" });
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.session.currentPhase).toBe("ended");
  });

  it("browser disconnect closes the Gemini session", async () => {
    const h = harness();
    await startReady(h);
    h.session.handleClientDisconnect();
    expect(h.upstreams[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.onEnded).toHaveBeenCalledWith(h.session, "client_disconnected");
  });

  it("rejects a duplicate session.start on the same connection", async () => {
    const h = harness();
    await startReady(h);
    h.session.handleText(JSON.stringify({ type: "session.start", agentId: "general-assistant" }));
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)).toMatchObject({ type: "error", code: "bad_request" });
  });

  it("maps a quota close during setup to a normalized error", async () => {
    const h = harness();
    h.session.handleText(JSON.stringify({ type: "session.start", agentId: "general-assistant" }));
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(1));
    h.callbacks().onClose({ code: 1011, reason: "You exceeded your current quota" });
    expect(h.types()).toEqual(["error", "session.ended"]);
    expect(h.sent[0]).toMatchObject({ code: "quota_exceeded", recoverable: true });
  });

  it("times out when Gemini never completes setup", async () => {
    const h = harness();
    h.session.handleText(JSON.stringify({ type: "session.start", agentId: "general-assistant" }));
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(1));
    vi.advanceTimersByTime(LIMITS.setupTimeoutMs + 1);
    expect(h.sent[0]).toMatchObject({ type: "error", code: "upstream_timeout" });
    expect(h.upstreams[0]!.close).toHaveBeenCalled();
  });

  it("ends the connection if session.start never arrives", () => {
    const h = harness();
    vi.advanceTimersByTime(LIMITS.startTimeoutMs + 1);
    expect(h.types()).toEqual(["error", "session.ended"]);
  });

  it("refuses to start when admission control says no", () => {
    const h = harness({ gate: () => ({ ok: false, code: "capacity", message: "Full" }) });
    h.session.handleText(JSON.stringify({ type: "session.start", agentId: "general-assistant" }));
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({ type: "error", code: "capacity" });
  });

  it("resumes with the latest handle on goAway and ignores the old connection", async () => {
    const h = harness();
    await startReady(h);
    h.emit({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" } });
    h.emit({ goAway: { timeLeft: "10s" } });
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(2));
    expect(h.upstreams[0]!.close).toHaveBeenCalled();
    expect(h.upstreams[1]!.options.config.sessionResumption).toEqual({ handle: "handle-1" });
    h.callbacks(0).onClose({ code: 1000, reason: "" }); // stale: ignored
    h.emit({ setupComplete: {} }, 1);
    expect(h.types()).toEqual(["session.ready", "session.reconnecting", "session.resumed"]);
  });
});
