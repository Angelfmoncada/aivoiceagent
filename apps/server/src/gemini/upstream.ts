import { GoogleGenAI, type LiveConnectConfig, type LiveServerMessage } from "@google/genai";
import { AUDIO_INPUT } from "@voice-studio/shared";

/**
 * Thin seam between the relay and the Gemini Live SDK so the relay can be
 * tested with a mock (no network, no paid calls).
 */
export interface UpstreamSession {
  sendAudio(base64Pcm16: string): void;
  sendAudioStreamEnd(): void;
  close(): void;
}

export interface UpstreamCloseInfo {
  readonly code: number;
  readonly reason: string;
}

export interface UpstreamCallbacks {
  onMessage(message: LiveServerMessage): void;
  onError(error: Error): void;
  onClose(info: UpstreamCloseInfo): void;
}

export interface UpstreamConnectOptions {
  readonly model: string;
  readonly config: LiveConnectConfig;
  readonly callbacks: UpstreamCallbacks;
}

export type UpstreamConnector = (options: UpstreamConnectOptions) => Promise<UpstreamSession>;

/** Real connector backed by the official @google/genai Live API client. */
export function createGeminiConnector(apiKey: string): UpstreamConnector {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });

  return async ({ model, config, callbacks }) => {
    const session = await ai.live.connect({
      model,
      config,
      callbacks: {
        onmessage: (message) => callbacks.onMessage(message),
        onerror: (event) => callbacks.onError(new Error(event.message || "Gemini Live connection error")),
        onclose: (event) => callbacks.onClose({ code: event.code, reason: event.reason ?? "" }),
      },
    });

    return {
      sendAudio: (data) => session.sendRealtimeInput({ audio: { data, mimeType: AUDIO_INPUT.mimeType } }),
      sendAudioStreamEnd: () => session.sendRealtimeInput({ audioStreamEnd: true }),
      close: () => session.close(),
    };
  };
}
