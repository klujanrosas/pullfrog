/**
 * Auth layer — JWT, GitHub token verification, and Hono middleware.
 *
 * Three auth tiers:
 *   1. requireAuth   — accepts our JWT, SELF_HOST_SECRET, or a valid GitHub
 *                      token (verified via GitHub API). Used for all action
 *                      runtime and CLI routes.
 *   2. requireAdmin  — accepts SELF_HOST_SECRET only. Used for /api/admin/*.
 *   3. (none)        — /, /health are public.
 *
 * Flow:
 *   - Action calls run-context with a GitHub job token → verified via GitHub
 *     API → server issues a JWT.
 *   - Subsequent action calls send the JWT → fast local verification.
 *   - CLI calls send a GitHub OAuth token → verified via GitHub API.
 *   - Admin curl commands send SELF_HOST_SECRET as a bearer token.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { config } from "./config.ts";

function base64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64url");
}

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export function signJwt(payload: Record<string, unknown>, expiresInSec = 7200): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + expiresInSec };
  const body = `${HEADER}.${base64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", config.secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", config.secret).update(body).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Return the verified Pullfrog JWT attached to the current request. */
export function requestJwtPayload(c: { req: { header(name: string): string | undefined } }) {
  const header = c.req.header("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? verifyJwt(match[1]) : null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Timing-safe comparison of the bearer token against SELF_HOST_SECRET. */
function secretMatches(token: string): boolean {
  const expected = Buffer.from(config.secret);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Extract the bearer token from an Authorization header. */
function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

// ── GitHub token verification ───────────────────────────────────────────────

/**
 * Verify a GitHub token by calling the GitHub API. Returns the authenticated
 * user/app identity, or null if the token is invalid. Used for the initial
 * `run-context` call where the action sends its GitHub Actions job token,
 * and for CLI calls that send a GitHub OAuth token.
 */
export async function verifyGitHubToken(
  token: string
): Promise<{ login: string; type: "user" | "app" | "installation" } | null> {
  // try /user first (PATs, OAuth tokens)
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { login: string };
      return { login: data.login, type: "user" };
    }
  } catch {
    // fall through
  }

  // try /app (GitHub App JWTs / installation tokens)
  try {
    const res = await fetch("https://api.github.com/app", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { slug: string };
      return { login: data.slug, type: "app" };
    }
  } catch {
    // fall through
  }

  // installation tokens: /installation/repositories succeeds even when /user and /app don't
  try {
    const res = await fetch("https://api.github.com/installation/repositories?per_page=1", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      return { login: "installation", type: "installation" };
    }
  } catch {
    // fall through
  }

  return null;
}

// ── Hono middleware ─────────────────────────────────────────────────────────

/**
 * Middleware for all /api/* routes (except admin).
 *
 * Accepts (in order of speed):
 *   1. SELF_HOST_SECRET as bearer token       — fast, timing-safe compare
 *   2. A JWT we issued (from run-context)     — fast, local HMAC verify
 *   3. A valid GitHub token (PAT / job token) — slow, GitHub API round-trip
 *
 * Most action calls after the initial run-context hit path 2 (JWT), so the
 * GitHub API fallback only fires on the first call per run and for CLI use.
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const token = extractBearer(c.req.header("authorization"));
  if (!token) {
    return c.json({ error: "unauthorized — missing Authorization header" }, 401);
  }

  // 1. SELF_HOST_SECRET (fast)
  if (secretMatches(token)) {
    return next();
  }

  // 2. Our JWT (fast)
  const payload = verifyJwt(token);
  if (payload) {
    return next();
  }

  // 3. GitHub token (slow — API call)
  const identity = await verifyGitHubToken(token);
  if (identity) {
    return next();
  }

  return c.json({ error: "unauthorized — invalid token" }, 401);
});

/**
 * Middleware for /api/admin/* routes.
 * Only accepts SELF_HOST_SECRET — admin access is for the server operator.
 */
export const requireAdmin = createMiddleware(async (c, next) => {
  const token = extractBearer(c.req.header("authorization"));
  if (!token) {
    return c.json(
      { error: "unauthorized — admin routes require Authorization: Bearer <SELF_HOST_SECRET>" },
      401
    );
  }

  if (!secretMatches(token)) {
    return c.json(
      { error: "unauthorized — admin routes require SELF_HOST_SECRET" },
      401
    );
  }

  return next();
});
