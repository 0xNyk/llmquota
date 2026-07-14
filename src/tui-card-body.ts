/**
 * Modular fighter-card body — priority slots + density packing.
 *
 * Single clock rule: the countdown lives in the title (waiting) or
 * the `when` footer (ready resets / back-in). Meter rows never repeat it.
 *
 * Density:
 *   tight  ≤5  status + hottest meters + when
 *   normal ≤8  + who
 *   roomy  ≥9  + ref / spend / hint as room allows
 */

import type { Meter, ProviderSnapshot } from "./types.js";
import { hottestPaceWarning } from "./arena-moves.js";
import {
  BOLD,
  CYAN,
  DIM,
  FG_SOFT,
  GREEN,
  osc8,
  RED,
  RESET,
  vlen,
  WHITE,
  YELLOW,
} from "./tui-ansi.js";
import {
  availability,
  CARD_MIN_BODY,
  countdownLine,
  distinctResetFacts,
  formatCountdown,
  isCooldown,
  levelColor,
  meterWaveIntensity,
  soonestReset,
  statusInfo,
  type Avail,
  usageLevel,
  usageWave,
  windowName,
} from "./tui-model.js";
import { meterAffectsAvailability } from "./util.js";

export type CardDensity = "tight" | "normal" | "roomy";

export interface CardSlot {
  kind: "status" | "who" | "selection" | "ref" | "meter" | "fact" | "when" | "hint" | "error";
  /** Lower = pack first. Sticky `when` is always last. */
  priority: number;
  line: string;
  /** Prefer keeping this slot when cutting for height. */
  sticky?: boolean;
}

export function cardDensity(bodyH: number): CardDensity {
  if (bodyH <= 5) return "tight";
  if (bodyH <= 8) return "normal";
  return "roomy";
}

export const CARD_MAX_BODY = 10;

/** Natural card height before the row allocator fits cards to the terminal. */
export function preferredCardBodyH(
  p: ProviderSnapshot,
  contentW: number,
  focused: boolean,
  tick: number,
  checkedAt?: string | null,
): number {
  const slots = buildCardSlots(p, contentW, CARD_MAX_BODY, focused, tick, checkedAt);
  return Math.max(CARD_MIN_BODY, Math.min(CARD_MAX_BODY, slots.length));
}

export function isSpendDetail(detail: string): boolean {
  return /\$|€|£|left|usable|against|credit/i.test(detail);
}

export function shortenHint(hint: string): string | null {
  let h = hint.replace(/\s+/g, " ").trim();
  if (!h) return null;
  if (/SuperGrok weekly|weekly pool|Settings → Usage/i.test(h)) {
    return "weekly % → grok.com Settings → Usage";
  }
  if (/run out of credits/i.test(h)) {
    return "credits empty · grok.com/?_s=usage";
  }
  if (/You've hit your usage limit/i.test(h)) {
    return "usage limit hit";
  }
  if (/Subscription grant exhausted/i.test(h)) {
    return "sub grant empty · on top-up credits";
  }
  if (h.length > 56) h = `${h.slice(0, 53)}…`;
  return h;
}

export function planLabel(p: ProviderSnapshot): string {
  return (p.subscription || p.plan || "—")
    .replace(/^Claude\s+/i, "")
    .replace(/^Codex\s+/i, "")
    .replace(/^Cursor\s+/i, "")
    .replace(/^Grok\s+·\s+/i, "")
    .replace(/^Nous\s+/i, "Nous ");
}

/** Title owns the clock when waiting; ready titles stay calm. */
export function cardTitle(
  p: ProviderSnapshot,
  avail: Avail,
  sec: number | null,
): string {
  if (isCooldown(p)) {
    return sec != null
      ? `${p.displayName} · COOLDOWN · ${formatCountdown(sec)}`
      : `${p.displayName} · COOLDOWN`;
  }
  if (avail === "ready") return p.displayName;
  if (sec != null) return `${p.displayName} · ${formatCountdown(sec)}`;
  return p.displayName;
}

