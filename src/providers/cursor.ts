import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Meter, ProviderSnapshot } from "../types.js";
import {
  availableInFromIso,
  fetchJson,
  headroomScore,
  home,
  isoFromEpochSec,
} from "../util.js";
import { detectCursorAgent } from "./detect.js";

interface CursorAuth {
  accessToken: string | null;
  email: string | null;
  membership: string | null;
  subscriptionStatus: string | null;
}

interface PeriodUsage {
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    limit?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
  spendLimitUsage?: {
    totalSpend?: number;
    individualLimit?: number | null;
    individualUsed?: number;
  };
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
}

function readCursorAuth(): CursorAuth {
  const dbPath = home(
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
  if (!existsSync(dbPath)) {
    return { accessToken: null, email: null, membership: null, subscriptionStatus: null };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const get = (key: string): string | null => {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
        | { value?: string }
        | undefined;
      return row?.value ?? null;
    };
    return {
      accessToken: get("cursorAuth/accessToken"),
      email: get("cursorAuth/cachedEmail"),
      membership: get("cursorAuth/stripeMembershipType"),
      subscriptionStatus: get("cursorAuth/stripeSubscriptionStatus"),
    };
  } finally {
    db.close();
  }
}

function parseMaybeMs(value: string | number | undefined): string | null {
  if (value == null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    if (typeof value === "string" && value.includes("T")) return value;
    return null;
  }
  return isoFromEpochSec(n);
}

export async function collectCursor(): Promise<ProviderSnapshot> {
  const bin = detectCursorAgent();
  const base: ProviderSnapshot = {
    id: "cursor",
    displayName: "Cursor",
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
    base.hint = "Install Cursor Agent CLI (`curl https://cursor.com/install -fsS | bash`).";
    return base;
  }

  const auth = readCursorAuth();
  base.plan = auth.membership ? titleCase(auth.membership) : null;
  base.account = auth.email;

  if (!auth.accessToken) {
    base.hint = "Sign in to the Cursor IDE (usage token lives in local state.vscdb).";
    return base;
  }

  base.auth = "ok";
  if (auth.subscriptionStatus && auth.subscriptionStatus !== "active") {
    base.hint = `Subscription status: ${auth.subscriptionStatus}`;
  }

  const res = await fetchJson(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
    },
  );

  if (!res.ok || !res.json || typeof res.json !== "object") {
    base.auth = res.status === 401 ? "expired" : "error";
    base.error = `dashboard usage failed (HTTP ${res.status})`;
    base.source = "cursor_dashboard";
    base.hint = "Re-open Cursor IDE and sign in again.";
    return base;
  }

  const data = res.json as PeriodUsage;
  base.source = "cursor_dashboard";
  const resetsAt = parseMaybeMs(data.billingCycleEnd);
  const startIso = parseMaybeMs(data.billingCycleStart);
  const pu = data.planUsage || {};

  const windows: Meter[] = [];
  if (pu.totalPercentUsed != null) {
    const limitUsd = pu.limit != null ? pu.limit / 100 : null;
    const usedUsd = pu.totalSpend != null ? pu.totalSpend / 100 : null;
    windows.push({
      name: "plan_total",
      label: "plan",
      usedPercent: pu.totalPercentUsed,
      resetsAt,
      availableIn: availableInFromIso(resetsAt),
      windowSeconds: startIso && resetsAt
        ? Math.max(0, Math.floor((Date.parse(resetsAt) - Date.parse(startIso)) / 1000))
        : null,
      detail:
        usedUsd != null && limitUsd != null
          ? `$${usedUsd.toFixed(2)} against $${limitUsd.toFixed(2)} included (+bonus may apply)`
          : null,
    });
  }
  if (pu.autoPercentUsed != null) {
    windows.push({
      name: "auto",
      label: "auto",
      usedPercent: pu.autoPercentUsed,
      resetsAt,
      availableIn: availableInFromIso(resetsAt),
      windowSeconds: null,
    });
  }
  if (pu.apiPercentUsed != null) {
    windows.push({
      name: "api",
      label: "named/API",
      usedPercent: pu.apiPercentUsed,
      resetsAt,
      availableIn: availableInFromIso(resetsAt),
      windowSeconds: null,
    });
  }

  base.windows = windows;
  base.score = headroomScore(windows.map((w) => w.usedPercent));

  const msg =
    data.displayMessage ||
    data.namedModelSelectedDisplayMessage ||
    data.autoModelSelectedDisplayMessage;
  if (msg) base.hint = msg;
  return base;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
