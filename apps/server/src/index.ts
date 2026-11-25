import { existsSync } from "node:fs";
import { buildServer } from "./app";
import { EnvValidationError, loadEnv } from "./env";
import { createGeminiConnector } from "./gemini/upstream";

const SHUTDOWN_GRACE_MS = 5_000;

function loadDotEnv(): void {
  // Variables already set in the environment take precedence over the file.
  if (existsSync(".env")) process.loadEnvFile(".env");
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = loadEnv();
  const { app, registry } = await buildServer({ env, connect: createGeminiConnector(env.GEMINI_API_KEY) });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal, activeSessions: registry.size }, "shutting down");
    const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    force.unref();
    registry.endAll("server_shutdown");
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(
    { model: env.GEMINI_MODEL, allowedOrigins: env.ALLOWED_ORIGINS, maxSessions: env.MAX_CONCURRENT_SESSIONS },
    "voice server ready",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    error instanceof EnvValidationError ? `${message}\n` : `Failed to start voice server: ${message}\n`,
  );
  process.exit(1);
});
