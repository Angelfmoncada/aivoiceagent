export interface UiError {
  readonly code: string;
  readonly message: string;
}

/** Maps getUserMedia / AudioContext failures to actionable messages. */
export function describeStartError(error: unknown): UiError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        code: "mic_denied",
        message: "Microphone access was blocked. Allow it from the address bar's site settings, then start again.",
      };
    case "NotFoundError":
    case "OverconstrainedError":
      return { code: "mic_missing", message: "No microphone was found. Connect one and start again." };
    case "NotReadableError":
    case "AbortError":
      return {
        code: "mic_unavailable",
        message: "The microphone is in use by another app or couldn't start. Close other apps using it and retry.",
      };
    default:
      return {
        code: "start_failed",
        message: `Couldn't start audio: ${error instanceof Error ? error.message : "unknown error"}.`,
      };
  }
}
