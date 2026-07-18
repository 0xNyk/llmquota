import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Meter, ProviderSnapshot, RequestAvailability } from "../types.js";
import { baseSnapshot, isExpiredAt } from "../snapshot.js";
import {
  availableInFromIso,
  decodeJwtPayload,
  fetchJson,
  hasAnyOwn,
  headroomScore,
  normalizeIsoTimestamp,
  home,
  nonEmpty,
  readCache,
  readCacheEntry,
  readLatestCacheEntry,
  writeCache,
  titleCase,
} from "../util.js";
import { detectHermes } from "./detect.js";
import { readHermesActiveSelection } from "../active-selection.js";
import {
  codexUsageHint,
  codexUsageScore,
  codexRequestAvailability,
  collectCodexUsageWindows,
  isCodexUsagePayload,
} from "./codex.js";

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

function normalizedProvider(value: string | null | undefined): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isNousProvider(value: string | null | undefined): boolean {
  const provider = normalizedProvider(value);
  return !provider || provider === "nous" || provider === "nousresearch";
}

function isOpenAiCodexProvider(value: string | null | undefined): boolean {
  const provider = normalizedProvider(value);
  return provider === "openaicodex" || provider === "codex" || provider === "chatgpt";
}

function accessTokenFromState(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (typeof state.access_token === "string" && state.access_token.trim()) {
    return state.access_token;
  }
  const tokens = state.tokens;
  if (tokens && typeof tokens === "object") {
    const access = (tokens as Record<string, unknown>).access_token;
    if (typeof access === "string" && access.trim()) return access;
  }
  return null;
}

export function hermesProviderAccessToken(
  auth: HermesAuthFile | null,
  provider: string,
): string | null {
  if (!auth) return null;
  const providerKey = Object.keys(auth.providers || {}).find(
    (key) => normalizedProvider(key) === normalizedProvider(provider),
  ) || provider;
  const poolKey = Object.keys(auth.credential_pool || {}).find(
    (key) => normalizedProvider(key) === normalizedProvider(provider),
  ) || provider;
  const direct = accessTokenFromState(auth.providers?.[providerKey]);
  if (direct) return direct;
  for (const entry of auth.credential_pool?.[poolKey] || []) {
    const token = accessTokenFromState(entry);
    if (token) return token;
  }
  return null;
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
  member_spend_cap_exceeded?: boolean;
  member_spend_cap_usd?: number | string | null;
  member_spend_usd?: number | string | null;
  member_spend_cap_remaining_usd?: number | string | null;
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

const NOUS_ACCOUNT_FIELDS = [
  "user",
  "organisation",
  "subscription",
  "purchased_credits_remaining",
  "paid_service_access",
  "tool_access",
] as const;

export function isNousAccountPayload(value: unknown): value is NousAccountPayload {
  return hasAnyOwn(value, NOUS_ACCOUNT_FIELDS) && value.error == null;
}

interface HermesNousSlot {
  profileId: string;
  profileLabel: string;
  state: NousProviderState;
  /** Index into credential_pool.nous when from pool; -1 for providers.nous */
  poolIndex: number;
  /** Auth store that owns this credential (profile or global fallback). */
  authFilePath: string;
}

function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim();
  if (override) return override;
  return home(".hermes");
}

function authPath(): string {
  return join(hermesHome(), "auth.json");
}

/** Match Hermes's profile-mode read fallback without treating arbitrary custom homes as profiles. */
export function hermesGlobalAuthPath(
  activeHome = hermesHome(),
  nativeRoot = home(".hermes"),
): string | null {
  const active = resolve(activeHome);
  const native = resolve(nativeRoot);
  if (active === native) return null;
  if (active.startsWith(`${native}${sep}`)) return join(native, "auth.json");
  if (basename(dirname(active)) === "profiles") {
    return join(dirname(dirname(active)), "auth.json");
  }
  return null;
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
  return isExpiredAt(state.expires_at, EXPIRY_SKEW_MS);
}

