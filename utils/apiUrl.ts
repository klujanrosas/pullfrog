import { log } from "./cli.ts";

function isLocalUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * resolve the Pullfrog API base URL.
 *
 * in the action: API_URL is not explicitly set, so this falls back to https://pullfrog.com.
 * in local dev: API_URL=http://localhost:3000 (from .env).
 *
 * enforces https:// for non-local URLs to prevent cleartext credential transmission.
 */
export function getApiUrl(): string {
  const raw = process.env.API_URL || "https://pullfrog.com";
  const parsed = new URL(raw);

  const isSelfHosted = process.env.PULLFROG_SELF_HOSTED === "1";
  if (parsed.protocol !== "https:" && !isLocalUrl(parsed) && !isSelfHosted) {
    throw new Error(
      `API_URL must use https:// (got ${parsed.protocol}). only localhost is exempt. set PULLFROG_SELF_HOSTED=1 to allow HTTP for self-hosted servers.`
    );
  }

  log.debug(`resolved API_URL: ${raw}`);
  return raw;
}

/**
 * true when the action is configured to talk to a localhost API server (i.e.
 * `pnpm dev` running on the developer's box). signals we can use dev-only
 * affordances like the `x-dev-repo` proxy-token bypass — the corresponding
 * server-side dev gates (`NODE_ENV === "development"`) ensure these paths
 * never activate against prod regardless of what the action does.
 */
export function isLocalApiUrl(): boolean {
  try {
    return isLocalUrl(new URL(getApiUrl()));
  } catch {
    return false;
  }
}
