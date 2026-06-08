/**
 * GET /api/repo/:owner/:repo/issue/:issueNumber/plan-comment
 *
 * Returns the existing plan comment for an issue (if any).
 * The action uses this to decide whether to edit an existing plan
 * or create a new one.
 *
 * Plan comments are tracked when the action creates them via the
 * create_issue_comment MCP tool with type:"Plan". We store the
 * mapping here so the select_mode tool can find them.
 */

import type { Context } from "hono";
import { stmts } from "../db.ts";

export function planCommentGetHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const issueNumber = Number.parseInt(c.req.param("issueNumber"), 10);

  if (!Number.isFinite(issueNumber)) {
    return c.json({ error: "invalid issueNumber" }, 400);
  }

  const row = stmts.getPlanComment.get(owner, repo, issueNumber) as
    | { comment_id: number; body: string }
    | undefined;

  if (!row) {
    return c.json({ error: "no plan comment found" }, 404);
  }

  return c.json({ commentId: row.comment_id, body: row.body ?? "" });
}

/**
 * POST /api/repo/:owner/:repo/issue/:issueNumber/plan-comment
 * Upsert a plan comment mapping (called from the MCP layer when a plan is posted).
 */
export async function planCommentUpsertHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const issueNumber = Number.parseInt(c.req.param("issueNumber"), 10);

  if (!Number.isFinite(issueNumber)) {
    return c.json({ error: "invalid issueNumber" }, 400);
  }

  const body = await c.req.json<{ commentId: number; body?: string }>();
  if (typeof body.commentId !== "number") {
    return c.json({ error: "commentId required" }, 400);
  }

  stmts.upsertPlanComment.run(owner, repo, issueNumber, body.commentId, body.body ?? "");

  return c.json({ success: true });
}
