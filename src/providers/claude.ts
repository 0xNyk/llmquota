import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  discoverClaudeProfiles,
  loadLlmquotaConfig,
  type ClaudeProfileTarget,
} from "../profiles.js";
import type { Meter, ProviderSnapshot } from "../types.js";
import { baseSnapshot, isExpiredAt } from "../snapshot.js";
import {
  availableInFromIso,
  availabilityScore,
  fetchJson,
  hasAnyOwn,
  nonEmpty,
  normalizeIsoTimestamp,
  readCache,
  writeCache,
} from "../util.js";
import { detectClaude } from "./detect.js";
import { readClaudeActiveSelection } from "../active-selection.js";

/** Public Claude Code OAuth client id (embedded in the CLI). */
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const EXPIRY_SKEW_MS = 60_000;

interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface ClaudeMoney {
  amount_minor?: number;
  currency?: string;
  exponent?: number;
}

interface ClaudeSpend {
  used?: ClaudeMoney;
  limit?: ClaudeMoney;
  percent?: number;
  enabled?: boolean;
  disabled_reason?: string | null;
}

interface ClaudeExtraUsage {
  monthly_limit?: number;
  used_credits?: number;
  utilization?: number;
  currency?: string;
  decimal_places?: number;
  is_enabled?: boolean;
  disabled_reason?: string | null;
}

interface ClaudeLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: {
    model?: { display_name?: string | null } | null;
    surface?: string | null;
  } | null;
}

interface ClaudeUsagePayload {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  seven_day_oauth_apps?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow;
  seven_day_opus?: ClaudeUsageWindow;
  seven_day_cowork?: ClaudeUsageWindow | null;
  seven_day_omelette?: ClaudeUsageWindow | null;
  extra_usage?: ClaudeExtraUsage | null;
  spend?: ClaudeSpend | null;
  limits?: ClaudeLimit[];
}

const CLAUDE_USAGE_FIELDS = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_sonnet",
  "seven_day_opus",
  "seven_day_cowork",
  "seven_day_omelette",
  "extra_usage",
  "spend",
  "limits",
] as const;

export function isClaudeUsagePayload(value: unknown): value is ClaudeUsagePayload {
  return hasAnyOwn(value, CLAUDE_USAGE_FIELDS) && value.error == null;
}

interface ClaudeCreds {
  accessToken: string;
  refreshToken?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  source: string;
}

interface ClaudeOauthBlob {
  accessToken?: string;
  refreshToken?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
}

function normalizeExpiresAt(raw: number | undefined): number | undefined {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw < 1e12 ? raw * 1000 : raw;
}

function accessExpired(creds: ClaudeCreds, skewMs = EXPIRY_SKEW_MS): boolean {
  if (!nonEmpty(creds.accessToken)) return true;
  return isExpiredAt(normalizeExpiresAt(creds.expiresAt), skewMs);
}

function fromOauth(oauth: ClaudeOauthBlob | undefined, source: string): ClaudeCreds | null {
  if (!oauth) return null;
  const accessToken = nonEmpty(oauth.accessToken) ? oauth.accessToken : "";
  const refreshToken = nonEmpty(oauth.refreshToken) ? oauth.refreshToken : undefined;
  if (!accessToken && !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
    expiresAt: normalizeExpiresAt(oauth.expiresAt),
    refreshTokenExpiresAt: normalizeExpiresAt(oauth.refreshTokenExpiresAt),
    scopes: oauth.scopes,
    source,
  };
}

function readKeychainRaw(): { claudeAiOauth?: ClaudeOauthBlob } | null {
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!raw.startsWith("{")) return null;
    return JSON.parse(raw) as { claudeAiOauth?: ClaudeOauthBlob };
  } catch {
    return null;
  }
}

function credsFilePath(configDir: string): string {
  return join(configDir, ".credentials.json");
}

function readFileRaw(
  configDir: string,
): { path: string; data: { claudeAiOauth?: ClaudeOauthBlob } } | null {
  const path = credsFilePath(configDir);
  if (!existsSync(path)) return null;
  try {
    return {
      path,
      data: JSON.parse(readFileSync(path, "utf8")) as { claudeAiOauth?: ClaudeOauthBlob },
    };
  } catch {
    return null;
  }
}