/** Prefer obtained_at, then expires_at — used to pick winner when pool + providers diverge. */
function credentialFreshness(state: NousProviderState): number {
  if (nonEmpty(state.obtained_at)) {
    const t = Date.parse(state.obtained_at);
    if (!Number.isNaN(t)) return t;
  }
  if (nonEmpty(state.expires_at)) {
    const t = Date.parse(state.expires_at);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function readAuthFileAt(path: string): HermesAuthFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HermesAuthFile;
  } catch {
    return null;
  }
}

function readAuthFile(): HermesAuthFile | null {
  return readAuthFileAt(authPath());
}

function writeAuthFileAt(path: string, data: HermesAuthFile): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function mergeHermesAuthFallback(
  profile: HermesAuthFile | null,
  global: HermesAuthFile | null,
): {
  auth: HermesAuthFile;
  providerFromGlobal: boolean;
  poolFromGlobal: boolean;
} {
  const profileProvider = profile?.providers?.nous;
  const globalProvider = global?.providers?.nous;
  const profilePool = profile?.credential_pool?.nous;
  const globalPool = global?.credential_pool?.nous;
  const providerFromGlobal = profileProvider === undefined && globalProvider !== undefined;
  const poolFromGlobal = !(profilePool?.length) && Boolean(globalPool?.length);
  const provider = profileProvider ?? globalProvider;
  const pool = profilePool?.length ? profilePool : (globalPool || []);
  return {
    auth: {
      version: profile?.version ?? global?.version,
      active_provider: profile?.active_provider,
      providers: provider ? { nous: provider } : {},
      credential_pool: { nous: pool },
      updated_at: profile?.updated_at ?? global?.updated_at,
    },
    providerFromGlobal,
    poolFromGlobal,
  };
}

/**
 * Adopt newer tokens from providers.nous into a pool slot when Hermes (or another
 * process) already rotated the single-use refresh token. Mirrors Hermes
 * `_sync_nous_entry_from_auth_store` — never HTTP-refresh a stale RT (revokes session).
 */
function syncSlotFromAuthStore(slot: HermesNousSlot): boolean {
  if (slot.poolIndex < 0) return false;
  const auth = readAuthFileAt(slot.authFilePath);
  const primary = auth?.providers?.nous;
  if (!primary) return false;
  if (!nonEmpty(primary.access_token) && !nonEmpty(primary.refresh_token)) return false;

  const sameLabel =
    nonEmpty(slot.profileLabel) &&
    slot.profileLabel !== "default" &&
    primary.label?.trim().toLowerCase() === slot.profileLabel.trim().toLowerCase();
  const related =
    sameLabel ||
    (nonEmpty(slot.state.refresh_token) && slot.state.refresh_token === primary.refresh_token) ||
    (nonEmpty(slot.state.access_token) && slot.state.access_token === primary.access_token) ||
    // Single-account setups: only one pool entry + primary
    (auth?.credential_pool?.nous?.length === 1 && Boolean(primary));

  if (!related) return false;
  if (credentialFreshness(primary) < credentialFreshness(slot.state)) return false;
  if (
    primary.access_token === slot.state.access_token &&
    primary.refresh_token === slot.state.refresh_token
  ) {
    return false;
  }

  const next: NousProviderState = {
    ...slot.state,
    access_token: primary.access_token ?? slot.state.access_token,
    refresh_token: primary.refresh_token ?? slot.state.refresh_token,
    expires_at: primary.expires_at ?? slot.state.expires_at,
    expires_in: primary.expires_in ?? slot.state.expires_in,
    obtained_at: primary.obtained_at ?? slot.state.obtained_at,
    token_type: primary.token_type ?? slot.state.token_type,
    scope: primary.scope ?? slot.state.scope,
    inference_base_url: primary.inference_base_url ?? slot.state.inference_base_url,
    agent_key: primary.agent_key ?? slot.state.agent_key,
    agent_key_expires_at: primary.agent_key_expires_at ?? slot.state.agent_key_expires_at,
    client_id: primary.client_id ?? slot.state.client_id,
    portal_base_url: primary.portal_base_url ?? slot.state.portal_base_url,
  };
  persistSlot(slot, next);
  return true;
}

