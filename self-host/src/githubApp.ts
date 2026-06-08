/**
 * Mint GitHub App installation tokens for the webhook handler.
 *
 * Uses the app's private key to generate a JWT, finds the installation
 * for the target repo, and mints a scoped installation token. Tokens
 * are cached for 50 minutes (they expire after 60).
 *
 * The installation token is used for reactions, comments, and any
 * GitHub API call that needs the app's permissions (issues:write,
 * pull_requests:write, contents:write). Workflow dispatch uses the
 * separate GITHUB_PAT (which only needs actions:write).
 */

import { createSign, createHmac } from "node:crypto";
import { config } from "./config.ts";

// ── JWT generation ────────────────────────────────────────────────────────────

function base64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64url");
}

function generateJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 5 * 60, iss: appId })
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

// ── Installation token cache ──────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, CachedToken>();
const CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes (tokens expire at 60)

function getCachedToken(owner: string, repo: string): string | null {
  const key = `${owner}/${repo}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  tokenCache.delete(key);
  return null;
}

function setCachedToken(owner: string, repo: string, token: string): void {
  tokenCache.set(`${owner}/${repo}`, {
    token,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ── Installation discovery ────────────────────────────────────────────────────

async function findInstallationId(jwt: string, owner: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/orgs/${owner}/installation`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // try user installation instead of org
      const userRes = await fetch(`https://api.github.com/users/${owner}/installation`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!userRes.ok) return null;
      const userData = (await userRes.json()) as { id: number };
      return userData.id;
    }
    const data = (await res.json()) as { id: number };
    return data.id;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mint (or return cached) installation token for the given repo.
 * Returns null if app credentials aren't configured or minting fails.
 */
export async function getInstallationToken(
  owner: string,
  repo: string
): Promise<string | null> {
  if (!config.githubAppId || !config.githubAppPrivateKey) return null;

  const cached = getCachedToken(owner, repo);
  if (cached) return cached;

  try {
    const privateKey = config.githubAppPrivateKey.replace(/\\n/g, "\n");
    const jwt = generateJwt(config.githubAppId, privateKey);

    const installationId = await findInstallationId(jwt, owner);
    if (!installationId) {
      console.error(`[github-app] no installation found for ${owner}`);
      return null;
    }

    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ repositories: [repo] }),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      console.error(`[github-app] token mint failed: ${res.status} ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as { token: string };
    setCachedToken(owner, repo, data.token);
    console.log(`[github-app] minted installation token for ${owner}/${repo}`);
    return data.token;
  } catch (err) {
    console.error(`[github-app] error: ${err}`);
    return null;
  }
}
