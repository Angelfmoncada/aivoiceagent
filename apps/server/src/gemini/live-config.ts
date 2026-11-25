import { Modality, type LiveConnectConfig } from "@google/genai";
import {
  buildSystemInstruction,
  getAgent,
  type AgentId,
  type LanguageCode,
  type SessionStartMessage,
  type VoiceName,
} from "@voice-studio/shared";

export interface SessionSettings {
  readonly agentId: AgentId;
  readonly voice: VoiceName;
  readonly language: LanguageCode;
  readonly instructions?: string;
}

export function resolveSettings(message: SessionStartMessage): SessionSettings {
  const agent = getAgent(message.agentId);
  return {
    agentId: agent.id,
    voice: message.voice ?? agent.defaultVoice,
    language: message.language ?? "auto",
    ...(message.instructions ? { instructions: message.instructions } : {}),
  };
}

/**
 * Builds the documented Live API session config:
 * audio responses, prebuilt voice, input/output transcription, server VAD
 * (default automatic activity detection), session resumption and sliding-window
 * context compression (lifts the 15-minute audio session limit).
 */
export function buildLiveConfig(settings: SessionSettings, resumeHandle: string | null): LiveConnectConfig {
  const agent = getAgent(settings.agentId);
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildSystemInstruction({
      agent,
      language: settings.language,
      ...(settings.instructions ? { instructions: settings.instructions } : {}),
    }),
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    contextWindowCompression: { slidingWindow: {} },
    ...(agent.tools.googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };
}