function readEnvCreds(): ClaudeCreds | null {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!nonEmpty(token)) return null;
  return {
    accessToken: token,
    source: "env:CLAUDE_CODE_OAUTH_TOKEN",
  };
}

function scoreCreds(c: ClaudeCreds): number {
  let s = 0;
  if (nonEmpty(c.accessToken) && !accessExpired(c)) s += 1_000_000_000_000;
  else if (nonEmpty(c.accessToken)) s += 1_000_000_000;
  if (nonEmpty(c.refreshToken)) s += 1_000_000;
  s += normalizeExpiresAt(c.expiresAt) ?? 0;
  return s;
}

function mergeMeta(into: ClaudeCreds, from: ClaudeCreds): void {
  if (!into.subscriptionType && from.subscriptionType) into.subscriptionType = from.subscriptionType;
  if (!into.rateLimitTier && from.rateLimitTier) into.rateLimitTier = from.rateLimitTier;
  if (!into.scopes?.length && from.scopes?.length) into.scopes = from.scopes;
  if (!into.refreshToken && from.refreshToken) into.refreshToken = from.refreshToken;
  if (!into.refreshTokenExpiresAt && from.refreshTokenExpiresAt) {
    into.refreshTokenExpiresAt = from.refreshTokenExpiresAt;
  }
}

/** Scoped credential read — silo profiles never merge global Keychain (shared on macOS). */
function readClaudeCreds(target: ClaudeProfileTarget): ClaudeCreds | null {
  const candidates: ClaudeCreds[] = [];

  // Env token only applies to the active / default slot
  if (target.useKeychain || target.active) {
    const env = readEnvCreds();
    if (env) candidates.push(env);
  }

  if (target.useKeychain) {
    const kc = fromOauth(readKeychainRaw()?.claudeAiOauth, "keychain");
    if (kc) candidates.push(kc);
  }

  const file = readFileRaw(target.configDir);
  const fileCreds = fromOauth(file?.data.claudeAiOauth, `file:${target.profileId}`);
  if (fileCreds) candidates.push(fileCreds);

  if (target.useKeychain) {
    const kcMeta = readKeychainRaw()?.claudeAiOauth;
    if (kcMeta && !nonEmpty(kcMeta.accessToken) && !nonEmpty(kcMeta.refreshToken)) {
      for (const c of candidates) {
        if (!c.subscriptionType && kcMeta.subscriptionType) {
          c.subscriptionType = kcMeta.subscriptionType;
        }
        if (!c.rateLimitTier && kcMeta.rateLimitTier) c.rateLimitTier = kcMeta.rateLimitTier;
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => scoreCreds(b) - scoreCreds(a));
  const best = { ...candidates[0]! };
  for (const c of candidates.slice(1)) mergeMeta(best, c);
  return best;
}

function persistClaudeCreds(creds: ClaudeCreds, target: ClaudeProfileTarget): void {
  const oauth: ClaudeOauthBlob = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    refreshTokenExpiresAt: creds.refreshTokenExpiresAt,
    scopes: creds.scopes,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };
  for (const k of Object.keys(oauth) as Array<keyof ClaudeOauthBlob>) {
    if (oauth[k] === undefined) delete oauth[k];
  }

  const filePath = credsFilePath(target.configDir);
  let data: { claudeAiOauth?: ClaudeOauthBlob } = {};
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, "utf8")) as typeof data;
    } catch {
      data = {};
    }
  }
  data.claudeAiOauth = { ...data.claudeAiOauth, ...oauth };
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });

  // Keychain is a single shared item on macOS — only the default slot may write it.
  if (!target.useKeychain) return;

  const payload = JSON.stringify({ claudeAiOauth: data.claudeAiOauth });
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        userInfo().username,
        "-w",
        payload,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    /* file write is enough */
  }
}

