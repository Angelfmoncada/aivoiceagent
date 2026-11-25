import { z } from "zod";

const originList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })).min(1, "At least one origin is required"))
  .transform((origins) => origins.map((origin) => new URL(origin).origin));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GEMINI_API_KEY: z
    .string({ error: "GEMINI_API_KEY is required (see apps/server/.env.example)" })
    .trim()
    .min(20, "GEMINI_API_KEY looks too short"),
  GEMINI_MODEL: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]*$/, "GEMINI_MODEL must be a model id such as gemini-2.5-flash-native-audio-preview-12-2025")
    .default("gemini-2.5-flash-native-audio-preview-12-2025"),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  ALLOWED_ORIGINS: originList.default(["http://localhost:3000", "http://127.0.0.1:3000"]),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(100).default(3),
  SESSION_STARTS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(6),
  MAX_SESSION_MINUTES: z.coerce.number().min(1).max(120).default(15),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  override readonly name = "EnvValidationError";
}

/** Validates configuration at startup. Never echoes secret values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("\n");
    throw new EnvValidationError(`Invalid server configuration:\n${details}`);
  }
  return result.data;
}
