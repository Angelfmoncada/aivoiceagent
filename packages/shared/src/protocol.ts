import { z } from "zod";
import { AGENT_IDS } from "./agents";
import { LANGUAGE_CODES } from "./languages";
import { VOICE_NAMES } from "./voices";

/**
 * Browser <-> server WebSocket protocol.
 *
 * - Text frames carry JSON control events (validated with the schemas below).
 * - Binary frames carry raw audio only:
 *   - browser -> server: PCM16 little-endian, mono, 16 kHz (Gemini Live input format)
 *   - server -> browser: PCM16 little-endian, mono, 24 kHz (Gemini Live output format)
 *
 * One WebSocket carries exactly one conversation. The server closes it after
 * sending `session.ended`.
 */

export const WS_PATH = "/ws";

export const AUDIO_INPUT = {
  sampleRate: 16_000,
  channels: 1,
  bytesPerSample: 2,
  mimeType: "audio/pcm;rate=16000",
} as const;

export const AUDIO_OUTPUT = {
  sampleRate: 24_000,
  channels: 1,
  bytesPerSample: 2,
} as const;

export const LIMITS = {
  /** Hard cap enforced by the WebSocket server for any frame. */
  maxWsPayloadBytes: 64 * 1024,
  /** JSON control messages are small; instructions are the largest field. */
  maxTextMessageChars: 16 * 1024,
  /** ~1 s of 16 kHz PCM16 audio. Clients send ~40 ms chunks. */
  maxAudioChunkBytes: 32 * 1024,
  maxInstructionsChars: 4_000,
} as const;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const sessionStartSchema = z.strictObject({
  type: z.literal("session.start"),
  agentId: z.enum(AGENT_IDS),
  voice: z.enum(VOICE_NAMES).optional(),
  language: z.enum(LANGUAGE_CODES).optional(),
  instructions: z.string().trim().min(1).max(LIMITS.maxInstructionsChars).optional(),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  sessionStartSchema,
  /** Microphone paused/muted: flush Gemini's cached audio. */
  z.strictObject({ type: z.literal("audio.end") }),
  z.strictObject({ type: z.literal("session.end") }),
]);

export type SessionStartMessage = z.infer<typeof sessionStartSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "bad_request",
  "rate_limited",
  "capacity",
  "auth_failed",
  "quota_exceeded",
  "model_unavailable",
  "upstream_error",
  "upstream_timeout",
  "session_limit",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const END_REASONS = [
  "client_ended",
  "client_disconnected",
  "upstream_closed",
  "error",
  "time_limit",
  "server_shutdown",
] as const;
export type EndReason = (typeof END_REASONS)[number];

export const TRANSCRIPT_ROLES = ["user", "agent"] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.ready"),
    sessionId: z.string(),
    model: z.string(),
    agentId: z.enum(AGENT_IDS),
    voice: z.enum(VOICE_NAMES),
    language: z.enum(LANGUAGE_CODES),
    /** Measured on the server: session.start received -> Gemini setupComplete. */
    setupMs: z.number().nonnegative(),
  }),
  /** Transcript text delta. `final` mirrors Gemini's `finished` flag. */
  z.object({
    type: z.literal("transcript"),
    role: z.enum(TRANSCRIPT_ROLES),
    text: z.string(),
    final: z.boolean(),
  }),
  /** Low-latency interim user transcript (replaces the previous interim text). */
  z.object({
    type: z.literal("transcript.interim"),
    role: z.literal("user"),
    text: z.string(),
  }),
  /** Gemini voice-activity signal for the user's speech. */
  z.object({ type: z.literal("vad"), activity: z.enum(["start", "end"]) }),
  z.object({ type: z.literal("turn.complete") }),
  /** The user barged in: stop playback and drop queued audio immediately. */
  z.object({ type: z.literal("interrupted") }),
  z.object({ type: z.literal("session.reconnecting"), attempt: z.number().int().positive() }),
  z.object({ type: z.literal("session.resumed") }),
  z.object({
    type: z.literal("error"),
    code: z.enum(ERROR_CODES),
    message: z.string(),
    recoverable: z.boolean(),
  }),
  z.object({ type: z.literal("session.ended"), reason: z.enum(END_REASONS) }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageType = ServerMessage["type"];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJson<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  if (raw.length > LIMITS.maxTextMessageChars) {
    return { ok: false, error: "Message too large" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Message is not valid JSON" };
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `Invalid message: ${path}${issue?.message ?? "unknown error"}` };
  }
  return { ok: true, value: result.data };
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseJson(raw, clientMessageSchema);
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseJson(raw, serverMessageSchema);
}

/** Validates a binary microphone frame (PCM16 => even, bounded, non-empty). */
export function validateAudioChunk(byteLength: number): ParseResult<number> {
  if (byteLength === 0) return { ok: false, error: "Empty audio chunk" };
  if (byteLength > LIMITS.maxAudioChunkBytes) return { ok: false, error: "Audio chunk too large" };
  if (byteLength % AUDIO_INPUT.bytesPerSample !== 0) {
    return { ok: false, error: "Audio chunk is not 16-bit PCM" };
  }
  return { ok: true, value: byteLength };
}
