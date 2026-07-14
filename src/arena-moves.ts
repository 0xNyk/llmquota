/**
 * Signature arena moves — hop / open / statusline / pace forecast.
 * Inspired by silo (named slots + checklists), portage (launch hints),
 * and the broader quota-TUI scene (statuslines, burn forecasts) — unique to llmquota.
 */

import type { Meter, ProviderSnapshot, RosterReport } from "./types.js";
import { availability, formatCompactDur, paceFraction, soonestResetSec } from "./tui-model.js";
import { usageProfileUrl } from "./usage-profile.js";
import { meterAffectsAvailability } from "./util.js";

/** Next ready fighter with the most headroom (or soonest reset if none ready). */
export function hopTarget(
  providers: ProviderSnapshot[],
  fromIndex: number,
): { index: number; reason: string } | null {
  if (!providers.length) return null;

  const scored = providers
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p.installed && p.auth === "ok");

  const ready = scored
    .filter(({ p }) => availability(p) === "ready")
    .sort((a, b) => {
      const sa = a.p.score;
      const sb = b.p.score;
      if (sa != null && sb != null && sa !== sb) return sa - sb;
      if (sa != null && sb == null) return -1;
      if (sa == null && sb != null) return 1;
      return Number(b.p.active) - Number(a.p.active);
    });

  if (ready.length) {
    // Prefer a different ready fighter than current when possible
    const alt = ready.find((x) => x.index !== fromIndex) || ready[0]!;
    const free =
      alt.p.score != null
        ? `${Math.max(0, Math.round(100 - alt.p.score))}% free`
        : "ready";
    return { index: alt.index, reason: `hop → ${alt.p.displayName} (${free})` };
  }

  // Nobody ready — hop to soonest reset
  const waiting = scored
    .map((x) => ({ ...x, sec: soonestResetSec(x.p) }))
    .filter((x) => x.sec != null)
    .sort((a, b) => (a.sec ?? 1e12) - (b.sec ?? 1e12));

  if (!waiting.length) return null;
  const next = waiting.find((x) => x.index !== fromIndex) || waiting[0]!;
  return {
    index: next.index,
    reason: `hop → ${next.p.displayName} (back in ${formatCompactDur(next.sec!)})`,
  };
}

/** Launch / compose hints — portage-style "open" (hints only, never spawn). */
export function openHints(p: ProviderSnapshot): string[] {
  const lines: string[] = [];
  const name = p.displayName;
  const bin = p.binary || p.id;

  lines.push(`open ${name}`);

  if (p.id === "claude") {
    if (p.profileId !== "default") {
      lines.push(`  silo go ${p.profileId}     # activate this Claude home`);
      lines.push(`  silo run ${p.profileId}    # one-shot in that silo`);
    } else {
      lines.push(`  claude                   # default ~/.claude`);
      lines.push(`  silo list                # other Claude homes`);
    }
  } else if (p.id === "codex") {
    lines.push(`  codex`);
  } else if (p.id === "cursor") {
    lines.push(`  cursor-agent              # or Cursor IDE`);
  } else if (p.id === "grok") {
    lines.push(`  grok`);
  } else if (p.id === "hermes") {
    lines.push(`  hermes`);
    if (p.auth !== "ok") lines.push(`  hermes portal            # re-auth Nous`);
  } else if (bin) {
    lines.push(`  ${bin}`);
  }

  if (p.auth !== "ok") {
    lines.push(`  auth: ${p.hint || p.error || "sign in required"}`);
  } else if (availability(p) === "ready") {
    const free =
      p.score != null ? `${Math.max(0, Math.round(100 - p.score))}% free` : "headroom ok";
    lines.push(`  status: ready · ${free}`);
  } else {
    const sec = soonestResetSec(p);
    lines.push(
      `  status: ${availability(p)}${sec != null ? ` · back in ${formatCompactDur(sec)}` : ""}`,
    );
  }

  lines.push(`  (hints only — llmquota never launches CLIs)`);
  const usage = usageProfileUrl(p);
  if (usage) lines.push(`  usage: ${usage}  (llmquota usage ${p.id} --open)`);
  lines.push(`  bus: llmquota bus · send -t all "…"`);
  return lines;
}

/** One-line status for tmux / prompts / waybar. */
export function formatStatusline(report: RosterReport): string {
  const ready = report.providers.filter((p) => availability(p) === "ready");
  const pick = report.providers.find((p) => p.id === report.pick.id && p.auth === "ok");
  const parts: string[] = [];

  if (pick && availability(pick) === "ready") {
    const free =
      pick.score != null ? `${Math.max(0, Math.round(100 - pick.score))}%` : "ok";
    parts.push(`${pick.displayName} ${free}`);
  } else if (ready[0]) {
    const p = ready[0];
    const free = p.score != null ? `${Math.max(0, Math.round(100 - p.score))}%` : "ok";
    parts.push(`${p.displayName} ${free}`);
  } else {
    const soon = report.providers
      .map((p) => ({ p, sec: soonestResetSec(p) }))
      .filter((x) => x.sec != null && x.p.auth === "ok")
      .sort((a, b) => (a.sec ?? 0) - (b.sec ?? 0))[0];
    if (soon) parts.push(`wait ${soon.p.displayName} ${formatCompactDur(soon.sec!)}`);
    else parts.push("no fighters");
  }

  parts.push(`${ready.length}▮`);
  return parts.join(" · ");
}

/**
 * If usage pace would hit 100% before the window resets, return seconds-to-full.
 * Unique "burn warning" — inspired by pace-aware sparklines in the quota TUI scene.
 */
export function paceToFullSec(m: Meter): number | null {
  if (m.usedPercent == null || m.usedPercent <= 0 || m.usedPercent >= 95) return null;
  const pace = paceFraction(m);
  if (pace == null || pace <= 0.05) return null;
  if (m.windowSeconds == null || m.windowSeconds <= 0) return null;

  const elapsed = pace * m.windowSeconds;
  if (elapsed < 60) return null; // too early to trust
  const burnPerSec = m.usedPercent / elapsed;
  if (burnPerSec <= 0) return null;
  const remainPct = 100 - m.usedPercent;
  const secToFull = remainPct / burnPerSec;
  const remWindow = m.windowSeconds * (1 - pace);
  if (secToFull >= remWindow * 0.98) return null; // on pace to finish under limit
  return Math.max(0, secToFull);
}

/** Hottest limiting window's pace warning, if any. */
export function hottestPaceWarning(p: ProviderSnapshot): string | null {
  let best: { sec: number; label: string } | null = null;
  for (const m of p.windows) {
    if (!meterAffectsAvailability(m)) continue;
    const sec = paceToFullSec(m);
    if (sec == null) continue;
    if (!best || sec < best.sec) {
      best = { sec, label: m.label || m.name };
    }
  }
  if (!best) return null;
  return `on pace to fill ${best.label} in ${formatCompactDur(best.sec)}`;
}
