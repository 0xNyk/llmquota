import type { AuthState, ProviderId, ProviderSnapshot } from "./types.js";

export interface BaseSnapshotInput {
  id: ProviderId;
  displayName: string;
  installed: boolean;
  binary?: string | null;
  version?: string | null;
  profileId?: string;
  profileLabel?: string;
  configDir?: string | null;
  active?: boolean;
  account?: string | null;
  activeProvider?: string | null;
  activeModel?: string | null;
  source?: string;
  auth?: AuthState;
  hint?: string | null;
}

/** Shared empty/auth-pending snapshot — providers fill meters after. */
export function baseSnapshot(input: BaseSnapshotInput): ProviderSnapshot {
  return {
    id: input.id,
    displayName: input.displayName,
    installed: input.installed,
    binary: input.binary ?? null,
    version: input.version ?? null,
    auth: input.auth ?? "missing",
    plan: null,
    subscription: null,
    account: input.account ?? null,
    activeProvider: input.activeProvider ?? null,
    activeModel: input.activeModel ?? null,
    windows: [],
    source: input.source ?? "none",
    error: null,
    hint: input.hint ?? null,
    referral: null,
    score: null,
    profileId: input.profileId ?? "default",
    profileLabel: input.profileLabel ?? "default",
    configDir: input.configDir ?? null,
    active: input.active ?? true,
  };
}

/** True when ISO / epoch-ms expiry is at or before now (+ skew). */
export function isExpiredAt(
  expiresAt: string | number | null | undefined,
  skewMs = 120_000,
): boolean {
  if (expiresAt == null || expiresAt === "") return false;
  const t = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t <= Date.now() + skewMs;
}
