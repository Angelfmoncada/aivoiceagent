# Voice Studio

Real-time voice conversations with AI agents, powered by the **Gemini Live API**.
Pick an agent, press **Start conversation**, talk, interrupt it whenever you like, and watch the live transcript.

```
Browser mic ─AudioWorklet─▶ 16 kHz PCM16 ─WebSocket─▶ Node relay (Fastify) ─@google/genai─▶ Gemini Live
Browser speakers ◀─ gapless playback ◀─ 24 kHz PCM16 ◀─WebSocket─ Node relay ◀──────────── Gemini Live
```

The Gemini API key lives **only** in `apps/server/.env`. The browser talks to the relay, never to Google directly.

## Quick start

Requirements: Node.js ≥ 22.12, pnpm ≥ 10 (`npm i -g pnpm`), a Gemini API key from <https://aistudio.google.com/apikey>.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env        # then set GEMINI_API_KEY
cp apps/web/.env.example apps/web/.env.local
pnpm dev                                            # server :8787 + web :3000
```

Open <http://localhost:3000>, allow the microphone, and speak. Headphones give the cleanest barge-in.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs server (tsx watch) and web (Next dev) together |
| `pnpm test` | Unit/integration tests (Gemini is mocked; no paid calls) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | Static checks and production builds |
| `pnpm start` | Runs the built server and web app |
| `pnpm smoke:live -- a.wav [b.wav c.wav]` | Optional **live** test: streams 16 kHz mono WAV clips through a running server (uses real API quota). Clips 2–3 exercise barge-in. |

## Layout

```
apps/server     Fastify + @fastify/websocket relay, one Gemini Live session per conversation
apps/web        Next.js App Router UI (Tailwind v4, lucide-react)
packages/shared Agents, prompts, voice/language lists and the zod-validated WebSocket protocol
```

- **Agents, prompts and the voice** are configured in one place: `packages/shared/src/agents.ts` (plus the non-editable honesty rules in `prompt.ts`). All business data is fictional, and agents are told never to claim real bookings or actions.
- **Protocol** (`packages/shared/src/protocol.ts`): JSON text frames for control events (`session.start`, `audio.end`, `session.end` → `session.ready`, `transcript`, `vad`, `interrupted`, `turn.complete`, `session.reconnecting/resumed`, `error`, `session.ended`), binary frames for raw audio. Both sides validate every message.

## Gemini Live details (verified Nov 2026)

- Model: `GEMINI_MODEL`, default `gemini-2.5-flash-native-audio-preview-12-2025` (works on the free tier). `gemini-3.8-live` and `gemini-3.1-flash-live-preview` are also Live models but returned quota errors for a free-tier key.
- Audio: input `audio/pcm;rate=16000` (16-bit LE mono), output 24 kHz 16-bit LE mono.
- Server-side automatic VAD handles turn-taking; `serverContent.interrupted` stops and flushes playback immediately.
- Input/output transcription enabled; text arrives as deltas and entries are finalized on `turnComplete`/`interrupted`.
- Session resumption: the relay stores the latest resumable handle and transparently reconnects on `goAway` (UI shows *Reconnecting…*). A dropped **browser** connection is never silently resumed — the UI offers a new conversation.
- Sliding-window context compression is enabled; the demo still caps conversations at `MAX_SESSION_MINUTES`.
- Voice: `Zephyr` for all agents. Language preference is applied through system instructions (native-audio models don't accept a language code).

## Browser support

Current Chrome, Edge, Firefox and Safari (needs `getUserMedia`, `AudioWorklet`, WebSocket). Microphone access requires `https` or `localhost`. Audio playback is unlocked by the Start click.

## Security and deployment

This is a **local-development app**. Before exposing it publicly you need, at minimum:

1. **Real authentication** for the WebSocket (session cookie or signed short-lived token checked in `preValidation`). The origin check only stops other websites in a browser; any non-browser client can fake an `Origin` header.
2. **Per-user quotas** and a shared rate-limit store (Redis etc.). The built-in limiter and concurrency cap are in-memory and per-process.
3. **TLS** (`wss://`), a reverse proxy with request-size and idle timeouts, and `trustProxy` configured so `request.ip` is correct.
4. Billing alerts on the Gemini project, plus a reviewed data-retention and privacy notice (audio is sent to Google).
5. Run the relay with `NODE_ENV=production`, `HOST=0.0.0.0` behind the proxy, and set `ALLOWED_ORIGINS` to your real domain.

Logs contain session ids, timings, counters and error codes only: no API keys, audio or transcripts.

## Version notes

- TypeScript is pinned to `~6.0` because `typescript-eslint` 8.x supports `<6.1`.
- The web app uses ESLint 9 (`eslint-config-next` plugins don't declare ESLint 10 support yet); server/shared use ESLint 10.
- Next.js 16 with Cache Components: client components must not read the clock during render.

## Known limitations

- Echo cancellation depends on the browser; on laptop speakers the agent may hear itself and stop. Use headphones.
- The *Thinking* state is inferred from real transcription and VAD events with a short delay (Gemini doesn't send an explicit "thinking" event).
- No persistence: transcripts live in memory until you download them or reload.
