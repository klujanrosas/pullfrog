/**
 * GET /trigger/:owner/:repo/:pr
 *
 * Handles the "Fix all ➔" / "Fix 👍s ➔" links rendered in Pullfrog review
 * footers. When a user clicks the link in a GitHub review comment, this
 * endpoint dispatches a `workflow_dispatch` event with a structured
 * `fix_review` payload — the same shape the upstream Pullfrog server sends.
 *
 * Query params:
 *   action    — "fix" (all comments) or "fix-approved" (only 👍'd comments)
 *   review_id — the GitHub review ID to address
 *
 * Requires GITHUB_PAT in server config (fine-grained or classic PAT with
 * `actions:write` + `contents:read` scopes).
 *
 * On success, redirects the user to the GitHub Actions tab so they can
 * watch the fix run.
 */

import type { Context } from "hono";
import { config } from "../config.ts";

/** Resolve the default branch for the repo (needed as the `ref` for
 *  workflow_dispatch). Caches nothing — one API call per trigger click
 *  is fine for the expected frequency. */
async function getDefaultBranch(
  owner: string,
  repo: string,
  token: string
): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return "main"; // safe fallback
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

export async function triggerHandler(c: Context) {
  const owner = c.req.param("owner") ?? "";
  const repo = c.req.param("repo") ?? "";
  const prNumber = Number.parseInt(c.req.param("pr") ?? "", 10);
  const action = c.req.query("action") ?? "fix";
  const reviewIdRaw = c.req.query("review_id");

  // ── validation ──────────────────────────────────────────────────────────
  if (!owner || !repo || !Number.isFinite(prNumber)) {
    return c.text("Bad trigger URL — expected /trigger/:owner/:repo/:pr", 400);
  }

  if (!config.githubPat) {
    // Return a helpful HTML page instead of a raw error
    return c.html(
      `<!DOCTYPE html>
<html><head><title>Pullfrog — Fix not available</title></head>
<body style="font-family:system-ui;max-width:540px;margin:4rem auto;line-height:1.6">
  <h2>🐸 Fix dispatch not available</h2>
  <p><code>GITHUB_PAT</code> is not configured on the self-host server.</p>
  <p>To enable the Fix button, add a GitHub PAT with <code>actions:write</code>
  + <code>contents:read</code> permissions to your server's environment:</p>
  <pre>GITHUB_PAT=ghp_... npm start</pre>
  <p>Or dispatch the fix manually:</p>
  <pre>gh workflow run pullfrog.yml \\
  -f prompt='${JSON.stringify({ "~pullfrog": true, version: "1.0.0", prompt: "Fix the review comments", event: { trigger: "fix_review", issue_number: prNumber, is_pr: true, review_id: reviewIdRaw ? Number.parseInt(reviewIdRaw, 10) : 0 } })}'</pre>
  <p><a href="https://github.com/${owner}/${repo}/pull/${prNumber}">← Back to PR #${prNumber}</a></p>
</body></html>`,
      503
    );
  }

  // ── build payload ───────────────────────────────────────────────────────
  const reviewId = reviewIdRaw ? Number.parseInt(reviewIdRaw, 10) : undefined;

  const payload = {
    "~pullfrog": true,
    version: "1.0.0",
    prompt: "Fix the review comments",
    event: {
      trigger: "fix_review" as const,
      issue_number: prNumber,
      is_pr: true,
      ...(reviewId !== undefined && { review_id: reviewId }),
      ...(action === "fix-approved" && { approved_only: true }),
    },
  };

  // ── dispatch workflow ───────────────────────────────────────────────────
  const defaultBranch = await getDefaultBranch(owner, repo, config.githubPat);
  const workflowFile = config.workflowFile;
  const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

  console.log(
    `[trigger] dispatching fix_review for ${owner}/${repo}#${prNumber} ` +
      `(action=${action}, review=${reviewId ?? "none"}, ref=${defaultBranch})`
  );

  const response = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.githubPat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: defaultBranch,
      inputs: {
        prompt: JSON.stringify(payload),
        name: `Fix review — ${owner}/${repo}#${prNumber}`,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[trigger] dispatch failed: ${response.status} ${body}`);
    return c.html(
      `<!DOCTYPE html>
<html><head><title>Pullfrog — Dispatch failed</title></head>
<body style="font-family:system-ui;max-width:540px;margin:4rem auto;line-height:1.6">
  <h2>🐸 Dispatch failed</h2>
  <p>GitHub API returned <strong>${response.status}</strong>:</p>
  <pre>${body.slice(0, 500)}</pre>
  <p>Check that <code>GITHUB_PAT</code> has <code>actions:write</code> permission
  on <code>${owner}/${repo}</code>, and that the workflow file
  <code>${workflowFile}</code> exists on the <code>${defaultBranch}</code> branch.</p>
  <p><a href="https://github.com/${owner}/${repo}/pull/${prNumber}">← Back to PR #${prNumber}</a></p>
</body></html>`,
      502
    );
  }

  // ── redirect to Actions tab ─────────────────────────────────────────────
  const actionsUrl = `https://github.com/${owner}/${repo}/actions`;
  return c.redirect(actionsUrl, 302);
}