/**
 * Status line — state + plan only.
 * No countdown here (title / when own the clock).
 */
export function statusSlot(
  p: ProviderSnapshot,
  avail: Avail,
  tick: number,
  contentW: number,
): CardSlot {
  const st = statusInfo(p, tick);
  let badge: string;
  if (isCooldown(p)) {
    badge = `${RED}${BOLD}× COOLDOWN${RESET}`;
  } else if (avail === "ready") {
    badge = `${GREEN}${BOLD}${st.short}${RESET} ${GREEN}ready${RESET}`;
  } else if (avail === "soon") {
    badge = `${YELLOW}${BOLD}◌${RESET} ${YELLOW}soon${RESET}`;
  } else if (avail === "limping") {
    badge = `${YELLOW}${BOLD}!${RESET} ${YELLOW}limping${RESET}`;
  } else if (avail === "tired") {
    badge = `${RED}${BOLD}✕${RESET} ${RED}limit${RESET}`;
  } else if (avail === "auth") {
    badge = `${st.color}${BOLD}${st.short}${RESET} ${st.color}${st.label}${RESET}`;
  } else {
    badge = `${DIM}${st.short} ${st.label}${RESET}`;
  }

  const plan = planLabel(p);
  const star = p.active ? ` ${CYAN}★${RESET}` : "";
  const room = Math.max(6, contentW - vlen(badge) - (p.active ? 2 : 0) - 2);
  const line = `${badge}  ${WHITE}${plan.slice(0, room)}${RESET}${star}`;
  return { kind: "status", priority: 10, line, sticky: true };
}

export function whoSlot(p: ProviderSnapshot, contentW: number): CardSlot | null {
  if (!p.account) return null;
  const profile = p.profileId !== "default" ? ` · ${p.profileLabel}` : "";
  return {
    kind: "who",
    priority: 40,
    line: `${DIM}${(p.account + profile).slice(0, contentW)}${RESET}`,
  };
}

export function selectionSlot(p: ProviderSnapshot, contentW: number): CardSlot | null {
  const model = p.activeModel || (p.activeProvider ? "model unknown" : null);
  const selection = [p.activeProvider, model].filter(Boolean).join(" · ");
  if (!selection) return null;
  return {
    kind: "selection",
    priority: 25,
    line: `${DIM}${selection.slice(0, contentW)}${RESET}`,
  };
}

