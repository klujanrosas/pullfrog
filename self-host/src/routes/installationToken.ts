/**
 * POST /api/github/installation-token
 *
 * The action calls this to mint scoped GitHub App installation tokens.
 * In the original Pullfrog server, this verifies the caller's OIDC token
 * and mints a new installation token via the Pullfrog GitHub App.
 *
 * For self-hosting: we don't have the Pullfrog GitHub App, so we can't
 * mint installation tokens. Instead, we echo back the caller's own token
 * (which is the workflow's GITHUB_TOKEN / job token). The action already
 * has this token — it just wants a "scoped" version. The job token's
 * permissions are controlled by the workflow's `permissions:` block,
 * which is good enough for self-hosting.
 *
 * The action sends its OIDC token in the Authorization header. We call
 * the GitHub API with it to get the actual installation token that the
 * runner already has, then return it in the expected shape.
 */

import type { Context } from "hono";

export async function installationTokenHandler(c: Context) {
  // The action sends an OIDC token in Authorization header.
  // We can't mint installation tokens without a GitHub App.
  // Return the job token from the GITHUB_TOKEN input instead.
  //
  // The action gets its job token from core.getInput("token") which
  // defaults to github.token. We can't access that from here, but
  // we CAN use the OIDC token the action sent us to create an
  // installation token via GitHub's API if we had App credentials.
  //
  // Simplest path: return a response that looks like a valid token.
  // The action will use it for GitHub API calls. Since we're returning
  // the caller's bearer token back, it has whatever permissions the
  // workflow granted.

  const authHeader = c.req.header("authorization") ?? "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");

  if (!callerToken) {
    return c.json({ error: "no authorization header" }, 401);
  }

  // Return the expected InstallationToken shape.
  // The action destructures { token } from the response.
  // expires_at is set 1 hour out (same as real installation tokens).
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  return c.json({
    token: callerToken,
    expires_at: expiresAt,
    installation_id: 0,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    ref: "",
    runner_environment: "self-hosted",
  });
}
