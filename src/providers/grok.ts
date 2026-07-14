import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import type { Meter, ProviderSnapshot } from "../types.js";
import {
  availableInFromIso,
  decodeJwtPayload,
  fetchJson,
  formatDuration,
  home,
  normalizeIsoTimestamp,
} from "../util.js";
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

export interface GrokBillingRecord {
  seenAt: string;
  usedPercent: number;
  periodStart: string;
  periodEnd: string;
  subscriptionTier: string | null;
  onDemandEnabled: boolean | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  prepaidBalance: number | null;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseGrokBillingLogLine(line: string): GrokBillingRecord | null {
  try {
    const row = JSON.parse(line) as {
      ts?: unknown;
      msg?: unknown;
      ctx?: { config?: Record<string, unknown>; onDemandEnabled?: unknown; subscriptionTier?: unknown };
    };
    if (row.msg !== "billing: fetched credits config") return null;
    const seenAt = typeof row.ts === "string" ? normalizeIsoTimestamp(row.ts) : null;
    const config = row.ctx?.config;
    const period = config?.currentPeriod;
    if (!seenAt || !period || typeof period !== "object") return null;
    const current = period as Record<string, unknown>;
    if (current.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
    const periodStart = typeof current.start === "string"
      ? normalizeIsoTimestamp(current.start)
      : null;
    const periodEnd = typeof current.end === "string"
      ? normalizeIsoTimestamp(current.end)
      : null;
    const usedPercent = nonnegativeNumber(config.creditUsagePercent);
    if (!periodStart || !periodEnd || usedPercent == null || usedPercent > 100) return null;
    const val = (name: string) => {
      const raw = config[name];
      return raw && typeof raw === "object"
        ? nonnegativeNumber((raw as Record<string, unknown>).val)
        : null;
    };
    return {
      seenAt,
      usedPercent,
      periodStart,
      periodEnd,
      subscriptionTier: typeof row.ctx?.subscriptionTier === "string"
        ? row.ctx.subscriptionTier.trim() || null
        : null,
      onDemandEnabled: typeof row.ctx?.onDemandEnabled === "boolean"
        ? row.ctx.onDemandEnabled
        : null,
      onDemandCap: val("onDemandCap"),
      onDemandUsed: val("onDemandUsed"),
      prepaidBalance: val("prepaidBalance"),
    };
  } catch {
    return null;
  }
}

export function readLatestGrokBillingRecord(
  path = home(".grok", "logs", "unified.jsonl"),
  nowMs = Date.now(),
): GrokBillingRecord | null {
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes("billing: fetched credits config")) continue;
      const record = parseGrokBillingLogLine(lines[i]!);
      if (!record) continue;
      const start = Date.parse(record.periodStart);
      const end = Date.parse(record.periodEnd);
      const seen = Date.parse(record.seenAt);
      if (start <= nowMs && nowMs < end && seen <= nowMs) return record;
    }
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
  return null;
}

export function applyGrokBillingRecord(
  base: ProviderSnapshot,
  record: GrokBillingRecord,
  nowMs = Date.now(),
): ProviderSnapshot {
  const periodSeconds = Math.max(
    0,
    Math.floor((Date.parse(record.periodEnd) - Date.parse(record.periodStart)) / 1000),
  );
  const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(record.seenAt)) / 1000));
  const fresh = ageSeconds <= 5 * 60;
  const hasOnDemand = record.onDemandEnabled === true && (
    (record.onDemandCap != null && record.onDemandUsed != null && record.onDemandUsed < record.onDemandCap) ||
    (record.prepaidBalance != null && record.prepaidBalance > 0)
  );
  const durableExhaustion = record.usedPercent >= 100 && !hasOnDemand;
  const weeklyAffectsAvailability = fresh || durableExhaustion;
  const age = formatDuration(ageSeconds) || "now";
  const weekly: Meter = {
    name: "weekly",
    label: fresh ? "weekly" : `weekly · seen ${age} ago`,
    usedPercent: record.usedPercent,
    resetsAt: record.periodEnd,
    availableIn: availableInFromIso(record.periodEnd),
    windowSeconds: periodSeconds || null,
    detail: `provider-fetched ${record.seenAt}`,
    affectsAvailability: weeklyAffectsAvailability && !hasOnDemand,
  };
  base.windows = [weekly, ...base.windows];
  if (record.onDemandCap != null && record.onDemandCap > 0 && record.onDemandUsed != null) {
    base.windows.push({
      name: "on_demand",
      label: "on-demand",
      usedPercent: (record.onDemandUsed / record.onDemandCap) * 100,
      resetsAt: record.periodEnd,
      availableIn: availableInFromIso(record.periodEnd),
      windowSeconds: periodSeconds || null,
      detail: `${record.onDemandUsed} of ${record.onDemandCap} used`,
      affectsAvailability: false,
    });
  }
  if (record.subscriptionTier) {
    base.plan = record.subscriptionTier;
    const api = base.subscription?.replace(/^Grok · /, "") || null;
    base.subscription = [record.subscriptionTier, api].filter(Boolean).join(" · ");
  }
  base.source = base.source === "none"
    ? "grok_billing_log"
    : `${base.source}+grok_billing_log`;
  if (durableExhaustion) {
    base.score = 100;
    base.requestAvailability = "blocked";
  } else if (fresh && !hasOnDemand) {
    base.score = record.usedPercent;
    base.requestAvailability = "available";
  } else if (hasOnDemand) {
    base.score = null;
    base.requestAvailability = "available";
  }
  const billingHint = `SuperGrok billing last fetched ${age} ago by Grok CLI`;
  let probeHint = base.hint;
  if (probeHint && /api\.x\.ai credits empty/i.test(probeHint)) {
    probeHint = "api.x.ai credits empty (separate from the SuperGrok weekly pool)";
  } else if (probeHint && /^Auth OK · SuperGrok weekly %/i.test(probeHint)) {
    probeHint = "xAI API auth OK";
  }
  base.hint = [billingHint, probeHint].filter(Boolean).join(" · ");
  return base;
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
  const billing = stores.length === 1 ? readLatestGrokBillingRecord() : null;
  const out: ProviderSnapshot[] = [];
  for (let i = 0; i < stores.length; i++) {
    const snap = await collectGrokEntry(stores[i]!, i);
    out.push(billing && i === 0 ? applyGrokBillingRecord(snap, billing) : snap);
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
