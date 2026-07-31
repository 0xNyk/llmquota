/**
 * Scheduled plan changes (downgrades / upgrades / cancels) that take effect
 * later — often at the next billing cycle.
 *
 * Sources:
 *  1. Provider-detected (e.g. Cursor `pendingCancellationDate` in local state)
 *  2. User-declared in ~/.config/llmquota/config.json → planChanges
 *
 * Most vendors keep the *current* tier active until period end and never
 * expose the next tier on local APIs — declare those with `llmquota plan set`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listPriceFor, planCostInfo } from "./plan-cost.js";
import { formatResetAt } from "./tui-model.js";
import type { ProviderSnapshot, ScheduledPlanChange } from "./types.js";
import { normalizeIsoTimestamp } from "./util.js";

export interface PlanChangeConfigEntry {
  /** Next plan name (omit or null = cancel / free). */
  to?: string | null;
  next?: string | null;
  nextPlan?: string | null;
  /** Effective date (ISO or YYYY-MM-DD). */
  on?: string | null;
  at?: string | null;
  effective?: string | null;
  effectiveAt?: string | null;
}

export type PlanChangesConfig = Record<string, PlanChangeConfigEntry>;

function configPath(): string {
  return (
    process.env.LLMQUOTA_CONFIG ||
    join(homedir(), ".config", "llmquota", "config.json")
  );
}

function readRawConfig(): Record<string, unknown> {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function loadPlanChangesConfig(): PlanChangesConfig {
  const raw = readRawConfig().planChanges;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PlanChangesConfig = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    out[k.toLowerCase()] = v as PlanChangeConfigEntry;
  }
  return out;
}

