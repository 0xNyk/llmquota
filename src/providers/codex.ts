import { existsSync, readFileSync } from "node:fs";
import type { Meter, ProviderSnapshot, RequestAvailability } from "../types.js";
import {
  availableInFromEpoch,
  availabilityScore,
  decodeJwtPayload,
  fetchJson,
  hasAnyOwn,
  home,
  isoFromEpochSec,
  titleCase,
  windowLabel,
} from "../util.js";
import { baseSnapshot } from "../snapshot.js";
import { detectCodex } from "./detect.js";
import { readCodexActiveSelection } from "../active-selection.js";

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
    id_token?: string;
  };
}

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface CodexRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: CodexWindow;
  secondary_window?: CodexWindow | null;
}

export interface CodexWham {
  email?: string;
  plan_type?: string;
  rate_limit?: CodexRateLimit;
  code_review_rate_limit?: CodexRateLimit | null;
  additional_rate_limits?: Array<{
    limit_name?: string;
    rate_limit?: CodexRateLimit;
  }>;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    overage_limit_reached?: boolean;
    balance?: string | number;
  };
  spend_control?: { reached?: boolean; individual_limit?: number | null };
  rate_limit_reached_type?: string | null;
  rate_limit_reset_credits?: { available_count?: number };
}

const CODEX_USAGE_FIELDS = [
  "email",
  "plan_type",
  "rate_limit",
  "code_review_rate_limit",
  "additional_rate_limits",
  "credits",
  "spend_control",
  "rate_limit_reached_type",
  "rate_limit_reset_credits",
] as const;

export function isCodexUsagePayload(value: unknown): value is CodexWham {
  return hasAnyOwn(value, CODEX_USAGE_FIELDS) && value.error == null;
}

function meterFromWindow(
  name: string,
  label: string,
  w: CodexWindow | undefined | null,
  nowMs: number,
  affectsAvailability = true,
): Meter | null {
  if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent) || w.used_percent < 0) {
    return null;
  }
  let resetEpoch: number | null = null;
  if (
    typeof w.reset_at === "number" &&
    Number.isFinite(w.reset_at) &&
    isoFromEpochSec(w.reset_at)
  ) {
    resetEpoch = w.reset_at;
  } else if (
    typeof w.reset_after_seconds === "number" &&
    Number.isFinite(w.reset_after_seconds) &&
    w.reset_after_seconds >= 0
  ) {
    const candidate = Math.floor(nowMs / 1000) + w.reset_after_seconds;
    if (isoFromEpochSec(candidate)) resetEpoch = candidate;
  }
  const resetsAt = isoFromEpochSec(resetEpoch);
  return {
    name,
    label: label || windowLabel(w.limit_window_seconds),
    usedPercent: w.used_percent,
    resetsAt,
    availableIn: availableInFromEpoch(resetEpoch),
    windowSeconds: w.limit_window_seconds ?? null,
    affectsAvailability,
  };
}

function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalize(a) === normalize(b);
}

