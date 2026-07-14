export type AuthState = "ok" | "missing" | "expired" | "error";

export type ProviderId = "claude" | "codex" | "cursor" | "grok";

export interface Meter {
  name: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  availableIn: string | null;
  windowSeconds: number | null;
  detail?: string | null;
}

export interface ProviderSnapshot {
  id: ProviderId;
  displayName: string;
  installed: boolean;
  binary: string | null;
  version: string | null;
  auth: AuthState;
  plan: string | null;
  account: string | null;
  windows: Meter[];
  source: string;
  error: string | null;
  hint: string | null;
  /** Lower = more headroom / prefer this fighter */
  score: number | null;
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
}