/** Discover Nous Portal slots from providers.nous + credential_pool.nous. */
export function discoverNousSlots(
  auth: HermesAuthFile | null = readAuthFile(),
  sourcePaths: { provider: string; pool: string } = {
    provider: authPath(),
    pool: authPath(),
  },
): HermesNousSlot[] {
  if (!auth) return [];
  const candidates: HermesNousSlot[] = [];

  const primary = auth.providers?.nous;
  if (primary && (nonEmpty(primary.access_token) || nonEmpty(primary.refresh_token))) {
    candidates.push({
      profileId: "nous",
      profileLabel: primary.label || "default",
      state: primary,
      poolIndex: -1,
      authFilePath: sourcePaths.provider,
    });
  }

  const pool = auth.credential_pool?.nous || [];
  pool.forEach((entry, i) => {
    if (!nonEmpty(entry.access_token) && !nonEmpty(entry.refresh_token)) return;
    candidates.push({
      profileId: entry.id || `nous-${i}`,
      profileLabel: entry.label || entry.id || `nous-${i}`,
      state: entry,
      poolIndex: i,
      authFilePath: sourcePaths.pool,
    });
  });

  // Collapse same account when pool RT lagged behind providers.nous after rotation.
  const winners: HermesNousSlot[] = [];
  const used = new Set<number>();

  function sameAccount(a: HermesNousSlot, b: HermesNousSlot): boolean {
    if (
      nonEmpty(a.state.refresh_token) &&
      nonEmpty(b.state.refresh_token) &&
      a.state.refresh_token === b.state.refresh_token
    ) {
      return true;
    }
    const la = a.profileLabel?.trim().toLowerCase();
    const lb = b.profileLabel?.trim().toLowerCase();
    if (la && lb && la !== "default" && la === lb) return true;
    // Single-account install: providers.nous + one pool row
    if (
      candidates.length === 2 &&
      ((a.poolIndex < 0 && b.poolIndex >= 0) || (b.poolIndex < 0 && a.poolIndex >= 0))
    ) {
      return true;
    }
    return false;
  }

  function prefer(a: HermesNousSlot, b: HermesNousSlot): HermesNousSlot {
    const fa = credentialFreshness(a.state);
    const fb = credentialFreshness(b.state);
    if (fa !== fb) return fa > fb ? a : b;
    // Tie → providers.nous
    if (a.poolIndex < 0) return a;
    if (b.poolIndex < 0) return b;
    return a;
  }

  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;
    let best = candidates[i]!;
    used.add(i);
    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(j)) continue;
      const other = candidates[j]!;
      if (!sameAccount(best, other)) continue;
      used.add(j);
      best = prefer(best, other);
    }
    winners.push(best);
  }

  winners.sort((a, b) => {
    if (a.poolIndex < 0 && b.poolIndex >= 0) return -1;
    if (b.poolIndex < 0 && a.poolIndex >= 0) return 1;
    return a.poolIndex - b.poolIndex;
  });

  return winners;
}

export function discoverNousSlotsWithFallback(
  profile: HermesAuthFile | null,
  global: HermesAuthFile | null,
  profilePath: string,
  globalPath: string,
): HermesNousSlot[] {
  const merged = mergeHermesAuthFallback(profile, global);
  return discoverNousSlots(merged.auth, {
    provider: merged.providerFromGlobal ? globalPath : profilePath,
    pool: merged.poolFromGlobal ? globalPath : profilePath,
  });
}

