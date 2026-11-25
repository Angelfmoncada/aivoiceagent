import { describe, expect, it } from "vitest";
import { applyTranscript, formatTranscript, type TranscriptAction, type TranscriptEntry } from "../src/lib/transcript";

let n = 0;
const delta = (role: "user" | "agent", text: string): TranscriptAction => ({
  type: "delta",
  id: `id${++n}`,
  role,
  text,
  final: false,
  at: 1_000 + n,
});

const run = (actions: TranscriptAction[]): readonly TranscriptEntry[] =>
  actions.reduce<readonly TranscriptEntry[]>((entries, action) => applyTranscript(entries, action), []);

describe("applyTranscript", () => {
  it("merges streamed deltas into one entry per turn (real Gemini chunking)", () => {
    const entries = run([delta("user", " What"), delta("user", " is"), delta("user", " the capital of France?")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe(" What is the capital of France?");
    expect(entries[0]!.final).toBe(false);
  });

  it("keeps late user deltas on the user entry while the agent answers", () => {
    const entries = run([delta("user", "Hello"), delta("agent", "Hi"), delta("user", " there"), delta("agent", " friend")]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([
      ["user", "Hello there"],
      ["agent", "Hi friend"],
    ]);
  });

  it("finalizes on turn completion and starts new entries afterwards", () => {
    const entries = run([delta("user", "One"), delta("agent", "Two"), { type: "finalize", interrupted: false }, delta("user", "Three")]);
    expect(entries.map((e) => [e.text, e.final])).toEqual([
      ["One", true],
      ["Two", true],
      ["Three", false],
    ]);
  });

  it("marks only the agent entry as interrupted on barge-in", () => {
    const entries = run([delta("user", "Tell me a story"), delta("agent", "Once upon"), { type: "finalize", interrupted: true }]);
    expect(entries.map((e) => e.interrupted)).toEqual([false, true]);
  });

  it("does not create entries from blank deltas and never duplicates text", () => {
    const entries = run([delta("agent", " "), delta("agent", "Paris"), delta("agent", ".")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Paris.");
  });

  it("does not mutate the previous array", () => {
    const first = run([delta("user", "a")]);
    const second = applyTranscript(first, delta("user", "b"));
    expect(first[0]!.text).toBe("a");
    expect(second[0]!.text).toBe("ab");
  });
});

describe("formatTranscript", () => {
  it("renders plain text with timestamps and speakers", () => {
    const entries = run([delta("user", "  Hi  there "), { type: "finalize", interrupted: false }]);
    const text = formatTranscript(entries, { agentName: "General Assistant", startedAt: entries[0]!.at });
    expect(text).toContain("[00:00] You: Hi there");
    expect(text).toContain("Agent: General Assistant");
  });
});
