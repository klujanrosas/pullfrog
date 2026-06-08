/**
 * Admin API — manage repo settings and view usage.
 * Not called by the action — these are for your own administration.
 *
 * GET    /api/admin/repos                        — list all configured repos
 * GET    /api/admin/repos/:owner/:repo           — get repo settings
 * PUT    /api/admin/repos/:owner/:repo           — update repo settings
 * GET    /api/admin/repos/:owner/:repo/learnings — view learnings
 * GET    /api/admin/repos/:owner/:repo/usage     — view usage stats
 * GET    /api/admin/secrets/:owner                — list secrets for an owner
 */

import type { Context } from "hono";
import { db, stmts } from "../db.ts";

export function listReposHandler(c: Context) {
  const rows = db
    .prepare("SELECT owner, repo, model, push, shell, updated_at FROM repo_settings ORDER BY updated_at DESC")
    .all();
  return c.json({ repos: rows });
}

export function getRepoHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const row = stmts.getSettings.get(owner, repo);
  if (!row) return c.json({ error: "repo not configured" }, 404);
  return c.json(row);
}

export async function updateRepoHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const body = await c.req.json<Record<string, unknown>>();

  stmts.upsertSettings.run(
    owner,
    repo,
    (body.model as string) ?? null,
    (body.push as string) ?? "restricted",
    (body.shell as string) ?? "restricted",
    (body.setupScript as string) ?? null,
    (body.postCheckoutScript as string) ?? null,
    (body.prepushScript as string) ?? null,
    (body.stopScript as string) ?? null,
    body.prApproveEnabled ? 1 : 0,
    body.modeInstructions ? JSON.stringify(body.modeInstructions) : "{}",
    (body.envAllowlist as string) ?? null
  );

  return c.json({ success: true });
}

export function getLearningsHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const row = stmts.getLearnings.get(owner, repo) as { body: string } | undefined;

  const revisions = db
    .prepare(
      "SELECT id, model, created FROM learnings_revisions WHERE owner = ? AND repo = ? ORDER BY id DESC LIMIT 20"
    )
    .all(owner, repo);

  return c.json({
    learnings: row?.body ?? null,
    revisions,
  });
}

export function getUsageHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  const runs = db
    .prepare(
      `SELECT run_id, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cost_usd, created
       FROM workflow_runs
       WHERE owner = ? AND repo = ?
       ORDER BY created DESC LIMIT 50`
    )
    .all(owner, repo);

  const totals = db
    .prepare(
      `SELECT COUNT(*) as total_runs,
              SUM(input_tokens) as total_input,
              SUM(output_tokens) as total_output,
              SUM(cost_usd) as total_cost
       FROM workflow_runs
       WHERE owner = ? AND repo = ?`
    )
    .get(owner, repo);

  return c.json({ runs, totals });
}

export function listSecretsHandler(c: Context) {
  const owner = c.req.param("owner");

  const accountSecrets = (
    stmts.listAccountSecretNames.all(owner) as { name: string }[]
  ).map((s) => s.name);

  // list all repo-scoped secrets for this owner
  const repoSecrets = db
    .prepare("SELECT repo, name FROM secrets WHERE owner = ? ORDER BY repo, name")
    .all(owner) as { repo: string; name: string }[];

  return c.json({ accountSecrets, repoSecrets });
}