async function refreshClaudeAccess(
  creds: ClaudeCreds,
  target: ClaudeProfileTarget,
): Promise<{ ok: true; creds: ClaudeCreds } | { ok: false; error: string }> {
  if (!nonEmpty(creds.refreshToken)) {
    return { ok: false, error: "no refresh token" };
  }

  const res = await fetchJson(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "claude-cli/2.1.207 (external, cli)",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
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
  };
  if (!nonEmpty(data.access_token)) {
    return { ok: false, error: "refresh response missing access_token" };
  }

  const next: ClaudeCreds = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: nonEmpty(data.refresh_token) ? data.refresh_token : creds.refreshToken,
    expiresAt:
      data.expires_in != null ? Date.now() + data.expires_in * 1000 : creds.expiresAt,
    source: `${creds.source}+refresh`,
  };

  persistClaudeCreds(next, target);
  return { ok: true, creds: next };
}

function planLabel(creds: ClaudeCreds | null): string | null {
  if (!creds) return null;
  const tier = creds.rateLimitTier || "";
  if (tier.includes("max_20x")) return "Max 20x";
  if (tier.includes("max_5x")) return "Max 5x";
  if (tier.includes("pro") || tier.includes("claude_pro")) return "Pro";
  if (creds.subscriptionType === "max") return "Max";
  if (creds.subscriptionType === "pro") return "Pro";
  if (creds.subscriptionType === "free") return "Free";
  return creds.subscriptionType || null;
}

function subscriptionLabel(creds: ClaudeCreds | null): string | null {
  const plan = planLabel(creds);
  if (!plan) return null;
  if (plan.startsWith("Max")) return `Claude ${plan}`;
  if (plan === "Pro") return "Claude Pro";
  if (plan === "Free") return "Claude Free";
  return `Claude ${plan}`;
}

function meterFrom(
  name: string,
  label: string,
  w: ClaudeUsageWindow | null | undefined,
): Meter | null {
  if (!w || w.utilization == null) return null;
  const usedPercent = Number(w.utilization);
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return null;
  const resetsAt = normalizeIsoTimestamp(w.resets_at);
  return {
    name,
    label,
    usedPercent,
    resetsAt,
    availableIn: availableInFromIso(resetsAt),
    windowSeconds: name === "five_hour" ? 5 * 3600 : 7 * 86400,
  };
}

function moneyLabel(money: ClaudeMoney | undefined): string | null {
  const amount = money?.amount_minor;
  const currency = money?.currency;
  const exponent = money?.exponent;
  if (
    amount == null ||
    !Number.isFinite(amount) ||
    !currency ||
    exponent == null ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 6
  ) {
    return null;
  }
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amount / 10 ** exponent);
  } catch {
    return `${(amount / 10 ** exponent).toFixed(exponent)} ${currency}`;
  }
}

function spendMeter(
  spend: ClaudeSpend | null | undefined,
  extra: ClaudeExtraUsage | null | undefined,
): Meter | null {
  if (!spend && !extra) return null;
  const percent = Number(extra?.utilization ?? spend?.percent);
  if (!Number.isFinite(percent) || percent < 0) return null;
  const fallbackMoney = (amount: number | undefined): ClaudeMoney | undefined =>
    amount == null
      ? undefined
      : {
          amount_minor: amount,
          currency: extra?.currency,
          exponent: extra?.decimal_places,
        };
  const used = moneyLabel(spend?.used ?? fallbackMoney(extra?.used_credits));
  const limit = moneyLabel(spend?.limit ?? fallbackMoney(extra?.monthly_limit));
  const enabled = extra?.is_enabled ?? spend?.enabled;
  const disabledReason = extra?.disabled_reason ?? spend?.disabled_reason;
  const status =
    enabled === false
      ? `disabled${disabledReason ? ` (${disabledReason.replace(/_/g, " ")})` : ""}`
      : null;
  return {
    name: "extra_usage",
    label: "extra usage",
    usedPercent: percent,
    resetsAt: null,
    availableIn: null,
    windowSeconds: null,
    detail: [used && limit ? `${used} / ${limit} used` : used ? `${used} used` : null, status]
      .filter(Boolean)
      .join(" · ") || null,
    affectsAvailability: false,
  };
}