function discoverConfiguredNousSlots(): HermesNousSlot[] {
  const profilePath = authPath();
  const globalPath = hermesGlobalAuthPath();
  if (!globalPath) return discoverNousSlots(readAuthFileAt(profilePath));
  return discoverNousSlotsWithFallback(
    readAuthFileAt(profilePath),
    readAuthFileAt(globalPath),
    profilePath,
    globalPath,
  );
}

function persistSlot(slot: HermesNousSlot, next: NousProviderState): void {
  const auth = readAuthFileAt(slot.authFilePath) || {
    version: 1,
    providers: {},
    credential_pool: {},
  };
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
    // Mirror into matching pool entry by label / prior refresh token
    const pool = auth.credential_pool.nous;
    const idx = pool.findIndex((e) => {
      if (
        nonEmpty(slot.profileLabel) &&
        slot.profileLabel !== "default" &&
        e.label?.trim().toLowerCase() === slot.profileLabel.trim().toLowerCase()
      ) {
        return true;
      }
      if (nonEmpty(slot.state.refresh_token) && e.refresh_token === slot.state.refresh_token) {
        return true;
      }
      return false;
    });
    if (idx >= 0) {
      pool[idx] = { ...pool[idx], ...next };
    } else if (pool.length === 1) {
      // Single-account: keep pool row in lockstep with providers.nous
      pool[0] = { ...pool[0], ...next };
    }
  }

  auth.updated_at = new Date().toISOString();
  writeAuthFileAt(slot.authFilePath, auth);
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
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  return `$${n.toFixed(2)}`;
}

function paidAccess(payload: NousAccountPayload): NousPaidAccess | null {
  const raw = payload.paid_service_access;
  if (raw && typeof raw === "object") return raw;
  return null;
}

function compactAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function nonnegativeDecimal(value: number | string | null | undefined): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null;
}

export function nousPurchasedCreditMeter(
  payload: NousAccountPayload,
  ageMs: number | null = null,
): Meter | null {
  const access = paidAccess(payload);
  const purchased = access?.purchased_credits_remaining ?? payload.purchased_credits_remaining;
  if (typeof purchased !== "number" || !Number.isFinite(purchased) || purchased < 0) return null;
  const freshness = ageMs == null ? "live" : `cached ${compactAge(ageMs)} ago`;
  return {
    name: "nous_purchased",
    label: "Nous +",
    usedPercent: null,
    resetsAt: null,
    availableIn: null,
    windowSeconds: null,
    detail: `Nous paid credits ${usd(purchased)} remaining · ${freshness}`,
    affectsAvailability: false,
  };
}

function cachedNousPurchasedCreditMeter(): Meter | null {
  const maxAgeMs = 7 * 24 * 3600_000;
  let newest: { meter: Meter; cachedAt: number } | null = null;
  for (const slot of discoverConfiguredNousSlots()) {
    const hit = readCacheEntry<NousAccountPayload>(`hermes-nous-${slot.profileId}`, maxAgeMs);
    if (!hit || !isNousAccountPayload(hit.data)) continue;
    const meter = nousPurchasedCreditMeter(hit.data, hit.ageMs);
    if (meter && (!newest || hit.cachedAt > newest.cachedAt)) newest = { meter, cachedAt: hit.cachedAt };
  }
  const latest = readLatestCacheEntry<NousAccountPayload>("hermes-nous-", maxAgeMs);
  if (latest && isNousAccountPayload(latest.data) && (!newest || latest.cachedAt > newest.cachedAt)) {
    const meter = nousPurchasedCreditMeter(latest.data, latest.ageMs);
    if (meter) newest = { meter, cachedAt: latest.cachedAt };
  }
  return newest?.meter ?? null;
}

export function hermesPaidAccessAllowed(payload: NousAccountPayload): boolean | null {
  const raw = payload.paid_service_access;
  if (typeof raw === "boolean") return raw;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.allowed === "boolean") return raw.allowed;
  if (typeof raw.paid_access === "boolean") return raw.paid_access;
  return null;
}

