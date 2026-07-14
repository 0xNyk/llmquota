import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ProviderSnapshot } from "../types.js";
import { availableInFromEpoch, fetchJson, home, isoFromEpochSec } from "../util.js";
import { detectGrok } from "./detect.js";

interface GrokAuthEntry {
  key?: string;
  email?: string;
  expires_at?: string;
  auth_mode?: string;
  refresh_token?: string;
  first_name?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  [k: string]: unknown;
}

interface GrokAuthStore {
  path: string;
  key: string;
  entry: GrokAuthEntry;
  raw: Record<string, GrokAuthEntry>;
}

function readGrokAuthStore(): GrokAuthStore | null {
  const path = home(".grok", "auth.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, GrokAuthEntry>;
    const key = Object.keys(raw)[0];
    if (!key) return null;
    return { path, key, entry: raw[key]!, raw };
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function accessExpired(entry: GrokAuthEntry, skewSec = 120): boolean {
  if (entry.key) {
    const claims = decodeJwtPayload(entry.key);
    const exp = typeof claims?.exp === "number" ? claims.exp : null;
    if (exp != null) return exp * 1000 <= Date.now() + skewSec * 1000;
  }
  if (entry.expires_at) {
    const t = Date.parse(entry.expires_at);
    if (!Number.isNaN(t)) return t <= Date.now() + skewSec * 1000;
  }
  return false;
}

async function refreshGrokAccess(store: GrokAuthStore): Promise<{ ok: boolean; error?: string }> {
  const entry = store.entry;
  const refreshToken = entry.refresh_token;
  if (!refreshToken) return { ok: false, error: "no refresh_token in ~/.grok/auth.json" };

  const issuer = (entry.oidc_issuer || "https://auth.x.ai").replace(/\/$/, "");
  const clientId =
    entry.oidc_client_id ||
    (store.key.includes("::") ? store.key.split("::")[1] : undefined);
  if (!clientId) return { ok: false, error: "missing oidc_client_id" };

  // Prefer well-known token endpoint; fall back to /oauth2/token
  let tokenUrl = `${issuer}/oauth2/token`;
  try {
    const disc = await fetchJson(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json", "User-Agent": "llmquota/0.1" },
      timeoutMs: 8000,
    });
    const ep = (disc.json as { token_endpoint?: string } | null)?.token_endpoint;
    if (disc.ok && ep) tokenUrl = ep;
  } catch {
    /* use fallback */
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const res = await fetchJson(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "llmquota/0.1",
    },
    body: body.toString(),
  });

  if (!res.ok || !res.json || typeof res.json !== "object") {
    const desc =
      (res.json as { error_description?: string; error?: string } | null)?.error_description ||
      (res.json as { error?: string } | null)?.error ||
      res.text.slice(0, 160);
    return { ok: false, error: `refresh failed HTTP ${res.status}: ${desc}` };
  }

  const data = res.json as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) return { ok: false, error: "refresh response missing access_token" };

  entry.key = data.access_token;
  if (data.refresh_token) entry.refresh_token = data.refresh_token;
  if (data.expires_in != null) {
    entry.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }

  store.raw[store.key] = entry;
  writeFileSync(store.path, `${JSON.stringify(store.raw, null, 2)}\n`, { mode: 0o600 });
  return { ok: true };
}

