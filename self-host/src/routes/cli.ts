/**
 * CLI setup endpoints — used by `pullfrog init`.
 *
 * POST /api/cli/setup    — create pullfrog.yml (we just acknowledge)
 * POST /api/cli/dispatch  — trigger a test run
 * POST /api/cli/session   — installation polling sessions (no-op for self-host)
 * GET  /api/cli/session/:id — poll session (no-op)
 * DELETE /api/cli/session/:id — cleanup session (no-op)
 */

import type { Context } from "hono";

/**
 * POST /api/cli/setup
 * The CLI asks the server to create a pullfrog.yml workflow via the GitHub API.
 * For self-hosting, we return already_existed: true and let the user manage
 * their own workflow file.
 */
export async function cliSetupHandler(c: Context) {
  return c.json({
    success: true,
    already_existed: true,
  });
}

/**
 * POST /api/cli/dispatch
 * Trigger a test run via workflow_dispatch. For self-hosting, return a
 * helpful message pointing the user to do it manually.
 */
export async function cliDispatchHandler(c: Context) {
  return c.json({
    error: "dispatch not available — trigger the workflow manually via GitHub Actions UI or `gh workflow run`",
  }, 501);
}

/**
 * POST /api/cli/session
 * Installation polling session — not needed for self-hosting.
 */
export function cliSessionCreateHandler(c: Context) {
  return c.json({ id: "self-host-noop", installed: true });
}

/**
 * GET /api/cli/session/:id
 */
export function cliSessionGetHandler(c: Context) {
  return c.json({ installed: true });
}

/**
 * DELETE /api/cli/session/:id
 */
export function cliSessionDeleteHandler(c: Context) {
  return c.json({ success: true });
}
