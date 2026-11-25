import { WS_PATH } from "@voice-studio/shared";

/** Public URL of the voice server (not a secret; the Gemini key stays on the server). */
export function voiceServerUrl(): string {
  return (process.env.NEXT_PUBLIC_VOICE_SERVER_URL ?? "http://localhost:8787").replace(/\/+$/, "");
}

export function voiceSocketUrl(): string {
  return `${voiceServerUrl().replace(/^http/, "ws")}${WS_PATH}`;
}