export async function collectGrok(): Promise<ProviderSnapshot> {
  const bin = detectGrok();
  const base: ProviderSnapshot = {
    id: "grok",
    displayName: "Grok",
    installed: bin.installed,
    binary: bin.path,
    version: bin.version,
    auth: "missing",
    plan: null,
    subscription: null,
    account: null,
    windows: [],
    source: "none",
    error: null,
    hint: null,
    referral: null,
    score: null,
  };

  if (!bin.installed) {
    base.hint = "Install Grok Build CLI, then `grok login`.";
    return base;
  }

  const store = readGrokAuthStore();
  if (!store?.entry.key && !store?.entry.refresh_token) {
    base.hint = "Run `grok login`.";
    return base;
  }

  let entry = store!.entry;
  base.account = (entry.email as string) || null;

  if (accessExpired(entry)) {
    const refreshed = await refreshGrokAccess(store!);
    if (!refreshed.ok) {
      base.auth = "expired";
      base.error = refreshed.error || "token refresh failed";
      const claims = entry.key ? decodeJwtPayload(entry.key) : null;
      const tier = typeof claims?.tier === "number" ? claims.tier : null;
      base.plan = tier != null ? `tier ${tier}` : null;
      base.subscription =
        tier != null ? `Grok · xAI API tier ${tier}` : "Grok · OIDC (expired)";
      base.hint =
        "Access JWT expired and refresh failed. Wait a few minutes before `grok login` (device-code is rate-limited / slow_down).";
      return base;
    }
    entry = store!.entry;
    base.source = "oidc_refresh";
  }

  const claims = entry.key ? decodeJwtPayload(entry.key) : null;
  const exp = typeof claims?.exp === "number" ? claims.exp : null;

  base.auth = "ok";
  const tier = typeof claims?.tier === "number" ? claims.tier : null;
  base.plan = tier != null ? `tier ${tier}` : (entry.auth_mode as string) || "oidc";
  base.subscription =
    tier != null ? `Grok · xAI API tier ${tier}` : `Grok · ${(entry.auth_mode as string) || "OIDC"}`;
  // SuperGrok product tier isn't on the JWT; weekly pool lives in Settings → Usage
  if (!base.source || base.source === "none") base.source = "local_auth+api_probe";

  const accessToken = entry.key!;
  const probe = await fetchJson("https://api.x.ai/v1/models", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": `GrokCLI/${bin.version || "0.2"}`,
    },
  });

  // If API says unauthenticated, try one refresh then retry once
  if (probe.status === 401 && entry.refresh_token) {
    const refreshed = await refreshGrokAccess(store!);
    if (refreshed.ok) {
      entry = store!.entry;
      const retry = await fetchJson("https://api.x.ai/v1/models", {
        headers: {
          Authorization: `Bearer ${entry.key}`,
          Accept: "application/json",
          "User-Agent": `GrokCLI/${bin.version || "0.2"}`,
        },
      });
      return finalizeProbe(base, entry, retry, exp);
    }
  }

  return finalizeProbe(base, entry, probe, exp);
}

function finalizeProbe(
  base: ProviderSnapshot,
  entry: GrokAuthEntry,
  probe: { ok: boolean; status: number; json: unknown; text: string },
  exp: number | null,
): ProviderSnapshot {
  if (probe.status === 403) {
    const msg =
      (probe.json as { error?: string } | null)?.error || probe.text.slice(0, 180);
    base.hint = `${msg} · weekly pool: Settings → Usage on grok.com`;
    base.windows = [
      {
        name: "api_or_weekly",
        label: "API/credits",
        usedPercent: msg.toLowerCase().includes("run out") ? 100 : null,
        resetsAt: (entry.expires_at as string) || (exp ? isoFromEpochSec(exp) : null),
        availableIn: exp
          ? availableInFromEpoch(exp)
          : availableInFromIsoSafe(entry.expires_at as string),
        windowSeconds: null,
        detail: "SuperGrok weekly % not exposed to CLI yet",
      },
    ];
    base.score = base.windows[0]?.usedPercent ?? 100;
    return base;
  }

  if (probe.ok) {
    base.hint =
      "API auth OK. SuperGrok weekly pool still lives in Settings → Usage (no stable CLI endpoint yet).";
    base.windows = [
      {
        name: "weekly_pool",
        label: "weekly pool",
        usedPercent: null,
        resetsAt: null,
        availableIn: null,
        windowSeconds: 7 * 86400,
        detail: "open grok.com → Settings → Usage",
      },
    ];
    base.score = 50;
    return base;
  }

  base.error = `API probe HTTP ${probe.status}`;
  base.hint =
    "Auth may still be fine — weekly usage is on grok.com → Settings → Usage. Avoid spamming `grok login` (device-code rate limits).";
  return base;
}

function availableInFromIsoSafe(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const sec = Math.floor((t - Date.now()) / 1000);
  if (sec < 0) return "0m";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 48) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}
