/**
 * Pullfrog Self-Hosted API Server
 *
 * Drop-in replacement for pullfrog.com — set API_URL to this server's
 * address and all run-context, learnings, usage tracking, file uploads,
 * and secret storage work locally. No billing, no run limits, no telemetry.
 *
 * Usage:
 *   SELF_HOST_SECRET=<random-hex> npm start
 *
 * Then in your GitHub Actions workflow:
 *   env:
 *     API_URL: https://your-server.example.com
 *     CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config.ts";

// auth middleware
import { requireAdmin, requireAuth } from "./auth.ts";

// route handlers
import {
  getRepoHandler,
  getLearningsHandler,
  getUsageHandler,
  listReposHandler,
  listSecretsHandler,
  updateRepoHandler,
} from "./routes/admin.ts";
import {
  cliDispatchHandler,
  cliSessionCreateHandler,
  cliSessionDeleteHandler,
  cliSessionGetHandler,
  cliSetupHandler,
} from "./routes/cli.ts";
import { installationTokenHandler } from "./routes/installationToken.ts";
import { learningsHandler } from "./routes/learnings.ts";
import { planCommentGetHandler, planCommentUpsertHandler } from "./routes/planComment.ts";
import { runContextHandler } from "./routes/runContext.ts";
import {
  cliSecretsGetHandler,
  cliSecretsPostHandler,
  runtimeSecretHandler,
} from "./routes/secrets.ts";
import { summaryGetHandler } from "./routes/summary.ts";
import { triggerHandler } from "./routes/trigger.ts";
import {
  signedUrlHandler,
  uploadGetHandler,
  uploadPutHandler,
} from "./routes/upload.ts";
import { workflowRunHandler } from "./routes/workflowRun.ts";

const app = new Hono();

// ── middleware ───────────────────────────────────────────────────────────────

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Authorization", "Content-Type", "X-GitHub-OIDC-Token"],
  })
);

// ── health ──────────────────────────────────────────────────────────────────

app.get("/", (c) =>
  c.json({
    name: "pullfrog-self-host",
    version: "1.0.0",
    status: "ok",
    docs: "https://github.com/pullfrog/pullfrog/tree/main/self-host",
  })
);

app.get("/health", (c) => c.text("ok"));

// ── action runtime endpoints ────────────────────────────────────────────────
// these are called by the Pullfrog GitHub Action during each run

// run context — the critical one (settings, secrets, JWT)
app.get("/api/repo/:owner/:repo/run-context", requireAuth, runContextHandler);

// learnings persistence
app.patch("/api/repo/:owner/:repo/learnings", requireAuth, learningsHandler);

// workflow run usage tracking
app.patch("/api/workflow-run/:runId", requireAuth, workflowRunHandler);

// PR summary snapshots
app.get("/api/repo/:owner/:repo/pr/:prNumber/summary-comment", requireAuth, summaryGetHandler);

// plan comment lookup
app.get("/api/repo/:owner/:repo/issue/:issueNumber/plan-comment", requireAuth, planCommentGetHandler);
app.post(
  "/api/repo/:owner/:repo/issue/:issueNumber/plan-comment",
  requireAuth,
  planCommentUpsertHandler
);

// file uploads
app.post("/api/upload/signed-url", requireAuth, signedUrlHandler);
app.put("/api/uploads/:token/:filename", requireAuth, uploadPutHandler);
app.get("/api/uploads/:filename", requireAuth, uploadGetHandler);

// GitHub App installation token (the action sends OIDC or job tokens here)
app.post("/api/github/installation-token", requireAuth, installationTokenHandler);

// runtime secret persistence (Codex auth refresh)
app.put("/api/runtime/secret", requireAuth, runtimeSecretHandler);

// ── CLI endpoints ───────────────────────────────────────────────────────────
// used by `pullfrog init` and `pullfrog auth`

app.get("/api/cli/secrets", requireAuth, cliSecretsGetHandler);
app.post("/api/cli/secrets", requireAuth, cliSecretsPostHandler);
app.post("/api/cli/setup", requireAuth, cliSetupHandler);
app.post("/api/cli/dispatch", requireAuth, cliDispatchHandler);
app.post("/api/cli/session", requireAuth, cliSessionCreateHandler);
app.get("/api/cli/session/:id", requireAuth, cliSessionGetHandler);
app.delete("/api/cli/session/:id", requireAuth, cliSessionDeleteHandler);

// ── admin endpoints ─────────────────────────────────────────────────────────
// manage repo settings and view usage — not called by the action

app.get("/api/admin/repos", requireAdmin, listReposHandler);
app.get("/api/admin/repos/:owner/:repo", requireAdmin, getRepoHandler);
app.put("/api/admin/repos/:owner/:repo", requireAdmin, updateRepoHandler);
app.get("/api/admin/repos/:owner/:repo/learnings", requireAdmin, getLearningsHandler);
app.get("/api/admin/repos/:owner/:repo/usage", requireAdmin, getUsageHandler);
app.get("/api/admin/secrets/:owner", requireAdmin, listSecretsHandler);

// ── trigger endpoint (Fix button in review footers) ───────────────────────────
// public — clicked from a browser link in a GitHub review comment.
// dispatches a workflow_dispatch event with a fix_review payload.

app.get("/trigger/:owner/:repo/:pr", triggerHandler);

// ── catch-all for unknown routes ────────────────────────────────────────────
// return 200 with empty body for unknown routes so the action's best-effort
// calls don't trigger error logs. the action already handles non-2xx
// gracefully, but a clean 200 is quieter in CI logs.

app.all("/api/*", requireAuth, (c) => {
  console.log(`[catch-all] ${c.req.method} ${c.req.path} → 200 (no-op)`);
  return c.json({});
});

// ── start server ────────────────────────────────────────────────────────────

console.log(`
┌─────────────────────────────────────────────────────┐
│                                                     │
│   🐸 Pullfrog Self-Hosted Server                    │
│                                                     │
│   Port:     ${String(config.port).padEnd(39)}│
│   Data:     ${config.dataDir.padEnd(39)}│
│   URL:      ${config.publicUrl.padEnd(39)}│
│                                                     │
│   No run limits. No telemetry. Full privacy.        │
│                                                     │
│   Set in your workflow:                             │
│     env:                                            │
│       API_URL: ${config.publicUrl.padEnd(35)}│
│                                                     │
└─────────────────────────────────────────────────────┘
`);

serve({ fetch: app.fetch, port: config.port });