function displayNameFor(target: ClaudeProfileTarget): string {
  if (target.profileId === "default") return "Claude";
  return `Claude · ${target.profileLabel}`;
}

function emptySnapshot(
  bin: ReturnType<typeof detectClaude>,
  target: ClaudeProfileTarget,
): ProviderSnapshot {
  const selection = readClaudeActiveSelection(target.configDir);
  return baseSnapshot({
    id: "claude",
    displayName: displayNameFor(target),
    installed: bin.installed,
    binary: bin.path,
    version: bin.version,
    profileId: target.profileId,
    profileLabel: target.profileLabel,
    configDir: target.configDir,
    active: target.active,
    activeProvider: selection.provider,
    activeModel: selection.model,
  });
}

export async function collectClaudeProfile(
  target: ClaudeProfileTarget,
  opts: { refresh?: boolean } = {},
): Promise<ProviderSnapshot> {
  const bin = detectClaude();
  const base = emptySnapshot(bin, target);

  if (!bin.installed) {
    base.hint = "Install Claude Code, then run `claude` and sign in.";
    return base;
  }

  if (!target.hasCreds && !target.useKeychain) {
    base.hint =
      target.source === "silo"
        ? `Run \`silo auth login ${target.profileId}\`.`
        : "Run `claude` and complete `/login`.";
    return base;
  }

  let creds = readClaudeCreds(target);
  if (!creds) {
    base.hint =
      target.source === "silo"
        ? `Run \`silo auth login ${target.profileId}\`.`
        : "Run `claude` and complete `/login`.";
    return base;
  }

  base.plan = planLabel(creds);
  base.subscription = subscriptionLabel(creds);

  // The usage endpoint is authoritative. Claude credential expiry metadata can lag
  // token validity, while an old refresh token may already be revoked.
  if (!nonEmpty(creds.accessToken)) {
    if (nonEmpty(creds.refreshToken)) {
      const refreshed = await refreshClaudeAccess(creds, target);
      if (refreshed.ok) {
        creds = refreshed.creds;
      } else {
        base.auth = "expired";
        base.error = refreshed.error;
        base.hint =
          target.source === "silo"
            ? `Token expired — \`silo auth login ${target.profileId}\`.`
            : "Token expired — open `claude` and re-auth (`/login`).";
        return base;
      }
    } else {
      base.auth = "expired";
      base.hint =
        target.source === "silo"
          ? `Token expired — \`silo auth login ${target.profileId}\`.`
          : "Token expired — open `claude` and re-auth (`/login`).";
      return base;
    }
  }

  base.auth = "ok";

  const cacheKey = `claude-usage-${target.profileId}`;
  if (!opts.refresh) {
    const cached = readCache<ClaudeUsagePayload>(cacheKey, 90_000);
    if (cached && isClaudeUsagePayload(cached)) {
      base.windows = collectClaudeUsageWindows(cached);
      base.source = "oauth_usage(cache)";
      base.score = availabilityScore(base.windows);
      base.requestAvailability = base.score == null
        ? "unknown"
        : base.score >= 100 ? "blocked" : "available";
      return base;
    }
  }

  const fetchUsage = (token: string) =>
    fetchJson("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-cli/${bin.version || "2.1.0"} (external, cli)`,
        "Content-Type": "application/json",
      },
    });

  let res = await fetchUsage(creds.accessToken);

  if (res.status === 401 && nonEmpty(creds.refreshToken)) {
    const refreshed = await refreshClaudeAccess(creds, target);
    if (refreshed.ok) {
      creds = refreshed.creds;
      res = await fetchUsage(creds.accessToken);
      if (res.ok && isClaudeUsagePayload(res.json)) {
        const payload = res.json as ClaudeUsagePayload;
        writeCache(cacheKey, payload);
        base.windows = collectClaudeUsageWindows(payload);
        base.source = "oauth_usage(refreshed)";
        base.score = availabilityScore(base.windows);
        base.requestAvailability = base.score == null
          ? "unknown"
          : base.score >= 100 ? "blocked" : "available";
        return base;
      }
    } else {
      base.auth = "expired";
      base.error = refreshed.error;
      base.hint =
        target.source === "silo"
          ? `Token expired — \`silo auth login ${target.profileId}\`.`
          : "Token expired — open `claude` and re-auth (`/login`).";
      return base;
    }
  }

  if (res.status === 429) {
    base.error = "usage API rate-limited (try again in a minute)";
    base.source = "oauth_usage";
    base.hint = "Plan known from credentials; live % pending. Or check `/usage` inside claude.";
    return base;
  }

  if (!res.ok || !res.json || typeof res.json !== "object") {
    base.auth = res.status === 401 ? "error" : "ok";
    base.error = res.status === 0
      ? "usage unavailable (network error)"
      : `usage fetch failed (HTTP ${res.status})`;
    base.source = "oauth_usage";
    base.hint = res.status === 0
      ? "Could not reach Anthropic usage; retry when online."
      : "Open `claude` and run `/usage`, or re-login.";
    return base;
  }

  if (!isClaudeUsagePayload(res.json)) {
    base.error = "usage response missing recognized fields";
    base.source = "oauth_usage";
    base.hint = "Anthropic returned an unfamiliar usage response; retry or update llmquota.";
    return base;
  }

  const payload = res.json;
  writeCache(cacheKey, payload);
  base.windows = collectClaudeUsageWindows(payload);
  base.source = "oauth_usage";
  base.score = availabilityScore(base.windows);
  base.requestAvailability = base.score == null
    ? "unknown"
    : base.score >= 100 ? "blocked" : "available";
  return base;
}

