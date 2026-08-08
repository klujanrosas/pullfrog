/** Codex subscription token refresh for the self-hosted runtime. */

export interface CodexAuthBody {
  auth_mode: "chatgpt";
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

const refreshInFlight = new Map<string, Promise<string | null>>();

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
}

/** Refresh a Codex auth.json value and return its canonical JSON form.
 * Returns null for malformed credentials; network and OAuth failures throw so
 * the caller can leave the stored value untouched and report the original error. */
export async function refreshCodexAuthJson(raw: string): Promise<string | null> {
  const existing = refreshInFlight.get(raw);
  if (existing) return existing;

  const operation = refreshCodexAuthJsonUncoordinated(raw);
  refreshInFlight.set(raw, operation);
  try {
    return await operation;
  } finally {
    refreshInFlight.delete(raw);
  }
}

async function refreshCodexAuthJsonUncoordinated(raw: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.auth_mode !== "chatgpt" || !value.tokens || typeof value.tokens !== "object") {
    return null;
  }

  const tokens = value.tokens as Record<string, unknown>;
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) return null;
  if (typeof tokens.access_token !== "string" || !tokens.access_token) return null;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Codex token refresh failed: ${response.status}`);
  }

  const refreshed = (await response.json()) as OAuthTokenResponse;
  if (!refreshed.access_token || !refreshed.refresh_token) {
    throw new Error("Codex token refresh returned incomplete credentials");
  }
  const body: CodexAuthBody = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      ...(refreshed.id_token
        ? { id_token: refreshed.id_token }
        : typeof tokens.id_token === "string"
          ? { id_token: tokens.id_token }
          : {}),
      ...(typeof tokens.account_id === "string" ? { account_id: tokens.account_id } : {}),
    },
    last_refresh: new Date().toISOString(),
  };

  return `${JSON.stringify(body, null, 2)}\n`;
}
