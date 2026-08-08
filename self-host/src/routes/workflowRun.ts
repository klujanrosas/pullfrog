/**
 * PATCH /api/workflow-run/:runId
 *
 * Records usage (tokens, cost) and artifact node IDs for a workflow run.
 * Called multiple times during a run as artifacts are created and once
 * at end-of-run for usage aggregation.
 */

import type { Context } from "hono";
import { db, stmts } from "../db.ts";

const STRING_FIELDS = [
  "prNodeId",
  "issueNodeId",
  "reviewNodeId",
  "planCommentNodeId",
  "summarySnapshot",
] as const;

const NUMBER_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;

// map from camelCase API field names to snake_case DB column names
const fieldToColumn: Record<string, string> = {
  prNodeId: "pr_node_id",
  issueNodeId: "issue_node_id",
  reviewNodeId: "review_node_id",
  planCommentNodeId: "plan_comment_id",
  summarySnapshot: "summary_snapshot",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens",
  cacheWriteTokens: "cache_write_tokens",
  costUsd: "cost_usd",
};

export async function workflowRunHandler(c: Context) {
  const runId = Number.parseInt(c.req.param("runId") ?? "", 10);
  if (!Number.isFinite(runId)) {
    return c.json({ error: "invalid runId" }, 400);
  }

  const body = await c.req.json<Record<string, unknown>>();

  // ensure the row exists
  stmts.upsertWorkflowRun.run(runId, null, null);

  // build SET clauses dynamically from the payload
  const sets: string[] = [];
  const values: (string | number)[] = [];

  for (const field of STRING_FIELDS) {
    const val = body[field];
    if (typeof val === "string" && val.length > 0) {
      sets.push(`${fieldToColumn[field]} = ?`);
      values.push(val);
    }
  }

  for (const field of NUMBER_FIELDS) {
    const val = body[field];
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      sets.push(`${fieldToColumn[field]} = ?`);
      values.push(val);
    }
  }

  if (sets.length > 0) {
    sets.push("updated = datetime('now')");
    values.push(runId);
    db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE run_id = ?`).run(
      ...values
    );
  }

  return c.json({ success: true });
}