export function buildHermesMeters(payload: NousAccountPayload): Meter[] {
  const meters: Meter[] = [];
  const sub = payload.subscription;
  const access = paidAccess(payload);
  const subscriptionRemaining =
    sub?.credits_remaining ?? access?.subscription_credits_remaining;

  if (
    typeof sub?.monthly_credits === "number" &&
    Number.isFinite(sub.monthly_credits) &&
    sub.monthly_credits > 0 &&
    typeof subscriptionRemaining === "number" &&
    Number.isFinite(subscriptionRemaining) &&
    subscriptionRemaining >= 0
  ) {
    const cap = sub.monthly_credits;
    const remaining = subscriptionRemaining;
    const used = Math.max(0, cap - remaining);
    const usedPercent = (used / cap) * 100;
    const rollover = typeof sub.rollover_credits === "number" && sub.rollover_credits > 0
      ? usd(sub.rollover_credits)
      : null;
    const resetsAt = normalizeIsoTimestamp(sub.current_period_end);
    meters.push({
      name: "subscription",
      label: "sub",
      usedPercent,
      resetsAt,
      availableIn: availableInFromIso(resetsAt),
      windowSeconds: null,
      detail: `${usd(remaining)} of ${usd(cap)} left${rollover ? ` · ${rollover} rollover` : ""}`,
    });
  }

  const purchased = nonnegativeDecimal(
    access?.purchased_credits_remaining ?? payload.purchased_credits_remaining,
  );
  const aggregateTotal = nonnegativeDecimal(access?.total_usable_credits);
  const total = aggregateTotal ?? purchased;
  if (total != null) {
    const subscription = usd(nonnegativeDecimal(access?.subscription_credits_remaining));
    const purchasedLabel = usd(purchased);
    const components = [
      subscription ? `subscription ${subscription}` : null,
      purchasedLabel && purchased !== total ? `paid ${purchasedLabel} remaining` : null,
    ].filter(Boolean);
    meters.push({
      name: "topup",
      label: "credits",
      usedPercent: null,
      resetsAt: null,
      availableIn: null,
      windowSeconds: null,
      detail: purchased === total && purchasedLabel
        ? `Nous paid credits ${purchasedLabel} remaining · live`
        : `${usd(total)} usable${components.length ? ` (${components.join(" · ")})` : ""}`,
      affectsAvailability: false,
    });
  }

  const memberSpend = nonnegativeDecimal(access?.member_spend_usd);
  const memberCap = nonnegativeDecimal(access?.member_spend_cap_usd);
  const memberRemaining = nonnegativeDecimal(access?.member_spend_cap_remaining_usd);
  const capExceeded = access?.member_spend_cap_exceeded === true;
  if (memberSpend != null || memberCap != null || memberRemaining != null || capExceeded) {
    const usedPercent = memberSpend != null && memberCap != null && memberCap > 0
      ? (memberSpend / memberCap) * 100
      : null;
    const amounts = memberSpend != null && memberCap != null
      ? `${usd(memberSpend)} / ${usd(memberCap)} member spend`
      : memberSpend != null
        ? `${usd(memberSpend)} member spend`
        : memberRemaining != null
          ? `${usd(memberRemaining)} member cap remaining`
          : null;
    meters.push({
      name: "member_spend",
      label: "member",
      usedPercent,
      resetsAt: null,
      availableIn: null,
      windowSeconds: null,
      detail: [amounts, capExceeded ? "member spend cap exceeded" : null]
        .filter(Boolean)
        .join(" · ") || null,
      affectsAvailability: false,
    });
  }

  return meters;
}

export function hermesUsageScore(windows: Meter[], totalUsableCredits: number | null): number | null {
  const subUsed = windows.find((w) => w.name === "subscription")?.usedPercent;
  if (subUsed != null && subUsed >= 100 && totalUsableCredits != null && totalUsableCredits > 0) {
    return null;
  }
  if (subUsed != null) return subUsed;
  return headroomScore(windows.map((w) => w.usedPercent));
}

