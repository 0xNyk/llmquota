import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId, ReferralInfo } from "./types.js";

export interface ReferralConfigFile {
  claude?: { code?: string; link?: string };
  codex?: { code?: string; link?: string };
  cursor?: { code?: string; link?: string };
  grok?: { code?: string; link?: string };
}

function configPath(): string {
  return (
    process.env.LLMQUOTA_REFERRALS ||
    join(homedir(), ".config", "llmquota", "referrals.json")
  );
}

export function loadReferralConfig(): ReferralConfigFile {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReferralConfigFile;
  } catch {
    return {};
  }
}

export function ensureReferralConfigExample(): string {
  const dir = join(homedir(), ".config", "llmquota");
  const path = join(dir, "referrals.json");
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true });
  const example: ReferralConfigFile = {
    cursor: {
      code: "YOUR_CODE",
      link: "https://cursor.com/referral?code=YOUR_CODE",
    },
    codex: { link: "" },
    grok: { link: "" },
  };
  writeFileSync(path, `${JSON.stringify(example, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function fromConfig(
  id: ProviderId,
  cfg: ReferralConfigFile,
): ReferralInfo | null {
  const entry = cfg[id];
  if (!entry) return null;
  const code = entry.code?.trim() || null;
  let link = entry.link?.trim() || null;
  if (!link && code && id === "cursor") {
    link = `https://cursor.com/referral?code=${encodeURIComponent(code)}`;
  }
  if (!link && code && id === "claude") {
    link = `https://claude.ai/referral/${encodeURIComponent(code)}`;
  }
  if (!link && !code) return null;
  return {
    code,
    link,
    label: link || code || "",
    source: "config",
    detail: null,
  };
}

/** Claude guest-pass / referral from ~/.claude.json (Max plans). */
export function detectClaudeReferral(): ReferralInfo | null {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      passesEligibilityCache?: Record<
        string,
        {
          eligible?: boolean;
          remaining_passes?: number;
          limit?: number;
          share_link?: string;
          referral_code_details?: {
            code?: string;
            campaign?: string;
            referral_link?: string;
          };
          referrer_reward?: { amount_minor_units?: number; currency?: string };
        }
      >;
    };
    const cache = raw.passesEligibilityCache || {};
    // Prefer eligible entry with a link; else any with a link
    const entries = Object.values(cache).filter(
      (e) => e?.referral_code_details?.referral_link || e?.share_link,
    );
    entries.sort((a, b) => Number(b.eligible) - Number(a.eligible));
    const best = entries[0];
    if (!best) return null;
    const code = best.referral_code_details?.code || null;
    const link =
      best.referral_code_details?.referral_link || best.share_link || null;
    if (!link && !code) return null;
    const reward = best.referrer_reward;
    const rewardStr =
      reward?.amount_minor_units != null && reward.currency
        ? `${(reward.amount_minor_units / 100).toFixed(0)} ${reward.currency}`
        : null;
    const passes =
      best.remaining_passes != null
        ? `${best.remaining_passes}/${best.limit ?? best.remaining_passes} passes`
        : null;
    const detail = [passes, rewardStr ? `reward ${rewardStr}` : null]
      .filter(Boolean)
      .join(" · ");
    return {
      code,
      link,
      label: link || code || "",
      source: "claude.json",
      detail: detail || null,
    };
  } catch {
    return null;
  }
}

export function resolveReferral(id: ProviderId): ReferralInfo | null {
  const cfg = loadReferralConfig();
  const configured = fromConfig(id, cfg);
  if (id === "claude") {
    const detected = detectClaudeReferral();
    // Config overrides auto-detect when set
    if (configured?.link || configured?.code) return configured;
    return detected;
  }
  if (configured) return configured;
  // Cursor: point at dashboard if no personal code yet
  if (id === "cursor") {
    return {
      code: null,
      link: "https://cursor.com/dashboard/referrals",
      label: "https://cursor.com/dashboard/referrals",
      source: "dashboard",
      detail: "open dashboard for your code (limited rollout) · or set ~/.config/llmquota/referrals.json",
    };
  }
  return null;
}

export function attachReferrals<T extends { id: ProviderId; referral?: ReferralInfo | null }>(
  providers: T[],
): T[] {
  return providers.map((p) => ({
    ...p,
    referral: resolveReferral(p.id),
  }));
}
