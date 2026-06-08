/**
 * PATCH /api/repo/:owner/:repo/learnings
 *
 * Persists the agent-edited repo-level learnings at end-of-run.
 * The action sends { learnings: string, model?: string }.
 */

import type { Context } from "hono";
import { stmts } from "../db.ts";

export async function learningsHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  const body = await c.req.json<{ learnings: string; model?: string }>();

  if (typeof body.learnings !== "string") {
    return c.json({ error: "learnings must be a string" }, 400);
  }

  // cap at 100KB to be generous (original server caps at ~64KB)
  const MAX = 100_000;
  const learnings = body.learnings.length > MAX ? body.learnings.slice(0, MAX) : body.learnings;

  stmts.upsertLearnings.run(owner, repo, learnings);
  stmts.insertLearningsRevision.run(owner, repo, learnings, body.model ?? null);

  return c.json({ success: true });
}
