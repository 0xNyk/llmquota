export type AuthState = "ok" | "missing" | "expired" | "error";
export type RequestAvailability = "available" | "blocked" | "unknown";

/** Metered fighters + any catalog-detected CLI id (ollama, gemini, …). */
export type ProviderId = string;

export const METERED_PROVIDER_IDS = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "hermes",
] as const;

export type MeteredProviderId = (typeof METERED_PROVIDER_IDS)[number];

export interface Meter {
  name: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  availableIn: string | null;
  windowSeconds: number | null;
  detail?: string | null;
  /** False for billing/fact meters that do not prove requests are blocked. */
  affectsAvailability?: boolean;
}

export interface ReferralInfo {
  code: string | null;
  link: string | null;
  /** Preferred copy-paste payload (usually the link) */
  label: string;
  source: string;
  detail: string | null;
}

/** Scheduled plan change that has not taken effect yet (period end / next cycle). */
export interface ScheduledPlanChange {
  /** Destination plan after the change; null means cancel → free / ended. */
  nextPlan: string | null;
  /** List monthly cost of next plan when known (e.g. "$20/mo"). */
  nextCost: string | null;
  /** ISO timestamp when the change takes effect, if known. */
  effectiveAt: string | null;
  kind: "cancel" | "downgrade" | "upgrade" | "change";
  /** e.g. cursor_local, config, config+detected */
  source: string;
}

/**
 * Declared billing facts when local APIs lack renewal / effective price / discount.
 * Set via `llmquota plan facts` (e.g. Grok SuperGrok Heavy with 67% off).
 */
export interface PlanBillingFacts {
  /**
   * Display plan name when the vendor API is coarser than the billing page
   * (e.g. API says "Pro", ChatGPT billing says "Pro 20x").
   */
  planName: string | null;
  /** Effective monthly cost (e.g. "$99/mo" after discount). */
  cost: string | null;
  /** Public list price when different from effective (e.g. "$300/mo"). */
  listCost: string | null;
  /** Next renewal / charge date (ISO). */
  renewsOn: string | null;
  /** Short discount note (e.g. "67% off until Oct 13"). */
  discount: string | null;
  source: string;
}

export interface ProviderSnapshot {
  id: ProviderId;
  displayName: string;
  installed: boolean;
  binary: string | null;
  version: string | null;
  auth: AuthState;
  /** Short plan label for titles (e.g. Max 20x, Pro, Ultra) */
  plan: string | null;
  /** Full subscription line for display */
  subscription: string | null;
  /**
   * Pending plan change (downgrade / upgrade / cancel) effective later.
   * Detected from the vendor when possible; otherwise user-declared in config.
   */
  planChange: ScheduledPlanChange | null;
  /** Effective cost / renewal / discount when declared or known. */
  planBilling: PlanBillingFacts | null;
  account: string | null;
  /** Runtime/configured inference provider, independent from quota-account source. */
  activeProvider: string | null;
  /** Active model when persisted or exposed by the host CLI; unknown stays null. */
  activeModel: string | null;
  windows: Meter[];
  source: string;
  error: string | null;
  hint: string | null;
  /** Explicit request-path state; independent from utilization percentage. */
  requestAvailability: RequestAvailability;
  /** Lower = more headroom / prefer this fighter */
  score: number | null;
  referral: ReferralInfo | null;
  /**
   * Profile / account slot within the provider.
   * Claude: `default` or silo name; Grok: auth.json entry id; others: `default`.
   */
  profileId: string;
  /** Short label for UI (e.g. personal, work) */
  profileLabel: string;
  /** Absolute config dir when isolated (silo CLAUDE_CONFIG_DIR) */
  configDir: string | null;
  /** Active silo default / matching env */
  active: boolean;
}

export interface RosterReport {
  checkedAt: string;
  providers: ProviderSnapshot[];
  pick: {
    id: ProviderId | null;
    line: string;
  };
  pathNotes: string[];
}

export interface CliOptions {
  json: boolean;
  plain: boolean;
  emoji: boolean;
  who: boolean;
  doctor: boolean;
  refresh: boolean;
  tui?: boolean;
  once?: boolean;
  refs?: boolean;
  copy?: string | null;
  /** Disable SGR mouse tracking in the arena TUI */
  noMouse?: boolean;
  /** Hide personal identifiers in TUI screenshots. */
  anon?: boolean;
  /** `llmquota scan` — list detected CLIs */
  scan?: boolean;
}
