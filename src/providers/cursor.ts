import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, win32 } from "node:path";
import type { Meter, ProviderSnapshot } from "../types.js";
import { baseSnapshot } from "../snapshot.js";
import {
  availableInFromIso,
  availabilityScore,
  fetchJson,
  hasAnyOwn,
  home,
  isoFromEpochSec,
  normalizeIsoTimestamp,
  titleCase,
} from "../util.js";
import { detectCursorAgent } from "./detect.js";

interface CursorAuth {
  accessToken: string | null;
  email: string | null;
  membership: string | null;
  subscriptionStatus: string | null;
}

export interface CursorAuthResult extends CursorAuth {
  dbPath: string | null;
  error: string | null;
}

interface CursorStateOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
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
    limitType?: string;
  };
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
}

const CURSOR_USAGE_FIELDS = [
  "billingCycleStart",
  "billingCycleEnd",
  "planUsage",
  "spendLimitUsage",
  "displayMessage",
  "autoModelSelectedDisplayMessage",
  "namedModelSelectedDisplayMessage",
] as const;

export function isCursorUsagePayload(value: unknown): value is PeriodUsage {
  return hasAnyOwn(value, CURSOR_USAGE_FIELDS) && value.error == null;
}

function cents(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

export function cursorStateDbCandidates(opts: CursorStateOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? home();
  const override = env.LLMQUOTA_CURSOR_STATE_DB?.trim();
  if (override) return [override];

  let configRoot: string;
  let joinPath = join;
  if (platform === "darwin") {
    configRoot = join(homeDir, "Library", "Application Support");
  } else if (platform === "win32") {
    joinPath = win32.join;
    configRoot = env.APPDATA?.trim() || joinPath(homeDir, "AppData", "Roaming");
  } else {
    configRoot = env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
  }
  return [joinPath(configRoot, "Cursor", "User", "globalStorage", "state.vscdb")];
}

export function readCursorAuthFromCandidates(paths: string[]): CursorAuthResult {
  let lastError: string | null = null;
  let failedPath: string | null = null;
  for (const dbPath of paths) {
    if (!existsSync(dbPath)) continue;
    failedPath = dbPath;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const get = (key: string): string | null => {
        const row = db!.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
          | { value?: string }
          | undefined;
        return row?.value ?? null;
      };
      return {
        accessToken: get("cursorAuth/accessToken"),
        email: get("cursorAuth/cachedEmail"),
        membership: get("cursorAuth/stripeMembershipType"),
        subscriptionStatus: get("cursorAuth/stripeSubscriptionStatus"),
        dbPath,
        error: null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      db?.close();
    }
  }
  return {
    accessToken: null,
    email: null,
    membership: null,
    subscriptionStatus: null,
    dbPath: failedPath,
    error: lastError,
  };
}

export function cursorInstalled(binInstalled: boolean, auth: CursorAuthResult): boolean {
  return binInstalled || auth.dbPath != null;
}

function parseMaybeMs(value: string | number | undefined): string | null {
  if (value == null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    if (typeof value === "string") return normalizeIsoTimestamp(value);
    return null;
  }
  return isoFromEpochSec(n);
}

export async function collectCursor(): Promise<ProviderSnapshot> {
  const bin = detectCursorAgent();
  const auth = readCursorAuthFromCandidates(cursorStateDbCandidates());
  const installed = cursorInstalled(bin.installed, auth);
  const configDir = auth.dbPath ? dirname(dirname(dirname(auth.dbPath))) : null;
  const base = baseSnapshot({
    id: "cursor",
    displayName: "Cursor",
    installed,
    binary: bin.path,
    version: bin.version,
    configDir,
    activeProvider: "Cursor",
  });

  if (!installed) {
    base.hint = "Install Cursor Agent CLI (`curl https://cursor.com/install -fsS | bash`).";
    return base;
  }

  if (auth.error) {
    base.auth = "error";
    base.error = "Cursor local state database is unreadable";
    base.source = "cursor_local_state";
    base.hint = "Close and re-open Cursor; its local state database could not be read.";
    return base;
  }

  base.plan = auth.membership ? titleCase(auth.membership) : null;
  if (base.plan) {
    const status =
      auth.subscriptionStatus && auth.subscriptionStatus !== "active"
        ? ` · ${auth.subscriptionStatus}`
        : auth.subscriptionStatus === "active"
          ? " · active"
          : "";
    base.subscription = `Cursor ${base.plan}${status}`;
  }
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
    if (res.status === 401) base.auth = "expired";
    else if (res.status !== 0) base.auth = "error";
    base.error = res.status === 0
      ? "dashboard usage unavailable (network error)"
      : `dashboard usage failed (HTTP ${res.status})`;
    base.source = "cursor_dashboard";
    base.hint = res.status === 0
      ? "Could not reach Cursor usage; retry when online."
      : "Re-open Cursor IDE and sign in again.";
    return base;
  }

  if (!isCursorUsagePayload(res.json)) {
    base.error = "dashboard response missing recognized fields";
    base.source = "cursor_dashboard";
    base.hint = "Cursor returned an unfamiliar usage response; retry or update llmquota.";
    return base;
  }

  const data = res.json;
  base.source = "cursor_dashboard";
  const windows = collectCursorUsageWindows(data);
  base.windows = windows;
  base.score = availabilityScore(windows);

  const msg =
    data.displayMessage ||
    data.namedModelSelectedDisplayMessage ||
    data.autoModelSelectedDisplayMessage;
  if (msg) base.hint = msg;
  return base;
}