export function hermesAvailabilityScore(
  payload: NousAccountPayload,
  windows: Meter[],
  totalUsableCredits: number | null,
): number | null {
  const allowed = hermesPaidAccessAllowed(payload);
  if (allowed === false) return 100;
  if (allowed == null && paidAccess(payload)?.member_spend_cap_exceeded === true) return 100;
  return hermesUsageScore(windows, totalUsableCredits);
}

export function hermesEntitlementHint(payload: NousAccountPayload): string | null {
  const sub = payload.subscription;
  const access = paidAccess(payload);
  const allowed = hermesPaidAccessAllowed(payload);
  const total = access?.total_usable_credits ?? payload.purchased_credits_remaining ?? null;

  if (allowed !== true && access?.member_spend_cap_exceeded === true) {
    return "Member spend cap reached — raise it in Nous Portal billing";
  }
  if (allowed === false) {
    if (access?.reason === "no_usable_credits") {
      return "Credits depleted — top up at portal.nousresearch.com/billing";
    }
    if (access?.reason === "account_missing") {
      return "Nous Portal account unavailable — re-auth or contact Nous support";
    }
    if (access?.has_active_subscription && access.active_subscription_is_paid === false) {
      return "Current Nous plan has no paid service access — upgrade or add credits";
    }
    if (access?.has_active_subscription === false) {
      return "No active Nous subscription or usable credits — subscribe or top up";
    }
    return "Nous paid service access unavailable — check Portal billing";
  }
  if (
    total != null &&
    Number.isFinite(total) &&
    total <= 0 &&
    typeof sub?.credits_remaining === "number" &&
    Number.isFinite(sub.credits_remaining) &&
    sub.credits_remaining <= 0
  ) {
    return "Credits depleted — top up at portal.nousresearch.com/billing";
  }
  if (
    typeof sub?.credits_remaining === "number" &&
    Number.isFinite(sub.credits_remaining) &&
    sub.credits_remaining <= 0 &&
    total != null &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return "Subscription grant exhausted — running on top-up credits";
  }
  return null;
}

export function hermesSubscriptionLabels(payload: NousAccountPayload): {
  plan: string | null;
  subscription: string;
} {
  const sub = payload.subscription;
  const access = paidAccess(payload);
  const tier = sub?.tier ?? access?.subscription_tier;
  const plan = sub?.plan || (tier != null ? `tier ${tier}` : null);
  if (plan) {
    const monthlyCharge = usd(sub?.monthly_charge ?? access?.subscription_monthly_charge);
    return {
      plan,
      subscription: `Nous ${plan}${monthlyCharge ? ` · ${monthlyCharge}/mo` : ""}`,
    };
  }
  if (hermesPaidAccessAllowed(payload) === true || access?.active_subscription_is_paid) {
    return { plan: null, subscription: "Nous Portal (paid)" };
  }
  return { plan: null, subscription: "Nous Portal" };
}

