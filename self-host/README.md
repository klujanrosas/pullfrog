# Pullfrog Self-Hosted Server

Drop-in replacement for `pullfrog.com` — run the entire Pullfrog stack on your own infrastructure with **no run limits, no telemetry, and full privacy**.

## Why

The hosted Pullfrog service limits free-tier accounts to 30 runs/month and charges 7¢ per additional run — even when you bring your own API key. This self-hosted server removes that dependency entirely. Your LLM calls go directly to Anthropic (or whatever provider you configure), and the metadata stays on your machine.

## What it replaces

| Feature | Hosted (pullfrog.com) | Self-hosted |
|---|---|---|
| Run limits | 30/month free, then 7¢/run | **Unlimited** |
| Repo settings | Web dashboard | Admin API + SQLite |
| Learnings | Pullfrog DB | Local SQLite |
| PR summaries | Pullfrog DB | Local SQLite |
| File uploads | Pullfrog CDN | Local filesystem |
| Secret store | Pullfrog encrypted store | Local SQLite |
| Usage tracking | Pullfrog analytics | Local SQLite |
| Billing/proxy | OpenRouter proxy | N/A (BYOK only) |

## Quick start

```bash
cd self-host

# Install dependencies
npm install

# Generate a secret
export SELF_HOST_SECRET=$(openssl rand -hex 32)

# Start the server
npm run dev
```

The server starts on port 3456. All data is stored in `./data/pullfrog.db`.

## Deploy with Docker

```bash
# Create .env from example
cp .env.example .env
# Edit .env — set SELF_HOST_SECRET and PUBLIC_URL

docker compose up -d
```

## Wire up your GitHub Actions workflow

```yaml
# .github/workflows/pullfrog.yml
name: Pullfrog
on:
  workflow_dispatch:
    inputs:
      prompt:
        type: string
        description: Agent prompt

permissions:
  contents: read

jobs:
  pullfrog:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: pullfrog/pullfrog@main
        with:
          prompt: ${{ inputs.prompt }}
        env:
          # Point to your self-hosted server
          API_URL: https://your-server.example.com

          # Your LLM credentials (Claude Max subscription)
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

          # Or use an API key instead
          # ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The critical change is `API_URL` — that's all it takes to redirect every API call from `pullfrog.com` to your server.

## Authentication

All `/api/*` routes require authentication. There are two tiers:

| Tier | Routes | Accepts |
|---|---|---|
| **requireAuth** | `/api/*` (runtime + CLI) | JWT (from run-context) · `SELF_HOST_SECRET` · valid GitHub token |
| **requireAdmin** | `/api/admin/*` | `SELF_HOST_SECRET` only |
| _(public)_ | `/`, `/health` | No auth required |

**How it works:**

1. The GitHub Action calls `run-context` with its job token → verified via GitHub API → server returns a JWT
2. All subsequent action calls use that JWT → verified locally (fast, no API call)
3. Admin `curl` commands use `SELF_HOST_SECRET` as a bearer token
4. CLI commands (`pullfrog init`) send the user's GitHub OAuth token → verified via GitHub API

This means **no changes** are needed to your GitHub Actions workflow — the action already sends the right tokens.

## Configure repo settings

Use the admin API to configure per-repo settings. Admin routes require `SELF_HOST_SECRET`:

```bash
# Set model + permissions for a repo
curl -X PUT http://localhost:3456/api/admin/repos/your-org/your-repo \
  -H "Authorization: Bearer $SELF_HOST_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "anthropic/claude-opus",
    "push": "restricted",
    "shell": "restricted",
    "setupScript": "npm install",
    "prApproveEnabled": false,
    "modeInstructions": {
      "Review": "Focus on security and correctness."
    }
  }'

# Store a secret (injected into agent env at runtime)
curl -X POST http://localhost:3456/api/cli/secrets \
  -H "Authorization: Bearer $SELF_HOST_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "owner": "your-org",
    "repo": "your-repo",
    "name": "ANTHROPIC_API_KEY",
    "value": "sk-ant-..."
  }'

# View accumulated learnings
curl -H "Authorization: Bearer $SELF_HOST_SECRET" \
  http://localhost:3456/api/admin/repos/your-org/your-repo/learnings

# View usage stats
curl -H "Authorization: Bearer $SELF_HOST_SECRET" \
  http://localhost:3456/api/admin/repos/your-org/your-repo/usage

# List all configured repos
curl -H "Authorization: Bearer $SELF_HOST_SECRET" \
  http://localhost:3456/api/admin/repos
```

## Architecture

```
GitHub Actions runner
  │
  ├─ Pullfrog Action (pullfrog/pullfrog@main)
  │   │
  │   ├─ GET  /api/repo/:owner/:repo/run-context    → settings, JWT, secrets
  │   ├─ PATCH /api/repo/:owner/:repo/learnings      → persist learnings
  │   ├─ PATCH /api/workflow-run/:runId               → track usage
  │   ├─ GET  /api/repo/.../summary-comment           → PR summary snapshots
  │   ├─ GET  /api/repo/.../plan-comment              → plan comment lookup
  │   ├─ POST /api/upload/signed-url                  → file uploads
  │   └─ PUT  /api/runtime/secret                     → Codex token refresh
  │
  └─ Claude Code / OpenCode CLI
      └─ Anthropic API (your key, direct)
```

All API calls that the action makes to `pullfrog.com` are redirected to your server via the `API_URL` env var. The LLM calls go directly to the provider — they never touch this server.

## Data

Everything lives in `DATA_DIR` (default: `./data`):

- `pullfrog.db` — SQLite database (settings, learnings, usage, secrets)
- `uploads/` — uploaded files (screenshots, artifacts)

Back up this directory to preserve your data.

## Exposing to GitHub Actions

Your self-hosted server needs to be reachable from GitHub Actions runners. Options:

1. **Cloudflare Tunnel** (recommended) — `cloudflared tunnel` exposes localhost to a public URL with built-in TLS. Zero firewall changes.
2. **Tailscale** — if your runners are on Tailscale, use the Tailscale IP directly.
3. **VPS** — deploy to a VPS with a public IP and point a domain at it.
4. **Self-hosted runners** — if you run GitHub Actions on your own machines, `localhost:3456` works.

> **Note:** The action enforces `https://` for non-localhost `API_URL` to prevent sending secrets in cleartext. Use a TLS-terminating reverse proxy (nginx, caddy, cloudflared) in production.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SELF_HOST_SECRET` | Yes | (random) | JWT signing secret. Generate with `openssl rand -hex 32`. |
| `PORT` | No | `3456` | Server port |
| `DATA_DIR` | No | `./data` | Directory for database + uploads |
| `PUBLIC_URL` | No | `http://localhost:3456` | Externally-reachable URL (for upload links) |

## Security notes

- **Keep `SELF_HOST_SECRET` safe** — it's the master key for admin access and JWT signing.
- **Use TLS** — tokens are sent as bearer headers. Use a TLS-terminating proxy (cloudflared, caddy, nginx) in production.
- The action's initial `run-context` call verifies the GitHub job token against the GitHub API. Subsequent calls use a short-lived JWT (2h expiry) — no more GitHub API round-trips.
- Admin routes (`/api/admin/*`) only accept `SELF_HOST_SECRET` — a compromised GitHub token can't modify repo settings.

## Compared to just removing API_URL

You _can_ run Pullfrog without any server — the action gracefully degrades when API calls fail. But you lose learnings persistence, PR summary continuity, file uploads, and usage tracking. This server gives you everything back, under your control.