export function collectCursorUsageWindows(data: PeriodUsage): Meter[] {
  const resetsAt = parseMaybeMs(data.billingCycleEnd);
  const startIso = parseMaybeMs(data.billingCycleStart);
  const pu = data.planUsage || {};
  const windows: Meter[] = [];
  if (validPercent(pu.totalPercentUsed)) {
    const used = cents(pu.totalSpend);
    const included = cents(pu.includedSpend ?? pu.limit);
    const bonus = cents(pu.bonusSpend);
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
        [used ? `${used} used` : null, included ? `${included} plan` : null, bonus ? `${bonus} bonus` : null]
          .filter(Boolean)
          .join(" · ") || null,
    });
  }
  if (validPercent(pu.autoPercentUsed)) {
    windows.push({
      name: "auto",
      label: "auto",
      usedPercent: pu.autoPercentUsed,
      resetsAt,
      availableIn: availableInFromIso(resetsAt),
      windowSeconds: null,
    });
  }
  if (validPercent(pu.apiPercentUsed)) {
    windows.push({
      name: "api",
      label: "named/API",
      usedPercent: pu.apiPercentUsed,
      resetsAt,
      availableIn: availableInFromIso(resetsAt),
      windowSeconds: null,
    });
  }
  const spend = data.spendLimitUsage;
  const spendUsed = spend?.individualUsed ?? spend?.totalSpend;
  const spendLimit = spend?.individualLimit;
  if (
    spendUsed != null &&
    Number.isFinite(spendUsed) &&
    spendUsed >= 0 &&
    spendLimit != null &&
    Number.isFinite(spendLimit) &&
    spendLimit > 0
  ) {
    windows.push({
      name: "on_demand",
      label: "on-demand",
      usedPercent: (spendUsed / spendLimit) * 100,
      resetsAt,
      availableIn: availableInFromIso(resetsAt),
      windowSeconds: startIso && resetsAt
        ? Math.max(0, Math.floor((Date.parse(resetsAt) - Date.parse(startIso)) / 1000))
        : null,
      detail: `${cents(spendUsed)} / ${cents(spendLimit)} ${spend?.limitType || "spend"} cap`,
      affectsAvailability: false,
    });
  }
  return windows;
}

function validPercent(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