function emptySnapshot(
  bin: ReturnType<typeof detectHermes>,
  slot: HermesNousSlot | null,
): ProviderSnapshot {
  const selection = readHermesActiveSelection(hermesHome());
  const multi = Boolean(slot && slot.profileLabel && slot.profileLabel !== "default");
  const label = slot?.profileLabel || "default";
  return baseSnapshot({
    id: "hermes",
    displayName: multi ? `Hermes · ${label}` : "Hermes",
    installed: bin.installed,
    binary: bin.path,
    version: bin.version,
    profileId: slot?.profileId || "default",
    profileLabel: label,
    configDir: hermesHome(),
    active: true,
    activeProvider: selection.provider,
    activeModel: selection.model,
  });
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

  // Adopt tokens Hermes already wrote to providers.nous before any HTTP refresh.
  // Stale pool RTs are single-use — refreshing them revokes the whole session.
  if (syncSlotFromAuthStore(slot)) {
    state = slot.state;
  }

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

  // Keep credential_pool.nous in lockstep — stale mirrored RTs get revoked by Nous on reuse
  if (slot.poolIndex < 0) {
    const auth = readAuthFileAt(slot.authFilePath);
    const pool = auth?.credential_pool?.nous;
    if (pool?.length) {
      const stale = pool.some((e) => {
        const sameLabel =
          nonEmpty(slot.profileLabel) &&
          slot.profileLabel !== "default" &&
          e.label?.trim().toLowerCase() === slot.profileLabel.trim().toLowerCase();
        const single = pool.length === 1;
        if (!sameLabel && !single) return false;
        return (
          (nonEmpty(state.refresh_token) && e.refresh_token !== state.refresh_token) ||
          (nonEmpty(state.access_token) && e.access_token !== state.access_token)
        );
      });
      if (stale) persistSlot(slot, state);
    }
  }

  const cacheKey = `hermes-nous-${slot.profileId}`;
  if (!opts.refresh) {
    const cached = readCache<NousAccountPayload>(cacheKey, 60_000);
    if (cached && isNousAccountPayload(cached)) {
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
    if (res.status === 401) base.auth = "expired";
    else if (res.status !== 0) base.auth = "error";
    base.error = res.status === 0
      ? "Nous account unavailable (network error)"
      : `Nous account fetch failed (HTTP ${res.status})`;
    base.source = "portal_account";
    base.hint = res.status === 0
      ? "Could not reach Nous Portal; retry when online."
      : "Open https://portal.nousresearch.com/billing or run `hermes portal`.";
    return base;
  }

  const raw = res.json as Record<string, unknown>;
  if (typeof raw.error === "string" && raw.error) {
    base.auth = "error";
    base.error = raw.error;
    base.source = "portal_account";
    return base;
  }
  if (!isNousAccountPayload(raw)) {
    base.error = "Nous account response missing recognized fields";
    base.source = "portal_account";
    base.hint = "Nous returned an unfamiliar account response; retry or update llmquota.";
    return base;
  }
  const payload = raw;

  writeCache(cacheKey, payload);
  return finalizeAccount(base, payload, "portal_account");
}

function finalizeAccount(
  base: ProviderSnapshot,
  payload: NousAccountPayload,
  source: string,
): ProviderSnapshot {
  const access = paidAccess(payload);
  const labels = hermesSubscriptionLabels(payload);
  base.plan = labels.plan;
  base.subscription = labels.subscription;

  base.account =
    payload.organisation?.name ||
    payload.organisation?.slug ||
    payload.user?.email ||
    null;
  base.source = source;
  base.windows = buildHermesMeters(payload);
  const total = access?.total_usable_credits ?? payload.purchased_credits_remaining ?? null;
  base.score = hermesAvailabilityScore(payload, base.windows, total);
  base.requestAvailability = hermesRequestAvailability(payload, base.score, total);
  base.hint = hermesEntitlementHint(payload);

  return base;
}

export function hermesRequestAvailability(
  payload: NousAccountPayload,
  score: number | null,
  totalUsableCredits: number | null,
): RequestAvailability {
  const allowed = hermesPaidAccessAllowed(payload);
  if (allowed === false) return "blocked";
  if (allowed === true) return "available";
  if (paidAccess(payload)?.member_spend_cap_exceeded === true) return "blocked";
  if (
    typeof totalUsableCredits === "number" &&
    Number.isFinite(totalUsableCredits) &&
    totalUsableCredits > 0
  ) return "available";
  if (score != null) return score >= 100 ? "blocked" : "available";
  return "unknown";
}

function configuredProviderToken(provider: string): string | null {
  const paths = [authPath(), hermesGlobalAuthPath()].filter(
    (path): path is string => Boolean(path),
  );
  for (const path of paths) {
    const token = hermesProviderAccessToken(readAuthFileAt(path), provider);
    if (token) return token;
  }
  return null;
}

function jwtExpiryMs(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp >= 0 ? exp * 1000 : null;
}

function chatGptAccountId(token: string): string | null {
  const claims = decodeJwtPayload(token);
  const auth = claims?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string" && id.trim()) return id;
  }
  const id = claims?.account_id;
  return typeof id === "string" && id.trim() ? id : null;
}

