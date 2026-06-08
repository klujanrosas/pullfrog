/**
 * Minimal JWT implementation using node:crypto — no jsonwebtoken dependency.
 *
 * The action sends its GitHub token (OIDC or job token) to `run-context`.
 * We verify the caller is real by validating the GitHub token against the
 * GitHub API, then issue our own JWT for subsequent API calls (learnings,
 * workflow-run, upload, etc.).
 *
 * For self-hosting, we also accept a simpler path: if the caller sends
 * an `Authorization: Bearer <our-jwt>` that we issued, we trust it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * Verify a GitHub token by calling the GitHub API. Returns the authenticated
 * user/app identity, or null if the token is invalid. Used for the initial
 * `run-context` call where the action sends its GitHub Actions job token.
 *
 * For self-hosting, we're permissive: any valid GitHub token that can call
 * /user or /app is accepted. The assumption is that your self-hosted server
 * is on your own infrastructure, so network-level access control is the
 * primary gate.
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
