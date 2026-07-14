import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { Meter, ProviderSnapshot } from "../types.js";
import {
  availableInFromIso,
  fetchJson,
  headroomScore,
  home,
  readCache,
  writeCache,
} from "../util.js";
import { detectClaude } from "./detect.js";

/** Public Claude Code OAuth client id (embedded in the CLI). */
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Refresh a minute before wall-clock expiry. */
const EXPIRY_SKEW_MS = 60_000;

interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface ClaudeUsagePayload {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  seven_day_sonnet?: ClaudeUsageWindow;
  seven_day_opus?: ClaudeUsageWindow;
  [key: string]: ClaudeUsageWindow | undefined;
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

function nonEmpty(s: string | undefined | null): s is string {
  return typeof s === "string" && s.length > 0;
}

function normalizeExpiresAt(raw: number | undefined): number | undefined {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return undefined;
  // Seconds vs ms heuristic (same idea as Cursor epochs).
  return raw < 1e12 ? raw * 1000 : raw;
}

function accessExpired(creds: ClaudeCreds, skewMs = EXPIRY_SKEW_MS): boolean {
  if (!nonEmpty(creds.accessToken)) return true;
  const exp = normalizeExpiresAt(creds.expiresAt);
  if (exp == null) return false; // unknown expiry — try the token
  return exp <= Date.now() + skewMs;
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

function readFileRaw(): { path: string; data: { claudeAiOauth?: ClaudeOauthBlob } } | null {
  const path = home(".claude", ".credentials.json");
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
  // Prefer live access tokens; then furthest expiry; then presence of refresh.
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

function readClaudeCreds(): ClaudeCreds | null {
  const candidates: ClaudeCreds[] = [];

  const env = readEnvCreds();
  if (env) candidates.push(env);

  const kc = fromOauth(readKeychainRaw()?.claudeAiOauth, "keychain");
  if (kc) candidates.push(kc);

  const file = readFileRaw();
  const fileCreds = fromOauth(file?.data.claudeAiOauth, "file");
  if (fileCreds) candidates.push(fileCreds);

  // Metadata-only keychain (empty tokens) still carries plan labels
  const kcMeta = readKeychainRaw()?.claudeAiOauth;
  if (kcMeta && (!nonEmpty(kcMeta.accessToken) && !nonEmpty(kcMeta.refreshToken))) {
    for (const c of candidates) {
      if (!c.subscriptionType && kcMeta.subscriptionType) c.subscriptionType = kcMeta.subscriptionType;
      if (!c.rateLimitTier && kcMeta.rateLimitTier) c.rateLimitTier = kcMeta.rateLimitTier;
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => scoreCreds(b) - scoreCreds(a));
  const best = { ...candidates[0]! };
  for (const c of candidates.slice(1)) mergeMeta(best, c);
  return best;
}

function persistClaudeCreds(creds: ClaudeCreds): void {
  const oauth: ClaudeOauthBlob = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    refreshTokenExpiresAt: creds.refreshTokenExpiresAt,
    scopes: creds.scopes,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };
  // Drop undefined keys so we don't wipe optional fields with nulls awkwardly
  for (const k of Object.keys(oauth) as Array<keyof ClaudeOauthBlob>) {
    if (oauth[k] === undefined) delete oauth[k];
  }

  const filePath = home(".claude", ".credentials.json");
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
    /* file write is enough for detection; Keychain may be locked */
  }
}

async function refreshClaudeAccess(
  creds: ClaudeCreds,
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

  // Persist immediately — Anthropic rotates refresh tokens; losing the new one bricks auth.
  persistClaudeCreds(next);
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
  w: ClaudeUsageWindow | undefined,
): Meter | null {
  if (!w || w.utilization == null) return null;
  const used = Number(w.utilization);
  // API may return 0–1 or 0–100
  const usedPercent = used <= 1 ? used * 100 : used;
  return {
    name,
    label,
    usedPercent,
    resetsAt: w.resets_at || null,
    availableIn: availableInFromIso(w.resets_at),
    windowSeconds: name === "five_hour" ? 5 * 3600 : 7 * 86400,
  };
}

export async function collectClaude(opts: { refresh?: boolean } = {}): Promise<ProviderSnapshot> {
  const bin = detectClaude();
  const base: ProviderSnapshot = {
    id: "claude",
    displayName: "Claude",
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
    base.hint = "Install Claude Code, then run `claude` and sign in.";
    return base;
  }

  let creds = readClaudeCreds();
  if (!creds) {
    base.hint = "Run `claude` and complete `/login`.";
    return base;
  }

  base.plan = planLabel(creds);
  base.subscription = subscriptionLabel(creds);

  if (accessExpired(creds)) {
    if (nonEmpty(creds.refreshToken)) {
      const refreshed = await refreshClaudeAccess(creds);
      if (refreshed.ok) {
        creds = refreshed.creds;
      } else {
        base.auth = "expired";
        base.error = refreshed.error;
        base.hint = "Token expired — open `claude` and re-auth (`/login`).";
        return base;
      }
    } else {
      base.auth = "expired";
      base.hint = "Token expired — open `claude` and re-auth (`/login`).";
      return base;
    }
  }

  base.auth = "ok";

  const cacheKey = "claude-usage";
  if (!opts.refresh) {
    const cached = readCache<ClaudeUsagePayload>(cacheKey, 90_000);
    if (cached) {
      base.windows = collectWindows(cached);
      base.source = "oauth_usage(cache)";
      base.score = headroomScore(base.windows.map((w) => w.usedPercent));
      return base;
    }
  }

  const res = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": `claude-cli/${bin.version || "2.1.0"} (external, cli)`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 401 && nonEmpty(creds.refreshToken)) {
    const refreshed = await refreshClaudeAccess(creds);
    if (refreshed.ok) {
      creds = refreshed.creds;
      const retry = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": `claude-cli/${bin.version || "2.1.0"} (external, cli)`,
          "Content-Type": "application/json",
        },
      });
      if (retry.ok && retry.json && typeof retry.json === "object") {
        const payload = retry.json as ClaudeUsagePayload;
        writeCache(cacheKey, payload);
        base.windows = collectWindows(payload);
        base.source = "oauth_usage(refreshed)";
        base.score = headroomScore(base.windows.map((w) => w.usedPercent));
        return base;
      }
    } else {
      base.auth = "expired";
      base.error = refreshed.error;
      base.hint = "Token expired — open `claude` and re-auth (`/login`).";
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
    base.error = `usage fetch failed (HTTP ${res.status})`;
    base.source = "oauth_usage";
    base.hint = "Open `claude` and run `/usage`, or re-login.";
    return base;
  }

  const payload = res.json as ClaudeUsagePayload;
  writeCache(cacheKey, payload);
  base.windows = collectWindows(payload);
  base.source = "oauth_usage";
  base.score = headroomScore(base.windows.map((w) => w.usedPercent));
  return base;
}

function collectWindows(payload: ClaudeUsagePayload): Meter[] {
  const order: Array<[string, string]> = [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
    ["seven_day_sonnet", "7d Sonnet"],
    ["seven_day_opus", "7d Opus"],
  ];
  const meters: Meter[] = [];
  for (const [key, label] of order) {
    const m = meterFrom(key, label, payload[key]);
    if (m) meters.push(m);
  }
  return meters;
}
