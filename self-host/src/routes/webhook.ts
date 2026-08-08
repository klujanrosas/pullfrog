/**
 * POST /webhook
 *
 * GitHub App webhook handler. Receives events from the code-amauta app,
 * verifies the signature, then:
 *   1. Posts an immediate 👀 reaction (for comment-based triggers)
 *   2. Creates a progress comment ("Leaping into action...")
 *   3. Dispatches a workflow_dispatch with the structured payload
 *
 * The progress comment ID is embedded in the payload so the action can
 * update it in-place rather than creating a duplicate.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { config } from "../config.ts";
import { getInstallationToken } from "../githubApp.ts";

// ── GitHub API helpers ────────────────────────────────────────────────────────

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

/** Headers for dispatch (uses PAT — needs actions:write). */
function dispatchHeaders(): Record<string, string> {
  return { ...GH_HEADERS, Authorization: `Bearer ${config.githubPat}` };
}

/** Headers for reactions/comments (uses app installation token). */
function appHeaders(token: string): Record<string, string> {
  return { ...GH_HEADERS, Authorization: `Bearer ${token}` };
}

async function ghPost(path: string, body: unknown, token: string): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { ...appHeaders(token), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  };
  if (body) init.body = JSON.stringify(body);
  return fetch(`https://api.github.com${path}`, init);
}

