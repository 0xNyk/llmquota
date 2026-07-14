import type { Meter, ProviderSnapshot, RosterReport } from "./types.js";
import type { DetectedCli } from "./providers/catalog.js";
import { collectClaudeAll } from "./providers/claude.js";
import { collectCodex } from "./providers/codex.js";
import { collectCursor } from "./providers/cursor.js";
import { pathCollisionNotes } from "./providers/detect.js";
import { collectDiscoveredExtras } from "./providers/discovered.js";
import { collectGrokAll } from "./providers/grok.js";
import { collectHermesAll } from "./providers/hermes.js";
import { attachReferrals } from "./referrals.js";
import { meterAffectsAvailability } from "./util.js";

export type CollectProgressEvent =
  | { phase: "start"; ids: string[] }
  | { phase: "done"; id: string }
  | { phase: "error"; id: string; message: string };

export async function collectAll(
  opts: {
    refresh?: boolean;
    onProgress?: (ev: CollectProgressEvent) => void;
    /** Reuse a scan from TUI boot to avoid a second catalog walk. */
    scanned?: DetectedCli[];
  } = {},
): Promise<RosterReport> {
  const ids = ["claude", "codex", "cursor", "grok", "hermes"] as const;
  opts.onProgress?.({ phase: "start", ids: [...ids] });

  const track = async <T>(id: (typeof ids)[number], work: Promise<T>): Promise<T> => {
    try {
      const result = await work;
      opts.onProgress?.({ phase: "done", id });
      return result;
    } catch (err) {
      opts.onProgress?.({
        phase: "error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const [claude, codex, cursor, grok, hermes] = await Promise.all([
    track("claude", collectClaudeAll({ refresh: opts.refresh })),
    track("codex", collectCodex()),
    track("cursor", collectCursor()),
    track("grok", collectGrokAll()),
    track("hermes", collectHermesAll({ refresh: opts.refresh })),
  ]);

  const extras = collectDiscoveredExtras(opts.scanned);
  const providers = attachReferrals([
    ...claude,
    codex,
    cursor,
    ...grok,
    ...hermes,
    ...extras,
  ]);
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
  hermes: 4,
};

function compareSnapshots(a: ProviderSnapshot, b: ProviderSnapshot): number {
  const ao = PROVIDER_ORDER[a.id];
  const bo = PROVIDER_ORDER[b.id];
  // Metered fighters first (known order), then discovered extras alphabetically
  if (ao != null || bo != null) {
    const po = (ao ?? 100) - (bo ?? 100);
    if (po) return po;
  } else {
    const byName = a.displayName.localeCompare(b.displayName);
    if (byName) return byName;
  }
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
    (p) =>
      p.installed &&
      p.auth === "ok" &&
      !(p.error && !p.windows.length) &&
      (p.requestAvailability === "available" || p.score != null) &&
      (p.score == null || p.score < 95),
  );

  if (!ready.length) {
    const unavailable = providers.filter(
      (p) => p.installed && p.auth === "ok" && p.error && !p.windows.length,
    );
    const knownBlocked = providers.some(
      (p) =>
        p.installed &&
        p.auth === "ok" &&
        (p.requestAvailability === "blocked" || (p.score != null && p.score >= 95)),
    );
    if (unavailable.length && !knownBlocked) {
      return {
        id: null,
        line: `usage unavailable — retry ${unavailable.map((p) => p.displayName).join(" · ")}`,
      };
    }
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
    const sa = a.score;
    const sb = b.score;
    // Prefer fighters with real measured scores; lowest used % first.
    if (sa != null && sb != null && sa !== sb) return sa - sb;
    if (sa != null && sb == null) return -1;
    if (sa == null && sb != null) return 1;
    return Number(b.active) - Number(a.active);
  });
  const best = ready[0]!;
  const used =
    best.score != null ? `${Math.round(best.score)}% used` : null;
  const sub = best.subscription || best.plan;
  const bits = [sub, used].filter(Boolean);
  const detail = bits.length ? bits.join(" · ") : "auth ok";
  return {
    id: best.id,
    line: `→ fight with ${best.displayName}${best.active ? " ★" : ""} (${detail})`,
  };
}

export function primaryMeter(p: ProviderSnapshot): Meter | null {
  if (!p.windows.length) return null;
  const limiting = p.windows.filter(meterAffectsAvailability);
  if (!limiting.length) return null;
  return [...limiting].sort(
    (a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1),
  )[0]!;
}
