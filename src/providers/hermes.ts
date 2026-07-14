import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Meter, ProviderSnapshot } from "../types.js";
import {
  availableInFromIso,
  fetchJson,
  headroomScore,
  home,
  readCache,
  writeCache,
} from "../util.js";
import { detectHermes } from "./detect.js";

const DEFAULT_PORTAL = "https://portal.nousresearch.com";
const DEFAULT_CLIENT_ID = "hermes-cli";
const EXPIRY_SKEW_MS = 120_000;

interface NousProviderState {
  access_token?: string;
  refresh_token?: string;
  client_id?: string;
  portal_base_url?: string;
  inference_base_url?: string;
  token_type?: string;
  scope?: string;
  expires_at?: string;
  expires_in?: number;
  obtained_at?: string;
  label?: string;
  agent_key?: string;
  agent_key_expires_at?: string;
  [k: string]: unknown;
}

interface NousPoolEntry extends NousProviderState {
  id?: string;
  auth_type?: string;
  priority?: number;
  last_status?: string | null;
}

interface HermesAuthFile {
  version?: number;
  providers?: Record<string, NousProviderState>;
  credential_pool?: Record<string, NousPoolEntry[]>;
  active_provider?: string;
  updated_at?: string;
  [k: string]: unknown;
}

interface NousSubscription {
  plan?: string;
  tier?: number;
  monthly_charge?: number;
  monthly_credits?: number;
  current_period_end?: string;
  credits_remaining?: number;
  rollover_credits?: number;
}

interface NousPaidAccess {
  allowed?: boolean;
  paid_access?: boolean;
  reason?: string;
  has_active_subscription?: boolean;
  active_subscription_is_paid?: boolean;
  subscription_tier?: number;
  subscription_monthly_charge?: number;
  subscription_credits_remaining?: number;
  purchased_credits_remaining?: number;
  total_usable_credits?: number;
}

interface NousAccountPayload {
  user?: { email?: string; id?: string };
  organisation?: { id?: string; slug?: string; name?: string };
  subscription?: NousSubscription;
  purchased_credits_remaining?: number;
  paid_service_access?: NousPaidAccess | boolean;
  tool_access?: { enabled?: boolean };
  error?: string;
}

interface HermesNousSlot {
  profileId: string;
  profileLabel: string;
  state: NousProviderState;
  /** Index into credential_pool.nous when from pool; -1 for providers.nous */
  poolIndex: number;
}

function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim();
  if (override) return override;
  return home(".hermes");
}

function authPath(): string {
  return join(hermesHome(), "auth.json");
}

function nonEmpty(s: string | undefined | null): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function portalBase(state: NousProviderState): string {
  return (
    process.env.HERMES_PORTAL_BASE_URL?.trim() ||
    process.env.NOUS_PORTAL_BASE_URL?.trim() ||
    state.portal_base_url ||
    DEFAULT_PORTAL
  ).replace(/\/$/, "");
}

function accessExpired(state: NousProviderState): boolean {
  if (!nonEmpty(state.access_token)) return true;
  if (!state.expires_at) return false;
  const t = Date.parse(state.expires_at);
  if (Number.isNaN(t)) return false;
  return t <= Date.now() + EXPIRY_SKEW_MS;
}

function readAuthFile(): HermesAuthFile | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HermesAuthFile;
  } catch {
    return null;
  }
}