export async function collectCodex(): Promise<ProviderSnapshot> {
  const bin = detectCodex();
  const configDir = home(".codex");
  const selection = readCodexActiveSelection(configDir);
  const base = baseSnapshot({
    id: "codex",
    displayName: "Codex",
    installed: bin.installed,
    binary: bin.path,
    version: bin.version,
    configDir,
    activeProvider: selection.provider,
    activeModel: selection.model,
  });

  if (!bin.installed) {
    base.hint = "Install Codex CLI, then `codex login`.";
    return base;
  }

  const authPath = home(".codex", "auth.json");
  if (!existsSync(authPath)) {
    base.hint = "Run `codex login`.";
    return base;
  }

  let auth: CodexAuth;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuth;
  } catch {
    base.auth = "error";
    base.error = "could not parse ~/.codex/auth.json";
    return base;
  }

  const access = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!access) {
    base.hint = "Run `codex login`.";
    return base;
  }

  base.auth = "ok";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;

  const res = await fetchJson("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!res.ok || !res.json || typeof res.json !== "object") {
    if (res.status === 401) base.auth = "expired";
    else if (res.status !== 0) base.auth = "error";
    base.error = res.status === 0
      ? "WHAM usage unavailable (network error)"
      : `WHAM usage failed (HTTP ${res.status})`;
    base.hint = res.status === 0
      ? "Could not reach ChatGPT usage; retry when online."
      : "Run `codex login` again.";
    base.source = "wham_usage";
    return base;
  }

  if (!isCodexUsagePayload(res.json)) {
    base.error = "WHAM response missing recognized fields";
    base.hint = "ChatGPT returned an unfamiliar usage response; retry or update llmquota.";
    base.source = "wham_usage";
    return base;
  }

  const data = res.json;
  base.plan = data.plan_type ? titleCase(data.plan_type) : null;
  const chatgptPlan = chatgptPlanFromIdToken(auth.tokens?.id_token);
  base.subscription = codexSubscription(base.plan, chatgptPlan);
  base.account = data.email || null;
  base.source = "wham_usage";

  const windows = collectCodexUsageWindows(data, Date.now(), selection.model);
  base.windows = windows;
  base.score = codexUsageScore(data, windows, selection.model);
  base.requestAvailability = codexRequestAvailability(data, selection.model, base.score);
  base.hint = codexUsageHint(data, windows);
  return base;
}

export function codexUsageHint(data: CodexWham, windows: Meter[]): string | null {
  const blocked = codexBlockedLimits(data);
  const notices: string[] = [];
  if (blocked.includes("primary")) {
    const primary = windows.find((w) => w.name === "primary");
    notices.push(`KO — wait ${primary?.availableIn || "a bit"} for the primary window.`);
  }
  const otherBlocked = blocked.filter((name) => name !== "primary");
  if (otherBlocked.length) notices.push(`Blocked limit: ${otherBlocked.join(", ")}.`);
  if (data.rate_limit_reached_type) notices.push(`Limit type: ${data.rate_limit_reached_type}.`);
  if (data.credits?.overage_limit_reached) notices.push("Credit overage limit reached.");
  if (data.spend_control?.reached) notices.push("Spend control reached.");
  return notices.join(" ") || null;
}

export function collectCodexUsageWindows(
  data: CodexWham,
  nowMs = Date.now(),
  activeModel: string | null = null,
): Meter[] {
  const windows: Meter[] = [];
  const primary = meterFromWindow(
    "primary",
    windowLabel(data.rate_limit?.primary_window?.limit_window_seconds),
    data.rate_limit?.primary_window,
    nowMs,
  );
  if (primary) windows.push(primary);
  const secondary = meterFromWindow(
    "secondary",
    windowLabel(data.rate_limit?.secondary_window?.limit_window_seconds),
    data.rate_limit?.secondary_window,
    nowMs,
  );
  if (secondary) windows.push(secondary);

  const review = meterFromWindow(
    "code_review",
    "code review",
    data.code_review_rate_limit?.primary_window,
    nowMs,
    false,
  );
  if (review) windows.push(review);
  const reviewSecondary = meterFromWindow(
    "code_review_secondary",
    "code review secondary",
    data.code_review_rate_limit?.secondary_window,
    nowMs,
    false,
  );
  if (reviewSecondary) windows.push(reviewSecondary);

  for (const extra of data.additional_rate_limits || []) {
    const name = extra.limit_name || "extra";
    const isActiveModelPool = sameModel(name, activeModel);
    const m = meterFromWindow(
      name,
      name,
      extra.rate_limit?.primary_window,
      nowMs,
      isActiveModelPool,
    );
    if (m) windows.push(m);
    const secondaryExtra = meterFromWindow(
      `${name}_secondary`,
      `${name} secondary`,
      extra.rate_limit?.secondary_window,
      nowMs,
      isActiveModelPool,
    );
    if (secondaryExtra) windows.push(secondaryExtra);
  }

  const credits = data.credits;
  const balance = credits?.balance;
  if (
    (balance != null && String(balance).trim()) ||
    typeof credits?.has_credits === "boolean" ||
    credits?.unlimited === true ||
    credits?.overage_limit_reached === true
  ) {
    const flags = [
      balance != null && String(balance).trim() ? `balance ${String(balance).trim()}` : null,
      credits?.has_credits === false ? "none available" : null,
      credits?.has_credits === true && balance == null ? "available" : null,
      credits?.unlimited ? "unlimited" : null,
      credits?.overage_limit_reached ? "overage limit reached" : null,
    ].filter(Boolean);
    windows.push({
      name: "credits",
      label: "credits",
      usedPercent: null,
      resetsAt: null,
      availableIn: null,
      windowSeconds: null,
      detail: flags.join(" · "),
      affectsAvailability: false,
    });
  }
  const resets = data.rate_limit_reset_credits?.available_count;
  if (typeof resets === "number" && Number.isFinite(resets) && resets >= 0) {
    windows.push({
      name: "reset_credits",
      label: "resets",
      usedPercent: null,
      resetsAt: null,
      availableIn: null,
      windowSeconds: null,
      detail: `${resets} rate-limit reset${resets === 1 ? "" : "s"} available`,
      affectsAvailability: false,
    });
  }
  return windows;
}