async function collectHermesOpenAiCodex(
  bin: ReturnType<typeof detectHermes>,
): Promise<ProviderSnapshot> {
  const base = emptySnapshot(bin, null);
  base.source = "hermes_auth";
  if (!bin.installed) {
    base.hint = "Install Hermes Agent, then run `hermes model`.";
    return base;
  }
  const nousCredit = cachedNousPurchasedCreditMeter();
  if (nousCredit) base.windows.push(nousCredit);

  const provider = readHermesActiveSelection(hermesHome()).provider || "openai-codex";
  const token = configuredProviderToken(provider);
  if (!token) {
    base.hint = "Run `hermes model` to authenticate the active OpenAI Codex provider.";
    return base;
  }
  const expiresAt = jwtExpiryMs(token);
  if (expiresAt != null && expiresAt <= Date.now() + EXPIRY_SKEW_MS) {
    base.auth = "expired";
    base.error = "Hermes OpenAI Codex token expired";
    base.hint = "Run `hermes model` to re-authenticate OpenAI Codex.";
    return base;
  }

  base.auth = "ok";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const accountId = chatGptAccountId(token);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  const res = await fetchJson("https://chatgpt.com/backend-api/wham/usage", { headers });
  base.source = "hermes_openai_codex_wham";
  if (!res.ok || !res.json || typeof res.json !== "object") {
    if (res.status === 401) base.auth = "expired";
    else if (res.status !== 0) base.auth = "error";
    base.error = res.status === 0
      ? "Hermes OpenAI Codex usage unavailable (network error)"
      : `Hermes OpenAI Codex usage failed (HTTP ${res.status})`;
    base.hint = res.status === 0
      ? "Could not reach ChatGPT usage; retry when online."
      : "Run `hermes model` to re-authenticate OpenAI Codex.";
    return base;
  }
  if (!isCodexUsagePayload(res.json)) {
    base.error = "Hermes OpenAI Codex response missing recognized fields";
    base.hint = "ChatGPT returned an unfamiliar usage response; retry or update llmquota.";
    return base;
  }

  const data = res.json;
  base.plan = data.plan_type ? titleCase(data.plan_type) : null;
  base.subscription = base.plan ? `OpenAI Codex ${base.plan}` : "OpenAI Codex";
  base.account = data.email || null;
  base.windows = [
    ...collectCodexUsageWindows(data, Date.now(), base.activeModel),
    ...(nousCredit ? [nousCredit] : []),
  ];
  base.score = codexUsageScore(data, base.windows, base.activeModel);
  base.requestAvailability = codexRequestAvailability(data, base.activeModel, base.score);
  base.hint = codexUsageHint(data, base.windows);
  return base;
}

function collectHermesUnsupportedProvider(
  bin: ReturnType<typeof detectHermes>,
  provider: string,
): ProviderSnapshot {
  const base = emptySnapshot(bin, null);
  const token = configuredProviderToken(provider);
  if (token) base.auth = "ok";
  base.source = "hermes_auth";
  base.hint = bin.installed
    ? `Quota API unavailable for active Hermes provider ${provider}; no usage is inferred.`
    : "Install Hermes Agent, then configure its model provider.";
  return base;
}

export async function collectHermesAll(
  opts: { refresh?: boolean } = {},
): Promise<ProviderSnapshot[]> {
  const bin = detectHermes();
  const selection = readHermesActiveSelection(hermesHome());
  if (!isNousProvider(selection.provider)) {
    if (isOpenAiCodexProvider(selection.provider)) {
      return [await collectHermesOpenAiCodex(bin)];
    }
    return [collectHermesUnsupportedProvider(bin, selection.provider!)];
  }
  const slots = discoverConfiguredNousSlots();
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
