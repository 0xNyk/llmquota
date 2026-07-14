import { existsSync, readFileSync } from "node:fs";
import type { Meter, ProviderSnapshot } from "../types.js";
import {
  availableInFromEpoch,
  fetchJson,
  headroomScore,
  home,
  isoFromEpochSec,
  windowLabel,
} from "../util.js";
import { detectCodex } from "./detect.js";

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

interface CodexWham {
  email?: string;
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: CodexWindow;
    secondary_window?: CodexWindow | null;
  };
  code_review_rate_limit?: {
    primary_window?: CodexWindow;
  } | null;
  additional_rate_limits?: Array<{
    limit_name?: string;
    rate_limit?: { primary_window?: CodexWindow };
  }>;
}

function meterFromWindow(name: string, label: string, w: CodexWindow | undefined | null): Meter | null {
  if (!w || w.used_percent == null) return null;
  const resetsAt = isoFromEpochSec(w.reset_at ?? null);
  return {
    name,
    label: label || windowLabel(w.limit_window_seconds),
    usedPercent: w.used_percent,
    resetsAt,
    availableIn: availableInFromEpoch(w.reset_at) ||
      (w.reset_after_seconds != null
        ? availableInFromEpoch(Math.floor(Date.now() / 1000) + w.reset_after_seconds)
        : null),
    windowSeconds: w.limit_window_seconds ?? null,
  };
}

export async function collectCodex(): Promise<ProviderSnapshot> {
  const bin = detectCodex();
  const base: ProviderSnapshot = {
    id: "codex",
    displayName: "Codex",
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
    base.auth = res.status === 401 ? "expired" : "error";
    base.error = `WHAM usage failed (HTTP ${res.status})`;
    base.hint = "Run `codex login` again.";
    base.source = "wham_usage";
    return base;
  }

  const data = res.json as CodexWham;
  base.plan = data.plan_type ? titleCase(data.plan_type) : null;
  const chatgptPlan = chatgptPlanFromIdToken(auth.tokens?.id_token);
  base.subscription = codexSubscription(base.plan, chatgptPlan);
  base.account = data.email || null;
  base.source = "wham_usage";

  const windows: Meter[] = [];
  const primary = meterFromWindow(
    "primary",
    windowLabel(data.rate_limit?.primary_window?.limit_window_seconds),
    data.rate_limit?.primary_window,
  );
  if (primary) windows.push(primary);
  const secondary = meterFromWindow(
    "secondary",
    windowLabel(data.rate_limit?.secondary_window?.limit_window_seconds),
    data.rate_limit?.secondary_window,
  );
  if (secondary) windows.push(secondary);

  const review = meterFromWindow(
    "code_review",
    "code review",
    data.code_review_rate_limit?.primary_window,
  );
  if (review) windows.push(review);

  for (const extra of data.additional_rate_limits || []) {
    const m = meterFromWindow(
      extra.limit_name || "extra",
      extra.limit_name || "extra",
      extra.rate_limit?.primary_window,
    );
    if (m) windows.push(m);
  }

  base.windows = windows;
  base.score = headroomScore(windows.map((w) => w.usedPercent));
  if (data.rate_limit?.limit_reached) {
    base.hint = `KO — wait ${primary?.availableIn || "a bit"} for the primary window.`;
  }
  return base;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
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
