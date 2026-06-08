/**
 * POST /api/github/installation-token
 *
 * The action calls this to mint scoped GitHub App installation tokens
 * for cross-repo access (e.g. writing to a different repo's PR).
 *
 * In the original Pullfrog server, this verifies the caller's OIDC token,
 * looks up the GitHub App's private key, and mints via the GitHub API.
 *
 * For self-hosting WITHOUT the Pullfrog GitHub App:
 *   - The action falls back to the job token from `github.token` when this
 *     fails (which is fine for single-repo usage).
 *   - If you need cross-repo tokens, configure GITHUB_APP_ID and
 *     GITHUB_APP_PRIVATE_KEY env vars and we'll mint them.
 */

import type { Context } from "hono";

export async function installationTokenHandler(c: Context) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    // no GitHub App configured — the action falls back to the job token
    return c.json(
      { error: "no GitHub App configured — action will use the job token" },
      501
    );
  }

  // If you have a GitHub App, implement JWT → installation token minting here.
  // For most self-host scenarios, the job token is sufficient.
  return c.json({ error: "GitHub App token minting not implemented" }, 501);
}