export function codexBlockedLimits(data: CodexWham): string[] {
  const blocked: string[] = [];
  const add = (label: string, limit: CodexRateLimit | null | undefined) => {
    if (limit?.allowed === false || limit?.limit_reached === true) blocked.push(label);
  };
  add("primary", data.rate_limit);
  add("code review", data.code_review_rate_limit);
  for (const extra of data.additional_rate_limits || []) {
    add(extra.limit_name || "extra", extra.rate_limit);
  }
  return blocked;
}

export function codexUsageScore(
  data: CodexWham,
  windows: Meter[],
  activeModel: string | null = null,
): number | null {
  const primaryBlocked = data.rate_limit?.allowed === false || data.rate_limit?.limit_reached === true;
  const activeModelBlocked = (data.additional_rate_limits || []).some(
    (extra) =>
      sameModel(extra.limit_name, activeModel) &&
      (extra.rate_limit?.allowed === false || extra.rate_limit?.limit_reached === true),
  );
  return primaryBlocked || activeModelBlocked ? 100 : availabilityScore(windows);
}

export function codexRequestAvailability(
  data: CodexWham,
  activeModel: string | null,
  score: number | null,
): RequestAvailability {
  const primaryBlocked = data.rate_limit?.allowed === false || data.rate_limit?.limit_reached === true;
  const activeModelLimit = (data.additional_rate_limits || []).find(
    (extra) => sameModel(extra.limit_name, activeModel),
  )?.rate_limit;
  if (
    primaryBlocked ||
    activeModelLimit?.allowed === false ||
    activeModelLimit?.limit_reached === true
  ) return "blocked";
  if (activeModelLimit?.allowed === true) return "available";
  if (!activeModelLimit && data.rate_limit?.allowed === true) return "available";
  if (score != null && score >= 100) return "blocked";
  if (
    score != null
  ) return "available";
  return "unknown";
}

function chatgptPlanFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const claims = decodeJwtPayload(idToken);
  const auth = claims?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return null;
  const plan = (auth as { chatgpt_plan_type?: string }).chatgpt_plan_type;
  return plan ? titleCase(plan) : null;
}

function codexSubscription(codexPlan: string | null, chatgptPlan: string | null): string | null {
  if (codexPlan && chatgptPlan && chatgptPlan.toLowerCase() !== codexPlan.toLowerCase()) {
    return `Codex ${codexPlan} · ChatGPT ${chatgptPlan}`;
  }
  if (codexPlan) return `Codex ${codexPlan}`;
  if (chatgptPlan) return `ChatGPT ${chatgptPlan}`;
  return null;
}
