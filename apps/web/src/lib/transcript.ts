import type { TranscriptRole } from "@voice-studio/shared";

export interface TranscriptEntry {
  readonly id: string;
  readonly role: TranscriptRole;
  readonly text: string;
  /** False while Gemini may still append to this entry. */
  readonly final: boolean;
  readonly interrupted: boolean;
  readonly at: number;
}

export type TranscriptAction =
  | { type: "delta"; id: string; role: TranscriptRole; text: string; final: boolean; at: number }
  | { type: "finalize"; interrupted: boolean }
  | { type: "clear" };

/**
 * Gemini streams transcription as text deltas for each side, independently of
 * each other. Deltas append to the open entry of the same role; turn
 * completion or interruption closes all open entries.
 */
export function applyTranscript(
  entries: readonly TranscriptEntry[],
  action: TranscriptAction,
): readonly TranscriptEntry[] {
  switch (action.type) {
    case "clear":
      return [];
    case "finalize":
      return entries.map((entry) =>
        entry.final
          ? entry
          : { ...entry, final: true, interrupted: action.interrupted && entry.role === "agent" },
      );
    case "delta": {
      const index = findOpenIndex(entries, action.role);
      if (index >= 0) {
        const current = entries[index]!;
        const updated = { ...current, text: current.text + action.text, final: action.final };
        return entries.map((entry, i) => (i === index ? updated : entry));
      }
      if (!action.text.trim()) return entries;
      const created: TranscriptEntry = {
        id: action.id,
        role: action.role,
        text: action.text,
        final: action.final,
        interrupted: false,
        at: action.at,
      };
      return [...entries, created];
    }
  }
}

function findOpenIndex(entries: readonly TranscriptEntry[], role: TranscriptRole): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.role === role && !entry.final) return i;
  }
  return -1;
}

export function displayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatTranscript(
  entries: readonly TranscriptEntry[],
  meta: { readonly agentName: string; readonly startedAt: number | null },
): string {
  const origin = meta.startedAt ?? entries[0]?.at ?? 0;
  const header = [`Voice Studio transcript`, `Agent: ${meta.agentName}`, `Date: ${new Date(origin).toLocaleString()}`, ""];
  const lines = entries.map((entry) => {
    const seconds = Math.max(0, Math.round((entry.at - origin) / 1000));
    const stamp = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    const who = entry.role === "user" ? "You" : meta.agentName;
    return `[${stamp}] ${who}: ${displayText(entry.text)}${entry.interrupted ? " (interrupted)" : ""}`;
  });
  return [...header, ...lines, ""].join("\n");
}
