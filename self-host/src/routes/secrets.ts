/**
 * PUT  /api/runtime/secret          — persist refreshed Codex auth tokens at end-of-run
 * GET  /api/cli/secrets              — check installation status + list secrets
 * POST /api/cli/secrets              — store a secret via the CLI
 */

import type { Context } from "hono";
import { requestJwtPayload } from "../auth.ts";
import { stmts } from "../db.ts";

/**
 * PUT /api/runtime/secret
 * Called by the entryPost.ts hook to persist refreshed Codex auth tokens.
 */
export async function runtimeSecretHandler(c: Context) {
  const body = await c.req.json<{ name: string; value: string }>();

  if (!body.name || !body.value) {
    return c.json({ error: "name and value required" }, 400);
  }

  // Runtime writeback must use the same owner that run-context used. The
  // previous default owner made rotated credentials invisible to subsequent
  // runs for every real GitHub organization.
  const claims = requestJwtPayload(c);
  const owner = typeof claims?.owner === "string" ? claims.owner : "default";
  const repo = typeof claims?.repo === "string" ? claims.repo : null;

  if (repo && stmts.getSecret.get(owner, repo, body.name)) {
    stmts.upsertSecret.run(owner, repo, body.name, body.value, "repo");
  } else {
    stmts.upsertAccountSecret.run(owner, body.name, body.value);
  }

  return c.json({ success: true });
}

/**
 * GET /api/cli/secrets?owner=X&repo=Y
 * Returns installation status and lists configured secrets.
 * For self-hosting, the "app" is always "installed".
 */
export function cliSecretsGetHandler(c: Context) {
  const owner = c.req.query("owner") ?? "";
  const repo = c.req.query("repo") ?? "";

  if (!owner || !repo) {
    return c.json({ error: "owner and repo query params required" }, 400);
  }

  const repoSecrets = (
    stmts.listSecretNames.all(owner, repo) as { name: string }[]
  ).map((s) => s.name);

  const accountSecrets = (
    stmts.listAccountSecretNames.all(owner) as { name: string }[]
  ).map((s) => s.name);

  // merge and deduplicate
  const pullfrogSecrets = [...new Set([...repoSecrets, ...accountSecrets])];

  return c.json({
    appSlug: "pullfrog-self-host",
    installationId: 1,
    repositorySelection: "all",
    isOrg: false,
    accessible: true,
    repoSecrets: [],
    orgSecrets: [],
    pullfrogSecrets,
    repoStatus: "active",
    repoModel: null,
    hasRuns: true,
  });
}

/**
 * POST /api/cli/secrets
 * Store a secret via the Pullfrog CLI.
 */
export async function cliSecretsPostHandler(c: Context) {
  const body = await c.req.json<{
    owner: string;
    repo: string;
    name: string;
    value: string;
    scope?: string;
  }>();

  if (!body.owner || !body.name || !body.value) {
    return c.json({ error: "owner, name, and value required" }, 400);
  }

  const scope = body.scope ?? "repo";

  if (scope === "account") {
    stmts.upsertAccountSecret.run(body.owner, body.name, body.value);
  } else {
    stmts.upsertSecret.run(body.owner, body.repo ?? "*", body.name, body.value, scope);
  }

  return c.json({ success: true });
}
