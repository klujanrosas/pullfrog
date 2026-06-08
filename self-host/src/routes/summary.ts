/**
 * GET  /api/repo/:owner/:repo/pr/:prNumber/summary-comment
 * PATCH (via workflowRun summarySnapshot) persists automatically.
 *
 * Returns the most recent PR summary snapshot for incremental reviews.
 * The action seeds this snapshot at run start and the agent edits it.
 * At end-of-run, the action PATCHes via /api/workflow-run/:runId with
 * summarySnapshot. We also intercept that to save into summary_snapshots.
 */

import type { Context } from "hono";
import { stmts } from "../db.ts";

export function summaryGetHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const prNumber = Number.parseInt(c.req.param("prNumber"), 10);

  if (!Number.isFinite(prNumber)) {
    return c.json({ error: "invalid prNumber" }, 400);
  }

  const row = stmts.getSummary.get(owner, repo, prNumber) as
    | { snapshot: string }
    | undefined;

  return c.json({ snapshot: row?.snapshot ?? null });
}

/**
 * Called from the workflow-run PATCH handler when summarySnapshot is present.
 * Also exposed as a direct route for explicit saves.
 */
export function saveSummarySnapshot(
  owner: string,
  repo: string,
  prNumber: number,
  snapshot: string
): void {
  stmts.upsertSummary.run(owner, repo, prNumber, snapshot);
}