function writeAuthFile(data: HermesAuthFile): void {
  writeFileSync(authPath(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** Discover Nous Portal slots from providers.nous + credential_pool.nous. */
export function discoverNousSlots(auth: HermesAuthFile | null = readAuthFile()): HermesNousSlot[] {
  if (!auth) return [];
  const slots: HermesNousSlot[] = [];
  const seen = new Set<string>();

  const pool = auth.credential_pool?.nous || [];
  pool.forEach((entry, i) => {
    if (!nonEmpty(entry.access_token) && !nonEmpty(entry.refresh_token)) return;
    const id = entry.id || `nous-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    slots.push({
      profileId: id,
      profileLabel: entry.label || id,
      state: entry,
      poolIndex: i,
    });
  });

  const primary = auth.providers?.nous;
  if (primary && (nonEmpty(primary.access_token) || nonEmpty(primary.refresh_token))) {
    const id = "nous";
    // Prefer pool entries when present; still ensure primary is represented
    if (!slots.length) {
      slots.push({
        profileId: id,
        profileLabel: primary.label || "default",
        state: primary,
        poolIndex: -1,
      });
    } else if (!slots.some((s) => s.state.refresh_token === primary.refresh_token)) {
      slots.unshift({
        profileId: id,
        profileLabel: primary.label || "default",
        state: primary,
        poolIndex: -1,
      });
    }
  }

  return slots;
}

function persistSlot(slot: HermesNousSlot, next: NousProviderState): void {
  const auth = readAuthFile() || { version: 1, providers: {}, credential_pool: {} };
  if (!auth.providers) auth.providers = {};
  if (!auth.credential_pool) auth.credential_pool = {};

  // Always keep providers.nous in sync when refreshing the active/primary slot
  if (slot.poolIndex < 0 || slot.profileId === "nous" || auth.active_provider === "nous") {
    auth.providers.nous = { ...auth.providers.nous, ...next };
  }

  if (slot.poolIndex >= 0) {
    const pool = auth.credential_pool.nous || [];
    if (pool[slot.poolIndex]) {
      pool[slot.poolIndex] = { ...pool[slot.poolIndex], ...next };
      auth.credential_pool.nous = pool;
    }
  } else if (auth.credential_pool.nous?.length) {
    // Mirror into matching pool entry by refresh/access token when possible
    const pool = auth.credential_pool.nous;
    const idx = pool.findIndex(
      (e) =>
        (nonEmpty(next.refresh_token) && e.refresh_token === slot.state.refresh_token) ||
        e.label === slot.profileLabel,
    );
    if (idx >= 0) {
      pool[idx] = { ...pool[idx], ...next };
    }
  }

  auth.updated_at = new Date().toISOString();
  writeAuthFile(auth);
  slot.state = { ...slot.state, ...next };
}

async function refreshNousAccess(
  slot: HermesNousSlot,
): Promise<{ ok: true; state: NousProviderState } | { ok: false; error: string }> {
  const state = slot.state;
  if (!nonEmpty(state.refresh_token)) {
    return { ok: false, error: "no refresh token — run `hermes portal`" };
  }

  const base = portalBase(state);
  const clientId = state.client_id || DEFAULT_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
  });

  const res = await fetchJson(`${base}/api/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-nous-refresh-token": state.refresh_token,
      "User-Agent": "llmquota/0.1 (hermes-nous)",
    },
    body: body.toString(),
    timeoutMs: 15_000,
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
    token_type?: string;
    scope?: string;
    inference_base_url?: string;
  };
  if (!nonEmpty(data.access_token)) {
    return { ok: false, error: "refresh response missing access_token" };
  }

  const now = Date.now();
  const ttl = data.expires_in ?? 3600;
  const next: NousProviderState = {
    ...state,
    access_token: data.access_token,
    refresh_token: nonEmpty(data.refresh_token) ? data.refresh_token : state.refresh_token,
    token_type: data.token_type || state.token_type || "Bearer",
    scope: data.scope || state.scope,
    obtained_at: new Date(now).toISOString(),
    expires_in: ttl,
    expires_at: new Date(now + ttl * 1000).toISOString(),
  };
  if (nonEmpty(data.inference_base_url)) {
    next.inference_base_url = data.inference_base_url.replace(/\/$/, "");
  }

  // Persist immediately — Nous rotates refresh tokens (reuse = revoke).
  persistSlot(slot, next);
  return { ok: true, state: next };
}

function usd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

function paidAccess(payload: NousAccountPayload): NousPaidAccess | null {
  const raw = payload.paid_service_access;
  if (raw && typeof raw === "object") return raw;
  return null;
}

function buildMeters(payload: NousAccountPayload): Meter[] {
  const meters: Meter[] = [];
  const sub = payload.subscription;
  const access = paidAccess(payload);

  if (sub?.monthly_credits != null && sub.monthly_credits > 0 && sub.credits_remaining != null) {
    const cap = sub.monthly_credits;
    const remaining = sub.credits_remaining;
    const used = Math.max(0, cap - remaining);
    const usedPercent = Math.max(0, Math.min(100, (used / cap) * 100));
    meters.push({
      name: "subscription",
      label: "sub",
      usedPercent,
      resetsAt: sub.current_period_end || null,
      availableIn: availableInFromIso(sub.current_period_end),
      windowSeconds: null,
      detail: `${usd(remaining)} of ${usd(cap)} left`,
    });
  }

  const purchased =
    access?.purchased_credits_remaining ?? payload.purchased_credits_remaining ?? null;
  const total = access?.total_usable_credits ?? purchased;
  if (total != null && Number.isFinite(total)) {
    meters.push({
      name: "topup",
      label: "credits",
      usedPercent: total <= 0 ? 100 : null,
      resetsAt: null,
      availableIn: null,
      windowSeconds: null,
      detail: `${usd(total)} usable${purchased != null && purchased !== total ? ` (top-up ${usd(purchased)})` : ""}`,
    });
  }

  return meters;
}

function emptySnapshot(
  bin: ReturnType<typeof detectHermes>,
  slot: HermesNousSlot | null,
): ProviderSnapshot {
  const multi = Boolean(slot && slot.profileLabel && slot.profileLabel !== "default");
  const label = slot?.profileLabel || "default";
  return {
    id: "hermes",
    displayName: multi ? `Hermes · ${label}` : "Hermes",
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
    profileId: slot?.profileId || "default",
    profileLabel: label,
    configDir: hermesHome(),
    active: true,
  };
}

export async function collectHermesSlot(
  slot: HermesNousSlot,
  opts: { refresh?: boolean } = {},
): Promise<ProviderSnapshot> {
  const bin = detectHermes();
  const base = emptySnapshot(bin, slot);

  if (!bin.installed) {
    base.hint = "Install Hermes Agent (Nous Research), then `hermes portal`.";
    return base;
  }

  let state = slot.state;
  if (accessExpired(state)) {
    const refreshed = await refreshNousAccess(slot);
    if (!refreshed.ok) {
      base.auth = "expired";
      base.error = refreshed.error;
      base.hint = "Run `hermes portal` to re-auth Nous.";
      return base;
    }
    state = refreshed.state;
  }

  base.auth = "ok";

  const cacheKey = `hermes-nous-${slot.profileId}`;
  if (!opts.refresh) {
    const cached = readCache<NousAccountPayload>(cacheKey, 60_000);
    if (cached) {
      return finalizeAccount(base, cached, "portal_account(cache)");
    }
  }

  const fetchAccount = (token: string) =>
    fetchJson(`${portalBase(state)}/api/oauth/account`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "llmquota/0.1 (hermes-nous)",
      },
      timeoutMs: 15_000,
    });

  let res = await fetchAccount(state.access_token!);

  if (res.status === 401 && nonEmpty(state.refresh_token)) {
    const refreshed = await refreshNousAccess(slot);
    if (refreshed.ok) {
      state = refreshed.state;
      res = await fetchAccount(state.access_token!);
    } else {
      base.auth = "expired";
      base.error = refreshed.error;
      base.hint = "Run `hermes portal` to re-auth Nous.";
      return base;
    }
  }

  if (!res.ok || !res.json || typeof res.json !== "object") {
    base.auth = res.status === 401 ? "expired" : "error";
    base.error = `Nous account fetch failed (HTTP ${res.status})`;
    base.source = "portal_account";
    base.hint = "Open https://portal.nousresearch.com/billing or run `hermes portal`.";
    return base;
  }

  const payload = res.json as NousAccountPayload;
  if (payload.error) {
    base.auth = "error";
    base.error = payload.error;
    base.source = "portal_account";
    return base;
  }

  writeCache(cacheKey, payload);
  return finalizeAccount(base, payload, "portal_account");
}

function finalizeAccount(
  base: ProviderSnapshot,
  payload: NousAccountPayload,
  source: string,
): ProviderSnapshot {
  const sub = payload.subscription;
  const access = paidAccess(payload);
  const plan = sub?.plan || (sub?.tier != null ? `tier ${sub.tier}` : null);
  base.plan = plan;
  if (plan) {
    const charge = sub?.monthly_charge != null ? ` · $${sub.monthly_charge}/mo` : "";
    base.subscription = `Nous ${plan}${charge}`;
  } else if (access?.active_subscription_is_paid) {
    base.subscription = "Nous Portal (paid)";
  } else {
    base.subscription = "Nous Portal";
  }

  base.account =
    payload.organisation?.name ||
    payload.organisation?.slug ||
    payload.user?.email ||
    null;
  base.source = source;
  base.windows = buildMeters(payload);
  const subUsed = base.windows.find((w) => w.name === "subscription")?.usedPercent;
  const total = access?.total_usable_credits;
  if (subUsed != null) {
    // Soften score when top-up credits remain after grant exhaustion
    base.score =
      subUsed >= 99 && total != null && total > 0 ? Math.min(subUsed, 85) : subUsed;
  } else {
    base.score = headroomScore(base.windows.map((w) => w.usedPercent));
    if (base.score == null && total != null && total > 0) base.score = 40;
  }
  if (access?.paid_access === false || (total != null && total <= 0 && (sub?.credits_remaining ?? 0) <= 0)) {
    base.hint = "Credits depleted — top up at portal.nousresearch.com/billing";
  } else if ((sub?.credits_remaining ?? 1) <= 0 && (total ?? 0) > 0) {
    base.hint = "Subscription grant exhausted — running on top-up credits";
  }

  return base;
}

export async function collectHermesAll(
  opts: { refresh?: boolean } = {},
): Promise<ProviderSnapshot[]> {
  const bin = detectHermes();
  const slots = discoverNousSlots();
  if (!slots.length) {
    const snap = emptySnapshot(bin, null);
    snap.hint = bin.installed
      ? "Run `hermes portal` to log into Nous Research."
      : "Install Hermes Agent, then `hermes portal`.";
    snap.active = true;
    return [snap];
  }

  const out: ProviderSnapshot[] = [];
  for (let i = 0; i < slots.length; i++) {
    const snap = await collectHermesSlot(slots[i]!, opts);
    snap.active = i === 0;
    if (slots.length === 1) {
      snap.displayName = "Hermes";
      snap.profileId = "default";
    }
    out.push(snap);
  }
  return out;
}

export async function collectHermes(
  opts: { refresh?: boolean } = {},
): Promise<ProviderSnapshot> {
  const all = await collectHermesAll(opts);
  return all[0]!;
}