/** Merge planChanges into config.json without clobbering other keys. */
export function savePlanChangesConfig(planChanges: PlanChangesConfig): string {
  const path = configPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const raw = readRawConfig();
  if (Object.keys(planChanges).length === 0) {
    delete raw.planChanges;
  } else {
    raw.planChanges = planChanges;
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function setPlanChange(
  key: string,
  entry: PlanChangeConfigEntry | null,
): { path: string; planChanges: PlanChangesConfig } {
  const planChanges = loadPlanChangesConfig();
  const k = key.toLowerCase().trim();
  if (!entry) {
    delete planChanges[k];
  } else {
    planChanges[k] = entry;
  }
  const path = savePlanChangesConfig(planChanges);
  return { path, planChanges };
}

function pickNextPlan(entry: PlanChangeConfigEntry): string | null {
  const raw = entry.to ?? entry.next ?? entry.nextPlan;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /^(cancel|cancelled|canceled|free|none|end)$/i.test(s)) return null;
  return s;
}

function pickEffective(entry: PlanChangeConfigEntry): string | null {
  const raw = entry.on ?? entry.at ?? entry.effective ?? entry.effectiveAt;
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  // YYYY-MM-DD → start of that day UTC for stable display
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T00:00:00.000Z`;
  }
  return normalizeIsoTimestamp(s);
}

function monthlyDollars(cost: string | null): number | null {
  if (!cost) return null;
  if (cost === "$0") return 0;
  const m = cost.match(/[$€£]\s?([\d.]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function classifyPlanChange(
  providerId: string,
  currentPlan: string | null,
  nextPlan: string | null,
): ScheduledPlanChange["kind"] {
  if (nextPlan == null) return "cancel";
  const cur = listPriceFor(providerId, currentPlan || "") || planCostInfo({
    id: providerId,
    plan: currentPlan,
    subscription: currentPlan,
  } as ProviderSnapshot).cost;
  const next =
    listPriceFor(providerId, nextPlan) ||
    planCostInfo({
      id: providerId,
      plan: nextPlan,
      subscription: nextPlan,
    } as ProviderSnapshot).cost;
  const a = monthlyDollars(cur);
  const b = monthlyDollars(next);
  if (a != null && b != null) {
    if (b < a) return "downgrade";
    if (b > a) return "upgrade";
  }
  const cn = (currentPlan || "").toLowerCase();
  const nn = nextPlan.toLowerCase();
  if (cn && nn && cn !== nn) {
    // Heuristic name ladders when prices unknown
    const rank = (s: string): number | null => {
      if (/free|hobby/.test(s)) return 0;
      if (/plus|go\b/.test(s) && !/pro\+|pro plus|pro 5x|pro 20x/.test(s)) return 1;
      if (/pro\+|pro plus/.test(s)) return 3;
      // ChatGPT / Codex Pro limit multipliers (same $ tier, different headroom).
      if (/pro\s*5x|\b5x\b/.test(s) && !/20x|max/.test(s)) return 4;
      if (/pro\s*20x|\b20x\b/.test(s)) return 6;
      if (/max 5x|business/.test(s)) return 4;
      if (/max 20x/.test(s)) return 5;
      // Nous Ultra and SuperGrok Heavy sit at the top consumer tier.
      if (/\bultra\b|heavy/.test(s)) return 7;
      if (/max\b/.test(s)) return 4;
      if (/\bpro\b/.test(s)) return 2;
      return null;
    };
    const ra = rank(cn);
    const rb = rank(nn);
    if (ra != null && rb != null) {
      if (rb < ra) return "downgrade";
      if (rb > ra) return "upgrade";
    }
  }
  return "change";
}

export function buildScheduledChange(opts: {
  providerId: string;
  currentPlan: string | null;
  nextPlan: string | null;
  effectiveAt: string | null;
  source: string;
}): ScheduledPlanChange {
  const kind = classifyPlanChange(opts.providerId, opts.currentPlan, opts.nextPlan);
  const nextCost = opts.nextPlan
    ? listPriceFor(opts.providerId, opts.nextPlan)
    : "$0";
  return {
    nextPlan: opts.nextPlan,
    nextCost: opts.nextPlan ? nextCost : nextCost ?? "$0",
    effectiveAt: opts.effectiveAt,
    kind,
    source: opts.source,
  };
}

function configKeyFor(p: ProviderSnapshot): string[] {
  // Prefer exact profile keys, then provider id.
  const keys = [
    `${p.id}/${p.profileId}`,
    p.profileId !== "default" ? `${p.id}/${p.profileLabel}` : null,
    p.profileId !== "default" ? p.profileId : null,
    p.profileId !== "default" ? p.profileLabel : null,
    p.id,
  ]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase());
  return [...new Set(keys)];
}

/** Normalize plan labels for equality (not substring) checks. */
function planKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Hide stale declarations once live plan already matches next. */
export function isPlanChangeStale(
  p: ProviderSnapshot,
  change: ScheduledPlanChange,
): boolean {
  if (!change.nextPlan) {
    // cancel: stale when plan is free/null or effective far past and status ended
    if (!p.plan || /free|hobby/i.test(p.plan)) return true;
    return false;
  }
  // Prefer declared billing name (Pro 20x) over coarse API plan (Pro).
  const cur = planKey(currentPlanLabel(p) || "");
  const next = planKey(change.nextPlan);
  if (!cur || !next) return false;
  // Exact match only — never substring ("Pro" must not swallow "Pro 5x").
  if (cur === next) return true;
  // Allow "Claude Pro" vs "Pro" style prefix equality after vendor strip.
  const strip = (s: string) =>
    s
      .replace(/^(claude|codex|chatgpt|cursor|openai codex|openai|grok|nous)\s+/i, "")
      .trim();
  return strip(cur) === strip(next);
}

function currentPlanLabel(p: ProviderSnapshot): string | null {
  return p.planBilling?.planName?.trim() || p.plan || null;
}

export function resolveConfigChange(
  p: ProviderSnapshot,
  cfg: PlanChangesConfig = loadPlanChangesConfig(),
): ScheduledPlanChange | null {
  for (const key of configKeyFor(p)) {
    const entry = cfg[key];
    if (!entry) continue;
    const nextPlan = pickNextPlan(entry);
    // Explicit cancel entry: { "to": "cancel" } or empty to with on date
    const hasTo = "to" in entry || "next" in entry || "nextPlan" in entry;
    if (!hasTo && !pickEffective(entry)) continue;
    const change = buildScheduledChange({
      providerId: p.id,
      currentPlan: currentPlanLabel(p),
      nextPlan: hasTo ? nextPlan : null,
      effectiveAt: pickEffective(entry),
      source: "config",
    });
    if (isPlanChangeStale(p, change)) return null;
    return change;
  }
  return null;
}

/**
 * Merge detected + config changes onto a snapshot.
 * Config wins for nextPlan when both exist (user knows the destination tier);
 * earliest/most specific effective date is kept (prefer detected date if config lacks one).
 */
export function attachPlanChange(
  p: ProviderSnapshot,
  cfg: PlanChangesConfig = loadPlanChangesConfig(),
): ProviderSnapshot {
  const detected = p.planChange?.source && p.planChange.source !== "config"
    ? p.planChange
    : null;
  const declared = resolveConfigChange(p, cfg);

  if (!detected && !declared) {
    if (p.planChange && isPlanChangeStale(p, p.planChange)) {
      return { ...p, planChange: null };
    }
    return p;
  }

  if (detected && declared) {
    const current = currentPlanLabel(p);
    const merged = buildScheduledChange({
      providerId: p.id,
      currentPlan: current,
      // A declared null destination is an explicit cancel, not a missing value.
      nextPlan: declared.nextPlan,
      effectiveAt: declared.effectiveAt || detected.effectiveAt,
      source: declared.nextPlan !== detected.nextPlan
        ? "config+detected"
        : detected.source,
    });
    // Config wins for both named destinations and explicit cancellation.
    merged.kind = classifyPlanChange(p.id, current, declared.nextPlan);
    merged.source = detected.effectiveAt && !declared.effectiveAt
      ? `${detected.source}+config`
      : "config+detected";
    if (isPlanChangeStale(p, merged)) return { ...p, planChange: null };
    return { ...p, planChange: merged };
  }

  const only = declared || detected!;
  if (isPlanChangeStale(p, only)) return { ...p, planChange: null };
  return { ...p, planChange: only };
}

export function attachPlanChanges(
  providers: ProviderSnapshot[],
  cfg: PlanChangesConfig = loadPlanChangesConfig(),
): ProviderSnapshot[] {
  return providers.map((p) => attachPlanChange(p, cfg));
}

/** Short calendar stamp for card chrome (e.g. Aug 9). */
export function formatPlanChangeWhen(iso: string | null): string | null {
  if (!iso) return null;
  const stamp = formatResetAt(iso);
  if (!stamp) return null;
  // formatResetAt → "Aug 9 12:06" — drop clock for plan changes
  return stamp.replace(/\s+\d{1,2}:\d{2}.*$/, "").trim() || stamp;
}

/** Plain label: `↓ Pro · $20/mo · Aug 9` */
export function planChangeLabel(change: ScheduledPlanChange): string {
  const arrow =
    change.kind === "downgrade" ? "↓" :
    change.kind === "upgrade" ? "↑" :
    change.kind === "cancel" ? "✕" : "→";
  const when = formatPlanChangeWhen(change.effectiveAt);
  if (change.kind === "cancel" && !change.nextPlan) {
    const parts = [`${arrow} cancels`, when].filter(Boolean);
    return parts.join(" · ");
  }
  const name = change.nextPlan || "free";
  const cost = change.nextCost ? ` · ${change.nextCost}` : "";
  const parts = [`${arrow} ${name}${cost}`, when].filter(Boolean);
  return parts.join(" · ");
}
