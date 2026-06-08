/**
 * Slug we fall back to when a BYOK-required model is configured but the
 * runner has no provider key in env. Picked because it's free, stable, and
 * currently served by OpenCode Zen without a key.
 *
 * The slug is intentionally hard-coded and not a config knob — the
 * fallback is a safety net, not a user-facing preference, and adding a
 * config surface here would just push the same "what to fall back to"
 * decision into another setting that goes stale the same way.
 */
export const FREE_FALLBACK_SLUG = "opencode/big-pickle";

export type FallbackDecision = { fallback: false } | { fallback: true; from: string; to: string };

/**
 * True when the runner has credentials that Claude Code (the Anthropic
 * first-party agent) can consume — `CLAUDE_CODE_OAUTH_TOKEN` or
 * `ANTHROPIC_API_KEY`. These tokens are invisible to `opencode models`
 * (OpenCode is a different CLI) so they won't appear in the `authorized`
 * set, but `resolveAgent` will correctly route the model to the claude
 * agent which *does* use them.
 */
function hasClaudeCodeAuth(): boolean {
  const has = (k: string) => {
    const v = process.env[k];
    return typeof v === "string" && v.length > 0;
  };
  return has("CLAUDE_CODE_OAUTH_TOKEN") || has("ANTHROPIC_API_KEY");
}

/**
 * If the resolved model is NOT in OpenCode's `authorized` set (the
 * authoritative "what can OpenCode route right now" snapshot captured
 * after dbSecrets + Codex auth.json are in place), swap to a free
 * OpenCode slug so the run can still produce value. Caller is responsible
 * for surfacing the swap (log line + run summary).
 *
 * Skip cases (return `fallback: false` without consulting `authorized`):
 *   - Router / proxy runs (`proxyModel` set): Pullfrog mints the key.
 *   - No resolved model: auto-select handles it downstream.
 *   - Resolved model is the free fallback already.
 *   - Resolved model is a raw Bedrock / Vertex ID (no `/`): the routing
 *     validators (`validateBedrockSetup` / `validateVertexSetup`) cover
 *     auth + region/location/model-id; `opencode models` does not.
 *   - Resolved model is `anthropic/*` AND Claude Code credentials exist:
 *     `opencode models` doesn't recognise `CLAUDE_CODE_OAUTH_TOKEN`, but
 *     `resolveAgent` will route these models to the claude agent which
 *     authenticates natively with that token. Without this skip, every
 *     OAuth-only Anthropic run would spuriously fall back.
 */
export function selectFallbackModelIfNeeded(input: {
  resolvedModel: string | undefined;
  proxyModel: string | undefined;
  authorized: Set<string>;
}): FallbackDecision {
  if (input.proxyModel) return { fallback: false };
  if (!input.resolvedModel) return { fallback: false };
  if (input.resolvedModel === FREE_FALLBACK_SLUG) return { fallback: false };
  if (!input.resolvedModel.includes("/")) return { fallback: false };
  if (input.authorized.has(input.resolvedModel)) return { fallback: false };

  // Anthropic models can be served by Claude Code (which uses
  // CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY natively). `opencode
  // models` doesn't see these credentials, so the `authorized` set will
  // miss them — but resolveAgent will route correctly.
  if (input.resolvedModel.startsWith("anthropic/") && hasClaudeCodeAuth()) {
    return { fallback: false };
  }

  return {
    fallback: true,
    from: input.resolvedModel,
    to: FREE_FALLBACK_SLUG,
  };
}
