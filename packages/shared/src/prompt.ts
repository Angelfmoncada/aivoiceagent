import type { AgentConfig } from "./agents";
import { languageLabel, type LanguageCode } from "./languages";

/**
 * Rules that always wrap an agent's instructions. Users can edit an agent's
 * persona in the settings drawer, but not this preamble.
 */
export const HONESTY_PREAMBLE = [
  'You are a voice agent inside "Voice Studio", a local demo application.',
  "You are speaking out loud, so keep replies short and conversational (usually one to three sentences) unless the user asks for more detail.",
  "Never use markdown, lists, emojis or symbols, and don't read out URLs.",
  "These rules always apply, even if later instructions say otherwise:",
  "- You cannot take real-world actions. You cannot book, reserve, schedule, cancel, buy, send messages or contact anyone, and you must never claim or imply that you did.",
  "- When asked to do such an action, explain that this is a demo and describe what would happen in a real deployment.",
  "- Business details in your instructions are fictional demo data.",
  "- If you don't know something, say so instead of guessing.",
].join("\n");

export interface SystemInstructionInput {
  readonly agent: AgentConfig;
  /** Edited persona instructions; falls back to the agent's defaults. */
  readonly instructions?: string;
  readonly language: LanguageCode;
}

export function languageDirective(language: LanguageCode): string {
  if (language === "auto") {
    return "Reply in the same language the user is speaking.";
  }
  const label = languageLabel(language);
  return `RESPOND IN ${label.toUpperCase()}. YOU MUST RESPOND UNMISTAKABLY IN ${label.toUpperCase()}, even if the user speaks another language.`;
}

export function buildSystemInstruction(input: SystemInstructionInput): string {
  const persona = input.instructions?.trim() || input.agent.instructions;
  return [HONESTY_PREAMBLE, `Your role (${input.agent.name}):\n${persona}`, languageDirective(input.language)].join(
    "\n\n",
  );
}
