/**
 * Live end-to-end smoke test (uses the real Gemini API — costs a few seconds of usage).
 *
 * Streams 16 kHz mono PCM16 WAV clips through the running relay exactly as the
 * browser does and prints the events it gets back. Optional second/third clips
 * test barge-in: clip 3 is sent while the agent is answering clip 2.
 *
 *   pnpm --filter @voice-studio/server dev            # in one terminal
 *   pnpm smoke:live -- q1.wav [q2.wav q3.wav]          # in another
 *
 * Env: SMOKE_URL (default ws://127.0.0.1:8787/ws), SMOKE_ORIGIN (default http://localhost:3000),
 *      SMOKE_AGENT (default general-assistant), SMOKE_OUT (optional path to save agent audio as WAV).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { AUDIO_INPUT, AUDIO_OUTPUT, parseServerMessage, type AgentId } from "@voice-studio/shared";
import WebSocket from "ws";

const url = process.env.SMOKE_URL ?? "ws://127.0.0.1:8787/ws";
const origin = process.env.SMOKE_ORIGIN ?? "http://localhost:3000";
const agentId = (process.env.SMOKE_AGENT ?? "general-assistant") as AgentId;
const clips = process.argv.slice(2).filter((arg) => arg !== "--");
const verbose = process.env.SMOKE_VERBOSE === "1";
const CHUNK_BYTES = (AUDIO_INPUT.sampleRate / 25) * 2; // 40 ms
const startedAt = performance.now();
const stamp = (): string => `${((performance.now() - startedAt) / 1000).toFixed(2)}s`;

function readPcm(path: string): Buffer {
  const wav = readFileSync(path);
  const dataIndex = wav.indexOf("data");
  if (dataIndex < 0) throw new Error(`${path} is not a PCM WAV file`);
  return wav.subarray(dataIndex + 8);
}

function wavFromPcm(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function streamPcm(socket: WebSocket, pcm: Buffer, trailingSilenceMs: number): Promise<void> {
  const silence = Buffer.alloc(CHUNK_BYTES);
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const chunk = pcm.subarray(offset, offset + CHUNK_BYTES);
    socket.send(chunk.length % 2 === 0 ? chunk : chunk.subarray(0, chunk.length - 1));
    await sleep(40);
  }
  for (let elapsed = 0; elapsed < trailingSilenceMs; elapsed += 40) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(silence);
    await sleep(40);
  }
}

async function main(): Promise<void> {
  if (clips.length === 0) throw new Error("Pass at least one 16 kHz mono PCM16 WAV file");
  const pcms = clips.map(readPcm);
  const socket = new WebSocket(url, { headers: { origin } });
  const transcript = { user: "", agent: "" };
  let audioBytes = 0;
  let turns = 0;
  let interrupted = 0;
  let firstAudioAt: number | null = null;
  const agentAudio: Buffer[] = [];

  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const chunk = data as Buffer;
        audioBytes += chunk.length;
        agentAudio.push(chunk);
        if (firstAudioAt === null) {
          firstAudioAt = performance.now();
          console.log(`${stamp()} first agent audio chunk (${chunk.length} bytes)`);
        }
        return;
      }
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) return reject(new Error(`Invalid server message: ${parsed.error}`));
      const message = parsed.value;
      if (verbose && (message.type === "transcript" || message.type === "transcript.interim")) {
        const final = message.type === "transcript" ? ` final=${message.final}` : "";
        console.log(`${stamp()}   ${message.type} ${message.role} ${JSON.stringify(message.text)}${final}`);
      }
      if (message.type === "transcript") {
        transcript[message.role] += message.text;
        if (message.final) console.log(`${stamp()} ${message.role} transcript finished`);
        return;
      }
      if (message.type === "transcript.interim") return;
      console.log(`${stamp()} ${JSON.stringify(message)}`);
      if (message.type === "turn.complete") {
        turns += 1;
        console.log(`  user:  ${transcript.user.trim()}\n  agent: ${transcript.agent.trim()}`);
        transcript.user = "";
        transcript.agent = "";
      }
      if (message.type === "interrupted") interrupted += 1;
      if (message.type === "session.ended") resolve();
      if (message.type === "error" && !message.recoverable) reject(new Error(message.message));
    });
    socket.on("close", () => resolve());
    socket.on("error", reject);
  });

  socket.on("open", () => socket.send(JSON.stringify({ type: "session.start", agentId })));
  await new Promise<void>((resolve) =>
    socket.on("message", (data, isBinary) => {
      if (!isBinary && data.toString().includes('"session.ready"')) resolve();
    }),
  );

  const [first, second, third] = pcms;
  await streamPcm(socket, first!, 1500);
  const waitForTurn = async (target: number, timeoutMs: number): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (turns < target && performance.now() < deadline) await sleep(100);
  };
  await waitForTurn(1, 20_000);

  if (second && third) {
    firstAudioAt = null;
    await streamPcm(socket, second, 1000);
    while (firstAudioAt === null) await sleep(50);
    await sleep(2500);
    console.log(`${stamp()} --- barge-in: streaming clip 3 over the agent ---`);
    await streamPcm(socket, third, 1500);
    await waitForTurn(3, 25_000);
  }

  socket.send(JSON.stringify({ type: "session.end" }));
  await done;
  console.log(`\nSummary: turns=${turns} interrupted=${interrupted} agentAudio=${(audioBytes / (AUDIO_OUTPUT.sampleRate * 2)).toFixed(1)}s`);
  if (process.env.SMOKE_OUT) {
    writeFileSync(process.env.SMOKE_OUT, wavFromPcm(Buffer.concat(agentAudio), AUDIO_OUTPUT.sampleRate));
    console.log(`Saved agent audio to ${process.env.SMOKE_OUT}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
