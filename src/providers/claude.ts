import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  subscriptionType?: string;
  rateLimitTier?: string;
  expiresAt?: number;
}

function readClaudeCreds(): ClaudeCreds | null {
  const candidates: ClaudeCreds[] = [];

  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as {
        claudeAiOauth?: {
          accessToken?: string;
          subscriptionType?: string;
          rateLimitTier?: string;
          expiresAt?: number;
        };
      };
      const oauth = parsed.claudeAiOauth;
      if (oauth?.accessToken) {
        candidates.push({
          accessToken: oauth.accessToken,
          subscriptionType: oauth.subscriptionType,
          rateLimitTier: oauth.rateLimitTier,
          expiresAt: oauth.expiresAt,
        });
      }
    }
  } catch {
    /* fall through */
  }

  const file = home(".claude", ".credentials.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        claudeAiOauth?: {
          accessToken?: string;
          subscriptionType?: string;
          rateLimitTier?: string;
          expiresAt?: number;
        };
      };
      const oauth = parsed.claudeAiOauth;
      if (oauth?.accessToken) {
        candidates.push({
          accessToken: oauth.accessToken,
          subscriptionType: oauth.subscriptionType,
          rateLimitTier: oauth.rateLimitTier,
          expiresAt: oauth.expiresAt,
        });
      }
    } catch {
      /* ignore */
    }
  }

  if (!candidates.length) return null;
  // Prefer the token that expires furthest in the future
  candidates.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const best = candidates[0]!;
  // Merge plan metadata from any candidate that has it
  for (const c of candidates) {
    if (!best.subscriptionType && c.subscriptionType) best.subscriptionType = c.subscriptionType;
    if (!best.rateLimitTier && c.rateLimitTier) best.rateLimitTier = c.rateLimitTier;
  }
  return best;
}

function planLabel(creds: ClaudeCreds | null): string | null {
  if (!creds) return null;
  const tier = creds.rateLimitTier || "";
  if (tier.includes("max_20x")) return "Max 20x";
  if (tier.includes("max_5x")) return "Max 5x";
  if (tier.includes("pro")) return "Pro";
  if (creds.subscriptionType === "max") return "Max";
  if (creds.subscriptionType === "pro") return "Pro";
  return creds.subscriptionType || null;
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
    account: null,
    windows: [],
    source: "none",
    error: null,
    hint: null,
    score: null,
  };

  if (!bin.installed) {
    base.hint = "Install Claude Code, then run `claude` and sign in.";
    return base;
  }

  const creds = readClaudeCreds();
  if (!creds) {
    base.hint = "Run `claude` and complete `/login`.";
    return base;
  }

  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    base.auth = "expired";
    base.plan = planLabel(creds);
    base.hint = "Token expired — open `claude` and re-auth.";
    return base;
  }

  base.auth = "ok";
  base.plan = planLabel(creds);

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
