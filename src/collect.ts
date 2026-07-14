import type { Meter, ProviderSnapshot, RosterReport } from "./types.js";
import { collectClaude } from "./providers/claude.js";
import { collectCodex } from "./providers/codex.js";
import { collectCursor } from "./providers/cursor.js";
import { pathCollisionNotes } from "./providers/detect.js";
import { collectGrok } from "./providers/grok.js";
import { attachReferrals } from "./referrals.js";

export async function collectAll(opts: { refresh?: boolean } = {}): Promise<RosterReport> {
  const providers = attachReferrals(
    await Promise.all([
      collectClaude({ refresh: opts.refresh }),
      collectCodex(),
      collectCursor(),
      collectGrok(),
    ]),
  );

  return {
    checkedAt: new Date().toISOString(),
    providers,
    pick: pickFighter(providers),
    pathNotes: pathCollisionNotes(),
  };
}

export function pickFighter(providers: ProviderSnapshot[]): RosterReport["pick"] {
  const ready = providers.filter(
    (p) => p.installed && p.auth === "ok" && (p.score == null || p.score < 95),
  );

  if (!ready.length) {
    const waiting = providers
      .filter((p) => p.installed)
      .map((p) => {
        const soonest = p.windows
          .map((w) => w.availableIn)
          .filter(Boolean)
          .sort((a, b) => (a!.length > b!.length ? 1 : -1))[0];
        return soonest ? `${p.displayName} in ${soonest}` : p.displayName;
      });
    return {
      id: null,
      line: waiting.length
        ? `all tired — wait on ${waiting.join(" · ")}`
        : "no fighters in the ring — install a CLI first",
    };
  }

  ready.sort((a, b) => {
    const sa = a.score ?? 50;
    const sb = b.score ?? 50;
    return sa - sb;
  });
  const best = ready[0]!;
  const used = best.score != null ? `${Math.round(best.score)}% used` : "headroom unknown";
  const win = best.windows[0];
  const sub = best.subscription || best.plan;
  const detail = win?.label
    ? `${sub ? `${sub} · ` : ""}${win.label} ${used}`
    : `${sub ? `${sub} · ` : ""}${used}`;
  return {
    id: best.id,
    line: `→ fight with ${best.displayName} (${detail})`,
  };
}

export function primaryMeter(p: ProviderSnapshot): Meter | null {
  if (!p.windows.length) return null;
  return [...p.windows].sort(
    (a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1),
  )[0]!;
}