async function ghGet(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: appHeaders(token),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Add a reaction to a comment. Swallows errors — best effort. */
async function addReaction(
  owner: string,
  repo: string,
  commentId: number,
  reaction: string,
  type: "issues" | "pulls",
  token: string
): Promise<void> {
  try {
    const path =
      type === "pulls"
        ? `/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`
        : `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`;
    await ghPost(path, { content: reaction }, token);
  } catch (err) {
    console.warn(`[webhook] reaction failed: ${err}`);
  }
}

/** Create a progress comment on an issue/PR. Returns the comment ID. */
async function createProgressComment(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string
): Promise<string | undefined> {
  try {
    const res = await ghPost(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body: "New request. Leaping into action..." },
      token
    );
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[webhook] progress comment failed: ${res.status} ${body.slice(0, 200)}`);
      return undefined;
    }
    const data = (await res.json()) as { id: number };
    return String(data.id);
  } catch (err) {
    console.warn(`[webhook] progress comment error: ${err}`);
    return undefined;
  }
}

/** Get the default branch for a repo. */
async function getDefaultBranch(owner: string, repo: string, token: string): Promise<string> {
  try {
    const res = await ghGet(`/repos/${owner}/${repo}`, token);
    if (!res.ok) return "main";
    const data = (await res.json()) as { default_branch?: string };
    return data.default_branch ?? "main";
  } catch {
    return "main";
  }
}

// ── Webhook signature verification ────────────────────────────────────────────

function verifySignature(payload: string, signature: string): boolean {
  if (!config.webhookSecret) return false;
  const expected = `sha256=${createHmac("sha256", config.webhookSecret).update(payload).digest("hex")}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatch(
  owner: string,
  repo: string,
  payload: Record<string, unknown>,
  name: string,
  appToken: string
): Promise<boolean> {
  if (!config.githubPat) {
    console.error("[webhook] GITHUB_PAT not configured — cannot dispatch");
    return false;
  }
  const defaultBranch = await getDefaultBranch(owner, repo, appToken);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${config.workflowFile}/dispatches`,
    {
      method: "POST",
      headers: { ...dispatchHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: defaultBranch,
        inputs: { prompt: JSON.stringify(payload), name },
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    console.error(`[webhook] dispatch failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.ok;
}

// ── Event handlers ────────────────────────────────────────────────────────────

type WebhookResult = { handled: boolean; reason?: string };

const BOT_LOGIN = "code-amauta[bot]";
const MENTION = "@code-amauta";

async function handlePullRequest(body: any): Promise<WebhookResult> {
  const action = body.action;
  if (!["opened", "synchronize", "ready_for_review"].includes(action)) {
    return { handled: false, reason: `pr action '${action}' not handled` };
  }
  const pr = body.pull_request;
  if (pr.draft) return { handled: false, reason: "draft PR" };
  if (pr.user?.login === BOT_LOGIN) return { handled: false, reason: "bot's own PR" };

  const owner = body.repository.owner.login;
  const repo = body.repository.name;
  const prNumber = pr.number;

  const appToken = await getInstallationToken(owner, repo);
  if (!appToken) return { handled: false, reason: "could not mint app token" };

  const triggerMap: Record<string, string> = {
    opened: "pull_request_opened",
    synchronize: "pull_request_synchronize",
    ready_for_review: "pull_request_ready_for_review",
  };

  const progressId = await createProgressComment(owner, repo, prNumber, appToken);
  const prompt =
    action === "synchronize"
      ? "Review the new changes pushed to this PR"
      : "Review this pull request";

  const payload: Record<string, unknown> = {
    "~pullfrog": true,
    version: "0.1.0",
    prompt,
    generateSummary: true,
    event: {
      trigger: triggerMap[action],
      issue_number: prNumber,
      is_pr: true,
      title: pr.title,
      branch: pr.head?.ref,
      ...(action === "synchronize" && body.before ? { before_sha: body.before } : {}),
    },
    ...(progressId ? { progressComment: { id: progressId, type: "issue" } } : {}),
  };

  const ok = await dispatch(owner, repo, payload, `Review #${prNumber} [${pr.head?.sha?.slice(0, 5) ?? ""}]`, appToken);
  return ok ? { handled: true } : { handled: false, reason: "dispatch failed" };
}

async function handleIssueComment(body: any): Promise<WebhookResult> {
  const comment = body.comment;
  if (comment.user?.login === BOT_LOGIN) return { handled: false, reason: "bot's own comment" };
  if (!comment.body?.includes(MENTION)) return { handled: false, reason: "no mention" };

  const owner = body.repository.owner.login;
  const repo = body.repository.name;
  const issueNumber = body.issue.number;
  const isPr = !!body.issue.pull_request;

  const appToken = await getInstallationToken(owner, repo);
  if (!appToken) return { handled: false, reason: "could not mint app token" };

  // 👀 reaction + progress comment in parallel
  const [, progressId] = await Promise.all([
    addReaction(owner, repo, comment.id, "eyes", "issues", appToken),
    createProgressComment(owner, repo, issueNumber, appToken),
  ]);

  const payload: Record<string, unknown> = {
    "~pullfrog": true,
    version: "0.1.0",
    prompt: comment.body,
    triggerer: comment.user?.login,
    event: {
      trigger: "issue_comment_created",
      issue_number: issueNumber,
      comment_id: comment.id,
      comment_type: "issue",
      body: null,
      title: body.issue.title,
      ...(isPr ? { is_pr: true, branch: body.issue.pull_request?.head?.ref ?? "" } : {}),
    },
    ...(progressId ? { progressComment: { id: progressId, type: "issue" } } : {}),
  };

  const ok = await dispatch(owner, repo, payload, `Mention — ${body.issue.title}`, appToken);
  return { handled: ok };
}

async function handlePullRequestReview(body: any): Promise<WebhookResult> {
  const review = body.review;
  if (review.user?.login === BOT_LOGIN) return { handled: false, reason: "bot's own review" };

  // Only trigger on changes_requested or if body mentions the bot
  const isChangesRequested = review.state === "changes_requested";
  const mentionsBot = review.body?.includes(MENTION);
  if (!isChangesRequested && !mentionsBot) {
    return { handled: false, reason: "not changes_requested and no mention" };
  }

  const owner = body.repository.owner.login;
  const repo = body.repository.name;
  const pr = body.pull_request;

  const appToken = await getInstallationToken(owner, repo);
  if (!appToken) return { handled: false, reason: "could not mint app token" };

  const progressId = await createProgressComment(owner, repo, pr.number, appToken);

  const payload: Record<string, unknown> = {
    "~pullfrog": true,
    version: "0.1.0",
    prompt: "Address the review feedback",
    triggerer: review.user?.login,
    event: {
      trigger: "pull_request_review_submitted",
      issue_number: pr.number,
      is_pr: true,
      review_id: review.id,
      review_state: review.state,
      branch: pr.head?.ref,
      body: null,
    },
    ...(progressId ? { progressComment: { id: progressId, type: "issue" } } : {}),
  };

  const ok = await dispatch(owner, repo, payload, `Address review — #${pr.number}`, appToken);
  return { handled: ok };
}

async function handlePullRequestReviewComment(body: any): Promise<WebhookResult> {
  const comment = body.comment;
  if (comment.user?.login === BOT_LOGIN) return { handled: false, reason: "bot's own comment" };
  if (!comment.body?.includes(MENTION)) return { handled: false, reason: "no mention" };

  const owner = body.repository.owner.login;
  const repo = body.repository.name;
  const pr = body.pull_request;

  const appToken = await getInstallationToken(owner, repo);
  if (!appToken) return { handled: false, reason: "could not mint app token" };

  const [, progressId] = await Promise.all([
    addReaction(owner, repo, comment.id, "eyes", "pulls", appToken),
    createProgressComment(owner, repo, pr.number, appToken),
  ]);

  const payload: Record<string, unknown> = {
    "~pullfrog": true,
    version: "0.1.0",
    prompt: comment.body,
    triggerer: comment.user?.login,
    event: {
      trigger: "pull_request_review_comment_created",
      issue_number: pr.number,
      is_pr: true,
      comment_id: comment.id,
      title: pr.title,
      body: null,
      branch: pr.head?.ref,
    },
    ...(progressId ? { progressComment: { id: progressId, type: "issue" } } : {}),
  };

  const ok = await dispatch(owner, repo, payload, `Review thread — #${pr.number}`, appToken);
  return { handled: ok };
}

async function handleCheckSuite(body: any): Promise<WebhookResult> {
  const suite = body.check_suite;
  if (suite.conclusion !== "failure") return { handled: false, reason: "not a failure" };
  if (suite.app?.slug === "code-amauta") return { handled: false, reason: "bot's own check suite" };

  const owner = body.repository.owner.login;
  const repo = body.repository.name;
  const headBranch = suite.head_branch;

  const appToken = await getInstallationToken(owner, repo);
  if (!appToken) return { handled: false, reason: "could not mint app token" };

  // Find the associated PR
  let prNumber: number | undefined;
  let prTitle: string | undefined;
  try {
    const res = await ghGet(
      `/repos/${owner}/${repo}/pulls?head=${owner}:${headBranch}&state=open&per_page=1`,
      appToken
    );
    if (res.ok) {
      const prs = (await res.json()) as { number: number; title: string }[];
      if (prs.length > 0) {
        prNumber = prs[0].number;
        prTitle = prs[0].title;
      }
    }
  } catch {}

  if (!prNumber) return { handled: false, reason: `no open PR for branch ${headBranch}` };

  const progressId = await createProgressComment(owner, repo, prNumber, appToken);

  const payload: Record<string, unknown> = {
    "~pullfrog": true,
    version: "0.1.0",
    prompt: "CI failed — read the logs and fix the failure",
    event: {
      trigger: "check_suite_completed",
      issue_number: prNumber,
      is_pr: true,
      title: prTitle,
      body: null,
      branch: headBranch,
      check_suite: {
        id: suite.id,
        head_sha: suite.head_sha,
        head_branch: headBranch,
        status: "completed",
        conclusion: suite.conclusion,
        url: suite.url,
      },
    },
    ...(progressId ? { progressComment: { id: progressId, type: "issue" } } : {}),
  };

  const ok = await dispatch(owner, repo, payload, `Fix CI — #${prNumber}`, appToken);
  return { handled: ok };
}

async function handleIssuesAssigned(body: any): Promise<WebhookResult> {
  const assignee = body.assignee;
  if (assignee?.login !== BOT_LOGIN) return { handled: false, reason: "not assigned to bot" };

  const owner = body.repository.owner.login;
  const repo = body.repository.name;
  const issue = body.issue;

  const appToken = await getInstallationToken(owner, repo);
  if (!appToken) return { handled: false, reason: "could not mint app token" };

  const progressId = await createProgressComment(owner, repo, issue.number, appToken);

  const payload: Record<string, unknown> = {
    "~pullfrog": true,
    version: "0.1.0",
    prompt: `Assigned issue: ${issue.title}\n\n${issue.body ?? ""}`,
    event: {
      trigger: "issues_assigned",
      issue_number: issue.number,
      title: issue.title,
      body: null,
    },
    ...(progressId ? { progressComment: { id: progressId, type: "issue" } } : {}),
  };

  const ok = await dispatch(owner, repo, payload, `Issue #${issue.number} — ${issue.title}`, appToken);
  return { handled: ok };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function webhookHandler(c: Context) {
  // ── verify signature ────────────────────────────────────────────────────
  if (!config.webhookSecret) {
    return c.json({ error: "WEBHOOK_SECRET not configured" }, 503);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";

  if (!verifySignature(rawBody, signature)) {
    console.warn("[webhook] invalid signature");
    return c.json({ error: "invalid signature" }, 401);
  }

  const event = c.req.header("x-github-event");
  const body = JSON.parse(rawBody);
  const action = body.action;

  console.log(
    `[webhook] ${event}.${action} from ${body.repository?.full_name ?? "unknown"}`
  );

  let result: WebhookResult;

  switch (event) {
    case "pull_request":
      result = await handlePullRequest(body);
      break;
    case "issue_comment":
      result = await handleIssueComment(body);
      break;
    case "pull_request_review":
      result = await handlePullRequestReview(body);
      break;
    case "pull_request_review_comment":
      result = await handlePullRequestReviewComment(body);
      break;
    case "check_suite":
      result = await handleCheckSuite(body);
      break;
    case "issues":
      if (action === "assigned") {
        result = await handleIssuesAssigned(body);
      } else {
        result = { handled: false, reason: `issues.${action} not handled` };
      }
      break;
    case "ping":
      console.log("[webhook] ping received — webhook is configured correctly");
      result = { handled: true };
      break;
    default:
      result = { handled: false, reason: `event '${event}' not handled` };
  }

  if (!result.handled && result.reason) {
    console.log(`[webhook] skipped: ${result.reason}`);
  }

  return c.json({ handled: result.handled, reason: result.reason });
}
