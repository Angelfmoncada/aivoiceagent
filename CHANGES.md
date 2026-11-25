# Changes — Voice Studio v0.1.0

This README summarizes what was built in the first version of Voice Studio, the decisions that differ from the original brief, how the work was verified, and what is still open.

## What was built

### Monorepo (pnpm workspaces)

| Package | Purpose |
| --- | --- |
| `apps/server` | Fastify + `@fastify/websocket` relay to the Gemini Live API (`@google/genai` 3.x) |
| `apps/web` | Next.js 16 App Router UI (React 19, Tailwind CSS v4, lucide-react) |
| `packages/shared` | Agent configs, prompts, language list and the zod-validated WebSocket protocol |

Root scripts: `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm smoke:live`.

### Backend relay (`apps/server`)

- One Gemini Live session per browser conversation, closed when the call ends or the browser disconnects (`src/session/relay-session.ts`).
- Audio: browser sends 16 kHz PCM16 binary frames; Gemini's 24 kHz PCM16 output is relayed as binary frames.
- Forwards input/output transcription, voice-activity signals, `interrupted` and `turnComplete` as typed JSON events.
- Session resumption: stores the latest resumable handle and reconnects transparently on `goAway` (UI shows *Reconnecting…*). Sliding-window context compression enabled.
- Safety and limits: environment validation at startup, WebSocket origin allow-list, per-IP session rate limit, concurrent-session cap, start/setup timeouts, max session length, ping/pong heartbeat, 64 KB frame cap, bounded outgoing audio buffer, graceful shutdown on SIGINT/SIGTERM.
- Normalized errors (`auth_failed`, `quota_exceeded`, `model_unavailable`, `upstream_timeout`, `capacity`, `rate_limited`, …) with user-facing messages.
- Logs hold session ids, timings and counters only: no API key, audio or transcripts.
- `/health` endpoint with CORS for allowed origins.

### Web app (`apps/web`)

- Mic capture through an AudioWorklet (`public/worklets/mic-capture.js`), streaming resampler (box low-pass + linear interpolation) to 16 kHz PCM16 (`src/lib/audio/pcm.ts`).
- Gapless playback queue with a small jitter buffer, a size bound, and an immediate flush on barge-in (`src/lib/audio/player.ts`).
- Session controller (`src/lib/voice-session.ts`) with duplicate-start protection and full cleanup of tracks, nodes, AudioContext, socket and timers.
- UI: agent sidebar, status pill (Ready / Connecting / Listening / Thinking / Speaking / Reconnecting / Error), visualizer driven by real mic or playback level, mute and start/end controls, elapsed time, server-measured setup time, server status indicator, and a microphone privacy notice.
- Live transcript that merges streaming deltas, marks interrupted replies, and can be downloaded as plain text or cleared.
- Settings drawer for response language and agent instructions (applies to the next conversation).
- Clear messages for blocked or missing microphones, unsupported browsers, an unreachable server, lost connections and quota errors.

### Agents (`packages/shared/src/agents.ts`)

- **General Assistant**: answers any question; Google Search grounding enabled.
- **Restaurant Receptionist**: fictional *Harbor Lane Bistro*.
- **Home Care Coordinator**: fictional *Brightside Home Care*; no medical advice.

A non-editable honesty preamble (`prompt.ts`) stops agents from claiming real bookings or actions.

## Decisions that differ from the brief

| Brief | Implemented | Why |
| --- | --- | --- |
| Model from current docs (`gemini-3.8-live`) | Default `gemini-2.5-flash-native-audio-preview-12-2025` | The project's API key gets a quota error (1011) on `gemini-3.8-live` and `gemini-3.1-flash-live-preview`. Change it with `GEMINI_MODEL`. |
| Voice selection from documented voices | One voice (`Zephyr`) for all agents | Simplified on request |
| shadcn/ui components | Hand-built Tailwind components | Built faster; same visual direction |
| TypeScript latest (7.x) | Pinned `~6.0` | `typescript-eslint` 8.x supports `<6.1` |
| ESLint 10 everywhere | ESLint 9 in `apps/web` | `eslint-config-next` plugins don't support ESLint 10 yet |

## Verification

- `pnpm typecheck`, `pnpm lint` and `pnpm build` pass for all packages.
- 47 automated tests pass, with Gemini mocked so no paid calls are made:
  - shared (18): protocol validation, size limits, prompt guardrails
  - server (16): relay lifecycle and cleanup, timeouts, admission control, error mapping, goAway resumption, origin checks, rate limiter
  - web (13): PCM conversion, resampling accuracy, gapless scheduling, interruption flush, transcript merging
- Live smoke test against the real Gemini API (`pnpm smoke:live`, speech clips streamed through the relay): setup in about 0.5 s, spoken answer and transcripts received, barge-in produced `interrupted` and stopped the reply.
- The web build contains no API key.
- A test caught a playback bug, fixed before release: the first chunk of a burst could skip the jitter buffer.
- Fixed a Next.js 16 Cache Components error caused by reading `Date.now()` during render.

## Not yet verified or known limitations

- The full browser path (real microphone, then speakers) still needs a manual check.
- Echo cancellation depends on the browser; use headphones so the agent doesn't hear itself.
- The *Thinking* state is inferred from transcription and VAD timing; Gemini has no explicit thinking event.
- Local-development app only: the origin check is not authentication. See the README's security section before deploying.
- Transcripts are kept in memory only (no database).
