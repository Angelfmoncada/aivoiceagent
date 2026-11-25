import type { EndReason } from "@voice-studio/shared";
import type { RelaySession } from "./relay-session";

/** Tracks active conversations and enforces the concurrency cap. */
export class SessionRegistry {
  private readonly sessions = new Map<string, RelaySession>();

  constructor(private readonly maxActive: number) {}

  get size(): number {
    return this.sessions.size;
  }

  tryAdd(session: RelaySession): boolean {
    if (this.sessions.has(session.id)) return true;
    if (this.sessions.size >= this.maxActive) return false;
    this.sessions.set(session.id, session);
    return true;
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  endAll(reason: EndReason): void {
    for (const session of [...this.sessions.values()]) session.end(reason);
  }
}
