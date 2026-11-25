/**
 * Voice used by every agent. "Zephyr" is a documented Gemini prebuilt voice;
 * native audio Live models support all TTS prebuilt voices, so other names
 * from the speech-generation docs can be added here if needed.
 */
export const VOICE_NAMES = ["Zephyr"] as const;

export type VoiceName = (typeof VOICE_NAMES)[number];

export const DEFAULT_VOICE: VoiceName = "Zephyr";
