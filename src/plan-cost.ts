/**
 * Resolve the plan name + list monthly cost for a fighter card.
 *
 * Prefer amounts already present on the subscription line (Hermes Nous).
 * Otherwise map well-known public list prices by provider + plan label.
 * Unknown / free-trial / team seats stay null — never invent a price.
 */

import type { ProviderSnapshot } from "./types.js";

export interface PlanCostInfo {
  /** Short plan name for the card (no vendor prefix). */
  name: string;
  /** e.g. "$200/mo" or "$0" — null when unknown. */
  cost: string | null;
}

/** Public list prices (USD/mo) for consumer tiers we can name confidently. */
const LIST: Record<string, Record<string, string>> = {
  claude: {
    free: "$0",
    pro: "$20/mo",
    "max 5x": "$100/mo",
    "max 20x": "$200/mo",
  },
  codex: {
    free: "$0",
    plus: "$20/mo",
    go: "$20/mo",
    // ChatGPT Pro: $100 = 5× Plus limits, $200 = 20× (2026 tiers).
    // Bare "pro" defaults to the $200 tier (common API label for full Pro).
    pro: "$200/mo",
    "pro 5x": "$100/mo",
    "pro 20x": "$200/mo",
  },
  cursor: {
    free: "$0",
    hobby: "$0",
    pro: "$20/mo",
    "pro+": "$60/mo",
    "pro plus": "$60/mo",
    business: "$40/mo",
    ultra: "$200/mo",
  },
  grok: {
    free: "$0",
    supergrok: "$30/mo",
    "super grok": "$30/mo",
    "supergrok heavy": "$300/mo",
    "super grok heavy": "$300/mo",
  },
  hermes: {
    // Nous Portal Agent tiers (list). Live monthly_charge wins when present.
    // openai-codex route inherits ChatGPT Pro 5x/20x list prices.
    free: "$0",
    plus: "$20/mo",
    pro: "$200/mo",
    "pro 5x": "$100/mo",
    "pro 20x": "$200/mo",
    ultra: "$200/mo",
  },
};

/** `$20/mo`, `$20.00/mo`, `€200/mo` already on the subscription string. */
const COST_IN_TEXT = /(?:[$€£]\s?\d+(?:[.,]\d{1,2})?\s*\/\s*mo(?:nth)?)/i;

export function extractCostFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(COST_IN_TEXT);
  if (!m) return null;
  return m[0].replace(/\s+/g, "").replace(/\/month/i, "/mo").replace(/\$(\d+)\.00\/mo/i, "$$$1/mo");
}

/** Strip vendor prefixes and status suffixes for display + catalog lookup. */
export function shortPlanName(p: ProviderSnapshot): string {
  // Declared display name (e.g. ChatGPT "Pro 20x" when API only says Pro).
  const override = p.planBilling?.planName?.trim();
  if (override) return override;

  const raw = (p.subscription || p.plan || "").trim();
  if (!raw) return "—";
  let s = raw
    .replace(/^Claude\s+/i, "")
    .replace(/^Codex\s+/i, "")
    .replace(/^ChatGPT\s+/i, "")
    .replace(/^Cursor\s+/i, "")
    .replace(/^Grok\s+·\s+/i, "")
    .replace(/^Grok\s+/i, "")
    .replace(/^Nous\s+/i, "Nous ")
    .replace(/^OpenAI\s+Codex\s+/i, "")
    .replace(/^OpenAI\s+/i, "")
    .replace(/\s+·\s+active$/i, "")
    .replace(/\s+·\s+(past_due|canceled|cancelled|trialing|incomplete).*$/i, "")
    .trim();

  // Drop trailing API tier noise for Grok list price match; keep full name for display if no cost.
  return s || "—";
}

function catalogKey(providerId: string, planText: string): string | null {
  const id = providerId.toLowerCase();
  const table = LIST[id];
  if (!table) return null;

  let n = planText
    .toLowerCase()
    .replace(/·/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Grok: "SuperGrok Heavy · xAI API tier 5" → prefer Heavy over bare SuperGrok
  if (id === "grok") {
    if (/heavy/.test(n)) return table["supergrok heavy"] ? "supergrok heavy" : null;
    if (/supergrok|super grok/.test(n)) return "supergrok";
  }

  // Claude Max without multiplier is ambiguous (5x vs 20x) — no catalog price.
  if (id === "claude" && /^max$/.test(n)) return null;

  // Codex dual line: "Pro · ChatGPT Plus" — take primary plan token.
  if (id === "codex") {
    const primary = n.split("·")[0]?.trim() || n;
    n = primary.replace(/^chatgpt\s+/i, "").trim();
  }

  // Cursor: "Ultra", "Pro+", "Business"
  n = n.replace(/\s+·\s+.*$/, "").trim();

  // Hermes Nous tiers are API-priced; ChatGPT/Codex plan names still catalog.
  if (id === "hermes") {
    n = n.replace(/^nous\s+/i, "").replace(/\s*·\s*.*$/, "").trim();
    if (table[n]) return n;
    const keys = Object.keys(table).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (n === k || n.startsWith(`${k} `) || new RegExp(`(?:^|\\s)${k.replace("+", "\\+")}(?:\\s|$)`).test(n)) {
        return k;
      }
    }
    return null;
  }

  // Direct key
  if (table[n]) return n;

  // Token match against known keys (longest first)
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (n === k || n.startsWith(`${k} `) || n.includes(` ${k}`)) return k;
  }
  return null;
}

export function listPriceFor(providerId: string, planText: string): string | null {
  const key = catalogKey(providerId, planText);
  if (!key) return null;
  return LIST[providerId.toLowerCase()]?.[key] ?? null;
}

/**
 * Plan name + monthly cost for card chrome.
 * Cost preference: declared billing facts → subscription text → catalog list price.
 */
export function planCostInfo(p: ProviderSnapshot): PlanCostInfo {
  const name = shortPlanName(p);
  if (name === "—") return { name, cost: p.planBilling?.cost ?? null };

  // Declared effective cost (e.g. discounted SuperGrok Heavy) beats list catalog.
  if (p.planBilling?.cost) {
    return { name, cost: p.planBilling.cost };
  }

  const fromText =
    extractCostFromText(p.subscription) ||
    extractCostFromText(p.plan) ||
    extractCostFromText(name);

  if (fromText) {
    // Strip the cost fragment from the display name when it's already embedded.
    const cleanName = name
      .replace(/\s*·\s*[$€£]\s?\d+(?:[.,]\d{1,2})?\s*\/\s*mo(?:nth)?/i, "")
      .replace(/\s*[$€£]\s?\d+(?:[.,]\d{1,2})?\s*\/\s*mo(?:nth)?/i, "")
      .trim() || name;
    return { name: cleanName, cost: fromText };
  }

  const cost = listPriceFor(p.id, name);
  return { name, cost };
}

/** Single-line label: `Max 20x · $200/mo` or just the plan name. */
export function planCostLabel(p: ProviderSnapshot): string {
  const { name, cost } = planCostInfo(p);
  if (name === "—" && !cost) return "—";
  return cost ? `${name} · ${cost}` : name;
}