export function refSlot(
  p: ProviderSnapshot,
  contentW: number,
  focused: boolean,
): CardSlot | null {
  const ref = p.referral;
  if (!ref?.label && !ref?.code && !ref?.link) return null;
  const code = ref.code?.trim();
  const rawLink = (ref.link || ref.label || "").trim();
  const link = rawLink.replace(/^https?:\/\//, "");
  const copy = focused ? `${CYAN}[c]${RESET}` : `${DIM}c${RESET}`;
  const href = rawLink || (code ? `https://claude.ai/referral/${code}` : "");

  let line: string;
  if (code) {
    const linked = href
      ? osc8(href, `${BOLD}${WHITE}${code}${RESET}`)
      : `${BOLD}${WHITE}${code}${RESET}`;
    line = `${CYAN}ref${RESET} ${linked} ${copy}`;
  } else if (link) {
    const shown = link.slice(0, Math.max(12, contentW - 10));
    const linked = href
      ? osc8(href, `${WHITE}${shown}${RESET}`)
      : `${WHITE}${shown}${RESET}`;
    line = `${CYAN}ref${RESET} ${linked} ${copy}`;
  } else {
    return null;
  }
  return { kind: "ref", priority: 45, line };
}

/** Meter row: label · wave · NN% — no per-row clocks. */
export function meterSlot(m: Meter, contentW: number, tick: number): CardSlot {
  const labelW = Math.min(8, Math.max(7, Math.floor(contentW * 0.14)));
  const rightW = 4; // "100%"
  const barW = Math.max(10, contentW - labelW - rightW - 2);
  const label = windowName(m).slice(0, labelW).padEnd(labelW);
  const seed = `${m.name || m.label}:${m.resetsAt || m.label}`;
  const heat = m.usedPercent ?? -1;

  if (m.usedPercent == null) {
    const detail = (m.detail || "—").slice(0, contentW - labelW - 2);
    return {
      kind: "meter",
      priority: 50 + Math.max(0, 100 - heat),
      line: `${FG_SOFT}${label}${RESET} ${DIM}${detail}${RESET}`,
    };
  }

  const used = Math.round(m.usedPercent);
  const right = `${used}%`.padStart(rightW);
  const line =
    `${FG_SOFT}${label}${RESET} ` +
    `${usageWave(seed, m.usedPercent, barW, tick, meterWaveIntensity(m))} ` +
    `${levelColor(usageLevel(m.usedPercent))}${BOLD}${right}${RESET}`;

  // Hotter meters pack first (lower priority number).
  return {
    kind: "meter",
    priority: meterAffectsAvailability(m) ? 20 + Math.max(0, 100 - used) : 140,
    line,
  };
}

export function spendSlot(windows: Meter[], contentW: number): CardSlot | null {
  const preferred = windows.find((m) => m.name === "nous_purchased");
  for (const m of preferred ? [preferred, ...windows.filter((w) => w !== preferred)] : windows) {
    const d = m.detail?.trim();
    if (!d || !isSpendDetail(d)) continue;
    return {
      kind: "fact",
      priority: 60,
      line: `${DIM}${d.slice(0, contentW)}${RESET}`,
    };
  }
  return null;
}

export function whenSlot(
  p: ProviderSnapshot,
  contentW: number,
  tick: number,
  checkedAt?: string | null,
  clockInTitle = false,
): CardSlot | null {
  const line = countdownLine(p, contentW, tick, checkedAt, { clockInTitle });
  if (!line) return null;
  return { kind: "when", priority: 90, line, sticky: true };
}

export function paceSlot(p: ProviderSnapshot, contentW: number): CardSlot | null {
  const w = hottestPaceWarning(p);
  if (!w) return null;
  return {
    kind: "hint",
    priority: 70,
    line: `${YELLOW}⚠ ${w.slice(0, Math.max(8, contentW - 2))}${RESET}`,
  };
}

export function hintSlot(p: ProviderSnapshot, contentW: number): CardSlot | null {
  if (!p.hint || p.auth !== "ok") return null;
  const h = shortenHint(p.hint);
  if (!h) return null;
  // Drop hints that just restate "limit" when status already says limit.
  if (/usage limit hit/i.test(h) && availability(p) === "tired") return null;
  return {
    kind: "hint",
    priority: 80,
    line: `${DIM}${h.slice(0, contentW)}${RESET}`,
  };
}

export function errorSlot(p: ProviderSnapshot, contentW: number): CardSlot | null {
  if (!p.installed) {
    return {
      kind: "error",
      priority: 15,
      line: `${DIM}${(p.hint || "not installed").slice(0, contentW)}${RESET}`,
      sticky: true,
    };
  }
  if (p.auth !== "ok") {
    return {
      kind: "error",
      priority: 15,
      line: `${DIM}${(p.hint || p.error || "sign in required").replace(/\s+/g, " ").slice(0, contentW)}${RESET}`,
      sticky: true,
    };
  }
  return null;
}

/**
 * Pack slots into `bodyH` lines.
 * Sticky slots (status, when, error) always win; meters fill the middle by heat.
 */
export function packCardSlots(
  slots: CardSlot[],
  bodyH: number,
): { lines: string[]; refBodyRow: number | null } {
  const sticky = slots.filter((s) => s.sticky);
  const flex = slots
    .filter((s) => !s.sticky)
    .sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind));

  const when = sticky.filter((s) => s.kind === "when");
  const head = sticky.filter((s) => s.kind !== "when");
  const reserved = head.length + when.length;
  const flexRoom = Math.max(0, bodyH - reserved);
  const chosenFlex = flex.slice(0, flexRoom);

  // Preserve reading order: identity → active route → quota → supporting facts → reset.
  const order = ["status", "error", "who", "selection", "ref", "meter", "fact", "hint", "when"] as const;
  const rank = (k: string) => {
    const i = order.indexOf(k as (typeof order)[number]);
    return i < 0 ? 99 : i;
  };
  const packed = [...head, ...chosenFlex, ...when].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.priority - b.priority,
  );

  // Trim if somehow over (shouldn't) — drop lowest-value flex first
  while (packed.length > bodyH) {
    const idx = packed.findIndex((s) => !s.sticky && s.kind === "hint");
    if (idx >= 0) {
      packed.splice(idx, 1);
      continue;
    }
    const fact = packed.findIndex((s) => !s.sticky && s.kind === "fact");
    if (fact >= 0) {
      packed.splice(fact, 1);
      continue;
    }
    const meter = [...packed].reverse().findIndex((s) => s.kind === "meter");
    if (meter >= 0) {
      packed.splice(packed.length - 1 - meter, 1);
      continue;
    }
    break;
  }

  const lines = packed.slice(0, bodyH).map((s) => s.line);
  const refBodyRow = (() => {
    const i = packed.findIndex((s) => s.kind === "ref");
    return i >= 0 && i < bodyH ? i : null;
  })();
  return { lines, refBodyRow };
}

