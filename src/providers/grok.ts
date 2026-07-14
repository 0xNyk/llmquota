import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ProviderSnapshot } from "../types.js";
import { decodeJwtPayload, fetchJson, home } from "../util.js";
import { baseSnapshot, isExpiredAt } from "../snapshot.js";
import { detectGrok } from "./detect.js";
import { readGrokActiveSelection } from "../active-selection.js";

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

function readGrokAuthStores(): GrokAuthStore[] {
  const path = home(".grok", "auth.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, GrokAuthEntry>;
    return Object.keys(raw).map((key) => ({
      path,
      key,
      entry: raw[key]!,
      raw,
    }));
  } catch {
    return [];
  }
}

function grokProfileLabel(key: string, entry: GrokAuthEntry, index: number): string {
  if (entry.email) return entry.email;
  if (entry.first_name) return String(entry.first_name);
  const short = key.includes("::") ? key.split("::")[0]! : key;
  if (short.length <= 24) return short;
  return `account-${index + 1}`;
}

function emptyGrokSnapshot(
  bin: ReturnType<typeof detectGrok>,
  store: GrokAuthStore | null,
  index: number,
): ProviderSnapshot {
  const selection = readGrokActiveSelection(home(".grok"));
  const label = store
    ? grokProfileLabel(store.key, store.entry, index)
    : "default";
  const multi = Boolean(store && Object.keys(store.raw).length > 1);
  return baseSnapshot({
    id: "grok",
    displayName: multi ? `Grok · ${label}` : "Grok",
    installed: bin.installed,
    binary: bin.path,
    version: bin.version,
    account: store?.entry.email || null,
    profileId: store?.key || "default",
    profileLabel: label,
    configDir: home(".grok"),
    active: index === 0,
    activeProvider: selection.provider,
    activeModel: selection.model,
  });
}

export async function collectGrokEntry(
  store: GrokAuthStore,
  index: number,
): Promise<ProviderSnapshot> {
  const bin = detectGrok();
  const base = emptyGrokSnapshot(bin, store, index);

  if (!bin.installed) {
    base.hint = "Install Grok Build CLI, then `grok login`.";
    return base;
  }

  if (!store.entry.key && !store.entry.refresh_token) {
    base.hint = "Run `grok login`.";
    return base;
  }

  let entry = store.entry;
  base.account = (entry.email as string) || null;

  if (accessExpired(entry)) {
    const refreshed = await refreshGrokAccess(store);
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
    entry = store.entry;
    base.source = "oidc_refresh";
  }

  const claims = entry.key ? decodeJwtPayload(entry.key) : null;
  const exp = typeof claims?.exp === "number" ? claims.exp : null;

  base.auth = "ok";
  const tier = typeof claims?.tier === "number" ? claims.tier : null;
  base.plan = tier != null ? `tier ${tier}` : (entry.auth_mode as string) || "oidc";
  base.subscription =
    tier != null ? `Grok · xAI API tier ${tier}` : `Grok · ${(entry.auth_mode as string) || "OIDC"}`;
  if (!base.source || base.source === "none") base.source = "local_auth+api_probe";

  const accessToken = entry.key!;
  const probe = await fetchJson("https://api.x.ai/v1/models", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": `GrokCLI/${bin.version || "0.2"}`,
    },
  });

  if (probe.status === 401 && entry.refresh_token) {
    const refreshed = await refreshGrokAccess(store);
    if (refreshed.ok) {
      entry = store.entry;
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

export async function collectGrokAll(): Promise<ProviderSnapshot[]> {
  const bin = detectGrok();
  const stores = readGrokAuthStores();
  if (!stores.length) {
    const snap = emptyGrokSnapshot(bin, null, 0);
    snap.hint = bin.installed ? "Run `grok login`." : "Install Grok Build CLI, then `grok login`.";
    return [snap];
  }
  const out: ProviderSnapshot[] = [];
  for (let i = 0; i < stores.length; i++) {
    out.push(await collectGrokEntry(stores[i]!, i));
  }
  return out;
}

export async function collectGrok(): Promise<ProviderSnapshot> {
  const all = await collectGrokAll();
  return all[0]!;
}

function accessExpired(entry: GrokAuthEntry, skewSec = 120): boolean {
  const skewMs = skewSec * 1000;
  if (entry.key) {
    const claims = decodeJwtPayload(entry.key);
    const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : null;
    if (exp != null) return isExpiredAt(exp, skewMs);
  }
  return isExpiredAt(entry.expires_at, skewMs);
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

function finalizeProbe(
  base: ProviderSnapshot,
  entry: GrokAuthEntry,
  probe: {
    ok: boolean;
    status: number;
    json: unknown;
    text: string;
    headers?: Headers | Record<string, string> | null;
  },
  _exp: number | null,
): ProviderSnapshot {
  // Never invent usage windows/scores. Never use JWT exp as a usage reset.
  void entry;
  void _exp;

  const errMsg =
    (probe.json as { error?: string; error_message?: string } | null)?.error ||
    (probe.json as { error_message?: string } | null)?.error_message ||
    probe.text.slice(0, 180);

  base.windows = [];
  base.score = null;

  if (probe.status === 403) {
    const msg = errMsg;
    const apiCredits = /run out of credits|add credits|need a grok subscription/i.test(msg);
    if (apiCredits) {
      base.hint =
        "api.x.ai credits empty (not SuperGrok weekly %). Check grok.com → Settings → Usage for the real weekly pool.";
    } else if (/quota|rate.?limit|usage.?limit|insufficient/i.test(msg)) {
      base.hint = `API limit signal: ${msg.slice(0, 120)} · weekly % → grok.com Settings → Usage`;
    } else {
      base.hint = `API 403: ${msg.slice(0, 120) || "forbidden"} · weekly % → grok.com Settings → Usage`;
    }
    return base;
  }

  if (probe.ok) {
    base.hint =
      "Auth OK · SuperGrok weekly % has no public API yet — read grok.com → Settings → Usage";
    return base;
  }

  base.error = `API probe HTTP ${probe.status}`;
  base.hint =
    "Auth may still be fine — weekly usage is on grok.com → Settings → Usage. Avoid spamming `grok login` (device-code rate limits).";
  return base;
}

/** Exported for unit tests. */
export function finalizeGrokProbeForTest(
  base: ProviderSnapshot,
  probe: { ok: boolean; status: number; json: unknown; text: string },
): ProviderSnapshot {
  return finalizeProbe(base, {}, probe, null);
}
