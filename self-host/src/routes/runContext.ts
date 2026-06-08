/**
 * GET /api/repo/:owner/:repo/run-context
 *
 * The most important endpoint — called at the start of every run.
 * Returns repo settings, a JWT for subsequent API calls, and the
 * DB-stored secrets to inject into the agent's environment.
 *
 * Original Pullfrog server enforces billing/quota here. We don't.
 * plan: "payg" so the action never sees a free-tier gate.
 * oss: false (irrelevant for self-host, controls proxy routing).
 * proxyModel: undefined (BYOK — no proxy needed).
 */

import type { Context } from "hono";
import { signJwt } from "../auth.ts";
import { db, stmts } from "../db.ts";

/** Parse the markdown learnings body into a heading TOC (same structure the
 *  action expects in `RepoSettings.learningsHeadings`). */
function parseLearningsHeadings(
  body: string
): { depth: number; title: string; startLine: number; endLine: number }[] {
  if (!body) return [];
  const lines = body.split("\n");
  const headings: { depth: number; title: string; startLine: number; endLine: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({
        depth: match[1].length,
        title: match[2].trim(),
        startLine: i + 1,
        endLine: 0, // filled below
      });
    }
  }
  // fill endLine: each heading extends to the line before the next heading (or EOF)
  for (let i = 0; i < headings.length; i++) {
    headings[i].endLine =
      i + 1 < headings.length ? headings[i + 1].startLine - 1 : lines.length;
  }
  return headings;
}

export function runContextHandler(c: Context) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  // load repo settings (or use defaults)
  const row = stmts.getSettings.get(owner, repo) as Record<string, unknown> | undefined;

  // load learnings
  const learningsRow = stmts.getLearnings.get(owner, repo) as
    | { body: string }
    | undefined;
  const learnings = learningsRow?.body || null;
  const learningsHeadings = learnings ? parseLearningsHeadings(learnings) : [];

  // load DB secrets for this repo (both repo-scoped and account-scoped)
  const dbSecrets: Record<string, string> = {};
  const repoSecrets = stmts.getSecrets.all(owner, repo) as { name: string; value: string }[];
  for (const s of repoSecrets) {
    dbSecrets[s.name] = s.value;
  }
  const accountSecrets = stmts.getAccountSecrets.all(owner) as { name: string; value: string }[];
  for (const s of accountSecrets) {
    // repo-scoped secrets take precedence
    if (!(s.name in dbSecrets)) {
      dbSecrets[s.name] = s.value;
    }
  }

  // parse mode instructions from JSON
  let modeInstructions: Record<string, string> = {};
  if (row?.mode_instructions) {
    try {
      modeInstructions = JSON.parse(row.mode_instructions as string);
    } catch {
      // ignore malformed JSON
    }
  }

  // issue a JWT valid for 2 hours (covers the longest agent runs)
  const apiToken = signJwt({ owner, repo, scope: "run" }, 7200);

  return c.json({
    settings: {
      model: (row?.model as string) ?? null,
      modes: [],
      setupScript: (row?.setup_script as string) ?? null,
      postCheckoutScript: (row?.post_checkout as string) ?? null,
      prepushScript: (row?.prepush as string) ?? null,
      stopScript: (row?.stop_script as string) ?? null,
      push: (row?.push as string) ?? "restricted",
      shell: (row?.shell as string) ?? "restricted",
      prApproveEnabled: row?.pr_approve === 1,
      modeInstructions,
      learnings,
      learningsHeadings,
      envAllowlist: (row?.env_allowlist as string) ?? null,
    },
    apiToken,
    // self-host: no billing limits. "payg" signals to the action that this
    // account has paid — bypasses any client-side free-tier guards.
    oss: false,
    plan: "payg",
    // no proxy — BYOK only. proxyModel being absent means the action skips
    // the /api/proxy-token mint entirely.
    proxyModel: undefined,
    // inject DB secrets into the agent's environment
    dbSecrets: Object.keys(dbSecrets).length > 0 ? dbSecrets : undefined,
  });
}