/** Build the full slot list for a provider at this density. */
export function buildCardSlots(
  p: ProviderSnapshot,
  contentW: number,
  bodyH: number,
  focused: boolean,
  tick: number,
  checkedAt?: string | null,
): CardSlot[] {
  const density = cardDensity(bodyH);
  const avail = availability(p);
  const reset = soonestReset(p, checkedAt);
  const clockInTitle = avail !== "ready" && reset != null;
  const slots: CardSlot[] = [];

  slots.push(statusSlot(p, avail, tick, contentW));

  const selection = selectionSlot(p, contentW);
  if (selection) slots.push(selection);

  const err = errorSlot(p, contentW);
  if (err) {
    slots.push(err);
    const when = whenSlot(p, contentW, tick, checkedAt, clockInTitle);
    if (when) slots.push(when);
    return slots;
  }

  if (density !== "tight") {
    const who = whoSlot(p, contentW);
    if (who) slots.push(who);
  }

  if (density === "roomy" || (focused && density !== "tight")) {
    const ref = refSlot(p, contentW, focused);
    if (ref) slots.push(ref);
  }

  if (p.windows.length) {
    for (const m of p.windows) slots.push(meterSlot(m, contentW, tick));
  } else {
    slots.push({
      kind: "meter",
      priority: 50,
      line: `${DIM}no live meters${RESET}`,
    });
  }

  if (density !== "tight") {
    const spend = spendSlot(p.windows, contentW);
    if (spend) slots.push(spend);
  }

  // Distinct absolute resets (e.g. Claude 5h vs 7d) when body has room
  if (density !== "tight") {
    const facts = distinctResetFacts(p);
    if (facts.length > 1) {
      const text = facts.map((f) => `${f.label} ${f.at}`).join(" · ");
      slots.push({
        kind: "fact",
        priority: 65,
        line: `${DIM}${text.slice(0, contentW)}${RESET}`,
      });
    }
  }

  const when = whenSlot(p, contentW, tick, checkedAt, clockInTitle);
  if (when) slots.push(when);

  if (density !== "tight") {
    const pace = paceSlot(p, contentW);
    if (pace) slots.push(pace);
  }

  if (density === "roomy") {
    const hint = hintSlot(p, contentW);
    if (hint) slots.push(hint);
  }

  return slots;
}

/** Title + availability for the card chrome. */
export function titleClock(
  p: ProviderSnapshot,
  checkedAt?: string | null,
): { avail: Avail; sec: number | null; title: string } {
  const avail = availability(p);
  const reset = soonestReset(p, checkedAt);
  const sec = reset?.sec ?? null;
  return { avail, sec, title: cardTitle(p, avail, sec) };
}