/** Collect default + silo Claude profiles (see https://github.com/0xNyk/silo). */
export async function collectClaudeAll(
  opts: { refresh?: boolean } = {},
): Promise<ProviderSnapshot[]> {
  const cfg = loadLlmquotaConfig();
  const targets = discoverClaudeProfiles(cfg);
  // Cap parallel usage fetches so we don't stampede Anthropic
  const out: ProviderSnapshot[] = [];
  const concurrency = 3;
  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const snaps = await Promise.all(batch.map((t) => collectClaudeProfile(t, opts)));
    out.push(...snaps);
  }
  return out;
}

/** Back-compat: single default (or first) Claude snapshot. */
export async function collectClaude(opts: { refresh?: boolean } = {}): Promise<ProviderSnapshot> {
  const all = await collectClaudeAll(opts);
  return (
    all.find((p) => p.active && p.auth === "ok") ||
    all.find((p) => p.profileId === "default") ||
    all[0]!
  );
}

export function collectClaudeUsageWindows(payload: ClaudeUsagePayload): Meter[] {
  const order: Array<[string, string]> = [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
    ["seven_day_oauth_apps", "7d OAuth apps"],
    ["seven_day_sonnet", "7d Sonnet"],
    ["seven_day_opus", "7d Opus"],
    ["seven_day_cowork", "7d Cowork"],
    ["seven_day_omelette", "7d Omelette"],
  ];
  const meters: Meter[] = [];
  for (const [key, label] of order) {
    const m = meterFrom(
      key,
      label,
      payload[key as keyof ClaudeUsagePayload] as ClaudeUsageWindow | null | undefined,
    );
    if (m) meters.push(m);
  }
  for (const limit of payload.limits || []) {
    if (limit.is_active !== true) continue;
    const kind = limit.kind || limit.group || "limit";
    const duplicate =
      (limit.group === "session" && meters.some((m) => m.name === "five_hour")) ||
      (kind === "weekly_all" && meters.some((m) => m.name === "seven_day"));
    if (duplicate) continue;
    const scope = limit.scope?.model?.display_name || limit.scope?.surface;
    const label = scope || kind.replace(/_/g, " ");
    const meter = meterFrom(kind, label, {
      utilization: limit.percent,
      resets_at: limit.resets_at || undefined,
    });
    if (meter) meters.push(meter);
  }
  const spend = spendMeter(payload.spend, payload.extra_usage);
  if (spend) meters.push(spend);
  return meters;
}
