/**
 * Configuration — all from environment variables with sane defaults.
 *
 * Required:
 *   SELF_HOST_SECRET  — shared secret for JWT signing (any random string)
 *
 * Optional:
 *   PORT              — server port (default: 3456)
 *   DATA_DIR          — directory for SQLite DB + file uploads (default: ./data)
 *   PUBLIC_URL        — externally-reachable URL for upload links (default: http://localhost:PORT)
 */

import { randomBytes } from "node:crypto";

function env(key: string, fallback?: string): string {
  const val = process.env[key]?.trim();
  if (val) return val;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required env var: ${key}`);
}

export const config = {
  port: Number.parseInt(env("PORT", "3456"), 10),
  dataDir: env("DATA_DIR", "./data"),
  /** shared secret used to sign/verify JWTs. generate one with `openssl rand -hex 32`. */
  secret: env(
    "SELF_HOST_SECRET",
    // auto-generate a random secret for dev convenience — logs a warning
    (() => {
      const generated = randomBytes(32).toString("hex");
      console.warn(
        "⚠️  SELF_HOST_SECRET not set — using a random ephemeral secret. " +
          "set SELF_HOST_SECRET for persistence across restarts."
      );
      return generated;
    })()
  ),
  get publicUrl(): string {
    return env("PUBLIC_URL", `http://localhost:${this.port}`);
  },
};
