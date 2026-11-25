import type { ErrorCode } from "@voice-studio/shared";

export interface NormalizedFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
}

const RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly failure: NormalizedFailure }> = [
  {
    pattern: /api[ _-]?key|unauthenticated|permission[ _]denied|forbidden|\b401\b|\b403\b/i,
    failure: {
      code: "auth_failed",
      message: "Gemini rejected the server's API key. Check GEMINI_API_KEY in apps/server/.env.",
      recoverable: false,
    },
  },
  {
    pattern: /quota|resource[ _]exhausted|rate[ _-]?limit|too many requests|\b429\b|billing/i,
    failure: {
      code: "quota_exceeded",
      message: "The Gemini quota or rate limit was reached. Wait a moment, then try again.",
      recoverable: true,
    },
  },
  {
    pattern: /not found|not supported|unsupported model|\bmodels\/|\b404\b/i,
    failure: {
      code: "model_unavailable",
      message: "The configured Gemini model isn't available for the Live API. Check GEMINI_MODEL.",
      recoverable: false,
    },
  },
];

const GENERIC: NormalizedFailure = {
  code: "upstream_error",
  message: "Gemini closed the connection unexpectedly. Start a new conversation to try again.",
  recoverable: true,
};

/** Maps raw upstream error/close text to a safe, user-facing failure. */
export function classifyUpstreamFailure(detail: string): NormalizedFailure {
  return RULES.find((rule) => rule.pattern.test(detail))?.failure ?? GENERIC;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

/** Keeps logs short and free of payloads. */
export function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
