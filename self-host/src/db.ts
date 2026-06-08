/**
 * SQLite persistence layer — single file, zero infrastructure.
 *
 * Tables:
 *   repo_settings     — per-repo model/push/shell/scripts config
 *   learnings         — per-repo rolling learnings (markdown)
 *   learnings_revisions — history of learnings edits
 *   workflow_runs     — usage tracking (tokens, cost, artifacts)
 *   summary_snapshots — per-PR summary persistence across runs
 *   plan_comments     — plan comment tracking (issue → comment mapping)
 *   secrets           — encrypted per-repo secrets store
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.ts";

if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}

const dbPath = join(config.dataDir, "pullfrog.db");
export const db = new Database(dbPath);

// WAL mode for concurrent reads during writes
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS repo_settings (
    owner         TEXT NOT NULL,
    repo          TEXT NOT NULL,
    model         TEXT,
    push          TEXT DEFAULT 'restricted',
    shell         TEXT DEFAULT 'restricted',
    setup_script  TEXT,
    post_checkout TEXT,
    prepush       TEXT,
    stop_script   TEXT,
    pr_approve    INTEGER DEFAULT 0,
    mode_instructions TEXT DEFAULT '{}',
    env_allowlist TEXT,
    updated_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (owner, repo)
  );

  CREATE TABLE IF NOT EXISTS learnings (
    owner   TEXT NOT NULL,
    repo    TEXT NOT NULL,
    body    TEXT DEFAULT '',
    updated TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (owner, repo)
  );

  CREATE TABLE IF NOT EXISTS learnings_revisions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    owner   TEXT NOT NULL,
    repo    TEXT NOT NULL,
    body    TEXT NOT NULL,
    model   TEXT,
    created TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id             INTEGER PRIMARY KEY,
    owner              TEXT,
    repo               TEXT,
    pr_node_id         TEXT,
    issue_node_id      TEXT,
    review_node_id     TEXT,
    plan_comment_id    TEXT,
    summary_snapshot   TEXT,
    input_tokens       INTEGER DEFAULT 0,
    output_tokens      INTEGER DEFAULT 0,
    cache_read_tokens  INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    cost_usd           REAL DEFAULT 0,
    created            TEXT DEFAULT (datetime('now')),
    updated            TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS summary_snapshots (
    owner       TEXT NOT NULL,
    repo        TEXT NOT NULL,
    pr_number   INTEGER NOT NULL,
    snapshot    TEXT,
    updated     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (owner, repo, pr_number)
  );

  CREATE TABLE IF NOT EXISTS plan_comments (
    owner        TEXT NOT NULL,
    repo         TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    comment_id   INTEGER NOT NULL,
    body         TEXT,
    updated      TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (owner, repo, issue_number)
  );

  CREATE TABLE IF NOT EXISTS secrets (
    owner   TEXT NOT NULL,
    repo    TEXT NOT NULL,
    name    TEXT NOT NULL,
    value   TEXT NOT NULL,
    scope   TEXT DEFAULT 'repo',
    updated TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (owner, repo, name)
  );

  CREATE TABLE IF NOT EXISTS account_secrets (
    owner   TEXT NOT NULL,
    name    TEXT NOT NULL,
    value   TEXT NOT NULL,
    updated TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (owner, name)
  );
`);

// ── prepared statements ─────────────────────────────────────────────────────

export const stmts = {
  // repo settings
  getSettings: db.prepare(
    "SELECT * FROM repo_settings WHERE owner = ? AND repo = ?"
  ),
  upsertSettings: db.prepare(`
    INSERT INTO repo_settings (owner, repo, model, push, shell, setup_script, post_checkout, prepush, stop_script, pr_approve, mode_instructions, env_allowlist)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner, repo) DO UPDATE SET
      model = excluded.model, push = excluded.push, shell = excluded.shell,
      setup_script = excluded.setup_script, post_checkout = excluded.post_checkout,
      prepush = excluded.prepush, stop_script = excluded.stop_script,
      pr_approve = excluded.pr_approve, mode_instructions = excluded.mode_instructions,
      env_allowlist = excluded.env_allowlist, updated_at = datetime('now')
  `),

  // learnings
  getLearnings: db.prepare(
    "SELECT body FROM learnings WHERE owner = ? AND repo = ?"
  ),
  upsertLearnings: db.prepare(`
    INSERT INTO learnings (owner, repo, body) VALUES (?, ?, ?)
    ON CONFLICT(owner, repo) DO UPDATE SET body = excluded.body, updated = datetime('now')
  `),
  insertLearningsRevision: db.prepare(
    "INSERT INTO learnings_revisions (owner, repo, body, model) VALUES (?, ?, ?, ?)"
  ),

  // workflow runs
  getWorkflowRun: db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?"),
  upsertWorkflowRun: db.prepare(`
    INSERT INTO workflow_runs (run_id, owner, repo) VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO NOTHING
  `),

  // summaries
  getSummary: db.prepare(
    "SELECT snapshot FROM summary_snapshots WHERE owner = ? AND repo = ? AND pr_number = ?"
  ),
  upsertSummary: db.prepare(`
    INSERT INTO summary_snapshots (owner, repo, pr_number, snapshot) VALUES (?, ?, ?, ?)
    ON CONFLICT(owner, repo, pr_number) DO UPDATE SET snapshot = excluded.snapshot, updated = datetime('now')
  `),

  // plan comments
  getPlanComment: db.prepare(
    "SELECT comment_id, body FROM plan_comments WHERE owner = ? AND repo = ? AND issue_number = ?"
  ),
  upsertPlanComment: db.prepare(`
    INSERT INTO plan_comments (owner, repo, issue_number, comment_id, body) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner, repo, issue_number) DO UPDATE SET comment_id = excluded.comment_id, body = excluded.body, updated = datetime('now')
  `),

  // secrets (repo-scoped)
  getSecrets: db.prepare(
    "SELECT name, value FROM secrets WHERE owner = ? AND repo = ?"
  ),
  getSecret: db.prepare(
    "SELECT value FROM secrets WHERE owner = ? AND repo = ? AND name = ?"
  ),
  upsertSecret: db.prepare(`
    INSERT INTO secrets (owner, repo, name, value, scope) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner, repo, name) DO UPDATE SET value = excluded.value, scope = excluded.scope, updated = datetime('now')
  `),
  listSecretNames: db.prepare(
    "SELECT name FROM secrets WHERE owner = ? AND repo = ?"
  ),

  // secrets (account-scoped — shared across all repos for an owner)
  getAccountSecrets: db.prepare(
    "SELECT name, value FROM account_secrets WHERE owner = ?"
  ),
  upsertAccountSecret: db.prepare(`
    INSERT INTO account_secrets (owner, name, value) VALUES (?, ?, ?)
    ON CONFLICT(owner, name) DO UPDATE SET value = excluded.value, updated = datetime('now')
  `),
  listAccountSecretNames: db.prepare(
    "SELECT name FROM account_secrets WHERE owner = ?"
  ),
};
