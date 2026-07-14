import type { Meter, ProviderSnapshot, RosterReport } from "./types.js";
import { collectClaudeAll } from "./providers/claude.js";
import { collectCodex } from "./providers/codex.js";
import { collectCursor } from "./providers/cursor.js";
import { pathCollisionNotes } from "./providers/detect.js";
import { collectGrokAll } from "./providers/grok.js";
import { attachReferrals } from "./referrals.js";

export async function collectAll(opts: { refresh?: boolean } = {}): Promise<RosterReport> {
  const [claude, codex, cursor, grok] = await Promise.all([
    collectClaudeAll({ refresh: opts.refresh }),
    collectCodex(),
    collectCursor(),
    collectGrokAll(),
  ]);

  const providers = attachReferrals([...claude, codex, cursor, ...grok]);
  providers.sort(compareSnapshots);

  return {
    checkedAt: new Date().toISOString(),
    providers,
    pick: pickFighter(providers),
    pathNotes: pathCollisionNotes(),
  };
}

const PROVIDER_ORDER: Record<string, number> = {
  claude: 0,
  codex: 1,
  cursor: 2,
  grok: 3,
};

function compareSnapshots(a: ProviderSnapshot, b: ProviderSnapshot): number {
  const po = (PROVIDER_ORDER[a.id] ?? 9) - (PROVIDER_ORDER[b.id] ?? 9);
  if (po) return po;
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.profileId === "default" && b.profileId !== "default") return -1;
  if (b.profileId === "default" && a.profileId !== "default") return 1;
  const authRank = (p: ProviderSnapshot) =>
    p.auth === "ok" ? 0 : p.auth === "expired" ? 1 : p.auth === "error" ? 2 : 3;
  const ar = authRank(a) - authRank(b);
  if (ar) return ar;
  return a.profileLabel.localeCompare(b.profileLabel);
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
    // Prefer active profile on a tie
    if (sa === sb) return Number(b.active) - Number(a.active);
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
    line: `→ fight with ${best.displayName}${best.active ? " ★" : ""} (${detail})`,
  };
}

export function primaryMeter(p: ProviderSnapshot): Meter | null {
  if (!p.windows.length) return null;
  return [...p.windows].sort(
    (a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1),
  )[0]!;
}
