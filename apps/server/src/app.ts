import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import { LIMITS, WS_PATH } from "@voice-studio/shared";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { Env } from "./env";
import type { UpstreamConnector } from "./gemini/upstream";
import { SlidingWindowRateLimiter } from "./rate-limit";
import { RelaySession, type GateResult, type RelayLimits } from "./session/relay-session";
import { SessionRegistry } from "./session/registry";

export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface AppOptions {
  readonly env: Env;
  readonly connect: UpstreamConnector;
  readonly logger?: FastifyServerOptions["logger"];
  readonly limits?: Partial<RelayLimits>;
  readonly heartbeatIntervalMs?: number;
}

export interface VoiceServer {
  readonly app: FastifyInstance;
  readonly registry: SessionRegistry;
}

const REDACTED_PATHS = ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-goog-api-key"]'];

function defaultLogger(env: Env): FastifyServerOptions["logger"] {
  const pretty = env.NODE_ENV === "development" && process.stdout.isTTY;
  return {
    level: env.LOG_LEVEL,
    // Credentials are redacted; request bodies, audio and transcripts are never logged.
    redact: { paths: REDACTED_PATHS, remove: true },
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
      : {}),
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export async function buildServer(options: AppOptions): Promise<VoiceServer> {
  const { env } = options;
  const app = Fastify({ logger: options.logger ?? defaultLogger(env), bodyLimit: 16 * 1024 });
  const registry = new SessionRegistry(env.MAX_CONCURRENT_SESSIONS);
  const limiter = new SlidingWindowRateLimiter({ limit: env.SESSION_STARTS_PER_MINUTE, windowMs: 60_000 });
  const allowedOrigins = new Set(env.ALLOWED_ORIGINS);
  const maxOpenSockets = env.MAX_CONCURRENT_SESSIONS * 4;
  const heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const limits: RelayLimits = {
    startTimeoutMs: 10_000,
    setupTimeoutMs: 15_000,
    maxSessionMs: env.MAX_SESSION_MINUTES * 60_000,
    maxClientBufferedBytes: 1024 * 1024,
    maxResumeAttempts: 2,
    ...options.limits,
  };
  let openSockets = 0;

  await app.register(websocket, { options: { maxPayload: LIMITS.maxWsPayloadBytes } });

  app.get("/health", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin).header("vary", "origin");
    }
    reply.header("cache-control", "no-store");
    return { status: "ok", activeSessions: registry.size, maxSessions: env.MAX_CONCURRENT_SESSIONS };
  });

  const admission =
    (ip: string) =>
    (session: RelaySession): GateResult => {
      if (!limiter.tryConsume(ip)) {
        return {
          ok: false,
          code: "rate_limited",
          message: "Too many conversations started recently. Wait a minute, then try again.",
        };
      }
      if (!registry.tryAdd(session)) {
        return { ok: false, code: "capacity", message: "The server is at its conversation limit. Try again shortly." };
      }
      return { ok: true };
    };

  const attach = (socket: WebSocket, request: FastifyRequest): void => {
    openSockets += 1;
    const id = randomUUID();
    const log = request.log.child({ sessionId: id });
    const session = new RelaySession({
      id,
      model: env.GEMINI_MODEL,
      connect: options.connect,
      logger: log,
      limits,
      gate: admission(request.ip),
      onEnded: (ended) => registry.remove(ended.id),
      transport: {
        sendJson: (message) => socket.send(JSON.stringify(message)),
        sendAudio: (pcm) => socket.send(pcm, { binary: true }),
        bufferedBytes: () => socket.bufferedAmount,
        isOpen: () => socket.readyState === socket.OPEN,
        close: (code, reason) => socket.close(code, reason),
      },
    });

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        log.warn({}, "heartbeat missed; terminating socket");
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, heartbeatMs);

    socket.on("pong", () => {
      alive = true;
    });
    socket.on("message", (data, isBinary) => {
      const buffer = toBuffer(data);
      if (isBinary) session.handleBinary(buffer);
      else session.handleText(buffer.toString("utf8"));
    });
    socket.on("error", (error) => log.warn({ detail: error.message }, "websocket error"));
    socket.on("close", () => {
      clearInterval(heartbeat);
      openSockets -= 1;
      session.handleClientDisconnect();
    });
  };

  app.get(
    WS_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const origin = request.headers.origin;
        if (!origin || !allowedOrigins.has(origin)) {
          request.log.warn({ origin: origin ?? null }, "websocket origin rejected");
          return reply.code(403).send({ error: "origin_not_allowed" });
        }
        if (openSockets >= maxOpenSockets) {
          return reply.code(503).send({ error: "server_busy" });
        }
      },
    },
    attach,
  );

  return { app, registry };
}
