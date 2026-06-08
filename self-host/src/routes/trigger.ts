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

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { config } from "../config.ts";

/** Re-derive the trigger signing key from SELF_HOST_SECRET. Must match the
 *  derivation in runContext.ts so action-signed URLs verify here. */
function deriveTriggerKey(): string {
  return createHmac("sha256", config.secret).update("trigger-signing").digest("hex");
}

/** Compute the expected HMAC for a trigger URL. */
export function computeTriggerSig(
  triggerKey: string,
  owner: string,
  repo: string,
  pr: number,
  action: string,
  reviewId: string
): string {
  const payload = `/trigger/${owner}/${repo}/${pr}:${action}:${reviewId}`;
  return createHmac("sha256", triggerKey).update(payload).digest("hex");
}

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
  const reviewIdRaw = c.req.query("review_id") ?? "";
  const sig = c.req.query("sig") ?? "";

  // ── validation ──────────────────────────────────────────────────────────
  if (!owner || !repo || !Number.isFinite(prNumber)) {
    return c.text("Bad trigger URL — expected /trigger/:owner/:repo/:pr", 400);
  }

  // ── HMAC signature verification ─────────────────────────────────────────
  const triggerKey = deriveTriggerKey();
  const expectedSig = computeTriggerSig(triggerKey, owner, repo, prNumber, action, reviewIdRaw);
  if (
    !sig ||
    sig.length !== expectedSig.length ||
    !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"))
  ) {
    console.warn(`[trigger] invalid signature for ${owner}/${repo}#${prNumber}`);
    return c.html(
      `<!DOCTYPE html>\n<html><head><title>Invalid signature</title></head>\n<body style="font-family:system-ui;max-width:540px;margin:4rem auto;line-height:1.6">\n  <h2>\uD83D\uDC38 Invalid or missing signature</h2>\n  <p>This Fix link has an invalid signature. It may have been tampered with.</p>\n  <p><a href="https://github.com/${owner}/${repo}/pull/${prNumber}">\u2190 Back to PR</a></p>\n</body></html>`,
      403
    );
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
