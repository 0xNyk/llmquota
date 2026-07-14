export type AuthState = "ok" | "missing" | "expired" | "error";

export type ProviderId = "claude" | "codex" | "cursor" | "grok" | "hermes";

export interface Meter {
  name: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  availableIn: string | null;
  windowSeconds: number | null;
  detail?: string | null;
}

export interface ReferralInfo {
  code: string | null;
  link: string | null;
  /** Preferred copy-paste payload (usually the link) */
  label: string;
  source: string;
  detail: string | null;
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
  account: string | null;
  windows: Meter[];
  source: string;
  error: string | null;
  hint: string | null;
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
}
