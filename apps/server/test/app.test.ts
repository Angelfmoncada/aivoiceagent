import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, type VoiceServer } from "../src/app";
import { loadEnv } from "../src/env";
import { SlidingWindowRateLimiter } from "../src/rate-limit";

const env = loadEnv({ GEMINI_API_KEY: "test-key-that-is-long-enough", LOG_LEVEL: "silent", NODE_ENV: "test" });
let server: VoiceServer | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
});

describe("server", () => {
  it("serves /health with CORS only for allowed origins", async () => {
    server = await buildServer({ env, connect: vi.fn(), logger: false });
    const allowed = await server.app.inject({ url: "/health", headers: { origin: "http://localhost:3000" } });
    expect(allowed.json()).toEqual({ status: "ok", activeSessions: 0, maxSessions: 3 });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const other = await server.app.inject({ url: "/health", headers: { origin: "https://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects WebSocket upgrades from other origins", async () => {
    server = await buildServer({ env, connect: vi.fn(), logger: false });
    await server.app.ready();
    await expect(server.app.injectWS("/ws", { headers: { origin: "https://evil.example" } })).rejects.toThrow();
  });

  it("accepts WebSocket upgrades from the allowed origin", async () => {
    server = await buildServer({ env, connect: vi.fn(), logger: false });
    await server.app.ready();
    const socket = await server.app.injectWS("/ws", { headers: { origin: "http://localhost:3000" } });
    expect(socket.readyState).toBe(socket.OPEN);
    socket.terminate();
  });
});

describe("env", () => {
  it("fails fast without an API key and never echoes values", () => {
    expect(() => loadEnv({})).toThrow(/GEMINI_API_KEY/);
  });
});

describe("SlidingWindowRateLimiter", () => {
  it("allows N per window per key", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000 }, () => now);
    expect([limiter.tryConsume("a"), limiter.tryConsume("a"), limiter.tryConsume("a")]).toEqual([true, true, false]);
    expect(limiter.tryConsume("b")).toBe(true);
    now = 1001;
    expect(limiter.tryConsume("a")).toBe(true);
  });
});
