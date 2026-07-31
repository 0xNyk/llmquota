/**
 * Declared billing facts for a fighter when the vendor UI knows more than
 * local APIs: effective monthly cost, renewal date, active discount.
 *
 * Stored in ~/.config/llmquota/config.json → planBilling
 * Set with: llmquota plan facts <id> --cost '$99/mo' --renews 2026-08-12 --discount '…'
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatResetAt } from "./tui-model.js";
import type { PlanBillingFacts, ProviderSnapshot } from "./types.js";
import { normalizeIsoTimestamp } from "./util.js";

export interface PlanBillingConfigEntry {
  /** Display plan name override (e.g. "Pro 20x"). */
  plan?: string | null;
  planName?: string | null;
  name?: string | null;
  cost?: string | null;
  price?: string | null;
  listCost?: string | null;
  list?: string | null;
  renews?: string | null;
  renewsOn?: string | null;
  renewal?: string | null;
  discount?: string | null;
  note?: string | null;
}

export type PlanBillingConfig = Record<string, PlanBillingConfigEntry>;

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

export function loadPlanBillingConfig(): PlanBillingConfig {
  const raw = readRawConfig().planBilling;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PlanBillingConfig = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    out[k.toLowerCase()] = v as PlanBillingConfigEntry;
  }
  return out;
}

export function savePlanBillingConfig(planBilling: PlanBillingConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const raw = readRawConfig();
  if (Object.keys(planBilling).length === 0) {
    delete raw.planBilling;
  } else {
    raw.planBilling = planBilling;
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function setPlanBilling(
  key: string,
  entry: PlanBillingConfigEntry | null,
): { path: string; planBilling: PlanBillingConfig } {
  const planBilling = loadPlanBillingConfig();
  const k = key.toLowerCase().trim();
  if (!entry) {
    delete planBilling[k];
  } else {
    // Drop empty fields
    const clean: PlanBillingConfigEntry = {};
    for (const [fk, fv] of Object.entries(entry)) {
      if (fv != null && String(fv).trim() !== "") {
        (clean as Record<string, string>)[fk] = String(fv).trim();
      }
    }
    if (Object.keys(clean).length === 0) delete planBilling[k];
    else planBilling[k] = clean;
  }
  const path = savePlanBillingConfig(planBilling);
  return { path, planBilling };
}

/** Normalize "$99", "99", "99/mo", "$99/mo" → "$99/mo" (or "$0"). */
export function normalizeCostInput(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/^free$/i.test(s) || s === "0") return "$0";
  // already $99/mo or €20/mo
  if (/^[$€£]\s?\d+(?:[.,]\d{1,2})?\s*\/\s*mo(?:nth)?$/i.test(s)) {
    return s.replace(/\s+/g, "").replace(/\/month/i, "/mo").replace(/\.00\/mo$/i, "/mo");
  }
  // $99 or 99.00
  const m = s.match(/^[$€£]?\s?(\d+(?:[.,]\d{1,2})?)\s*(?:\/\s*mo(?:nth)?)?$/i);
  if (m) {
    const n = m[1]!.replace(",", ".");
    const num = Number(n);
    if (!Number.isFinite(num)) return null;
    const pretty = Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, "");
    return `$${pretty}/mo`;
  }
  return s;
}

function toIsoDate(raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  return normalizeIsoTimestamp(s);
}

function shortWhen(iso: string | null): string | null {
  if (!iso) return null;
  const stamp = formatResetAt(iso);
  if (!stamp) return null;
  return stamp.replace(/\s+\d{1,2}:\d{2}.*$/, "").trim() || stamp;
}

function configKeys(p: ProviderSnapshot): string[] {
  return [
    `${p.id}/${p.profileId}`,
    p.profileId !== "default" ? `${p.id}/${p.profileLabel}` : null,
    p.profileId !== "default" ? p.profileId : null,
    p.profileId !== "default" ? p.profileLabel : null,
    p.id,
  ]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase())
    .filter((k, i, keys) => keys.indexOf(k) === i);
}

export function entryToFacts(entry: PlanBillingConfigEntry): PlanBillingFacts | null {
  const planName =
    (entry.planName ?? entry.plan ?? entry.name ?? null)?.trim() || null;
  const cost = normalizeCostInput(entry.cost ?? entry.price ?? null);
  const listCost = normalizeCostInput(entry.listCost ?? entry.list ?? null);
  const renewsOn = toIsoDate(entry.renewsOn ?? entry.renews ?? entry.renewal ?? null);
  const discount = (entry.discount ?? entry.note ?? null)?.trim() || null;
  if (!planName && !cost && !listCost && !renewsOn && !discount) return null;
  return {
    planName,
    cost,
    listCost,
    renewsOn,
    discount,
    source: "config",
  };
}

export function resolvePlanBilling(
  p: ProviderSnapshot,
  cfg: PlanBillingConfig = loadPlanBillingConfig(),
): PlanBillingFacts | null {
  for (const key of configKeys(p)) {
    const entry = cfg[key];
    if (!entry) continue;
    return entryToFacts(entry);
  }
  return null;
}

export function attachPlanBilling(
  providers: ProviderSnapshot[],
  cfg: PlanBillingConfig = loadPlanBillingConfig(),
): ProviderSnapshot[] {
  return providers.map((p) => {
    const facts = resolvePlanBilling(p, cfg);
    if (!facts) return p.planBilling ? { ...p, planBilling: null } : p;
    return { ...p, planBilling: facts };
  });
}

/** Status-line cost prefers declared effective cost over list catalog. */
export function effectivePlanCost(p: ProviderSnapshot, catalogCost: string | null): string | null {
  return p.planBilling?.cost || catalogCost;
}

/** Secondary line: `renews Aug 12 · 67% off until Oct 13`. */
export function planBillingLabel(facts: PlanBillingFacts): string | null {
  const parts: string[] = [];
  if (facts.renewsOn) {
    const when = shortWhen(facts.renewsOn);
    if (when) parts.push(`renews ${when}`);
  }
  if (facts.discount) {
    // Tighten common phrasing
    let d = facts.discount.replace(/\s+/g, " ").trim();
    d = d.replace(/^discount\s+/i, "");
    parts.push(d);
  } else if (facts.listCost && facts.cost && facts.listCost !== facts.cost) {
    parts.push(`list ${facts.listCost}`);
  }
  if (!parts.length) return null;
  return parts.join(" · ");
}
