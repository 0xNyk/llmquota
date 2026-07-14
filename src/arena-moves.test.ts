import { hopTarget, paceToFullSec, formatStatusline } from "./arena-moves.js";
import type { Meter, ProviderSnapshot, RosterReport } from "./types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

function snap(partial: Partial<ProviderSnapshot> & Pick<ProviderSnapshot, "id" | "displayName">): ProviderSnapshot {
  return {
    installed: true,
    binary: partial.id,
    version: null,
    auth: "ok",
    plan: "Pro",
    subscription: "Pro",
    account: null,
    windows: [],
    source: "test",
    error: null,
    hint: null,
    score: 20,
    referral: null,
    profileId: "default",
    profileLabel: "default",
    configDir: null,
    active: false,
    ...partial,
    requestAvailability: partial.requestAvailability ?? "available",
    activeProvider: partial.activeProvider ?? null,
    activeModel: partial.activeModel ?? null,
  };
}

{
  const providers = [
    snap({ id: "claude", displayName: "Claude", score: 90 }),
    snap({ id: "codex", displayName: "Codex", score: 10, active: true }),
    snap({
      id: "grok",
      displayName: "Grok",
      score: 100,
      windows: [
        {
          name: "weekly",
          label: "weekly",
          usedPercent: 100,
          resetsAt: new Date(Date.now() + 3600_000).toISOString(),
          availableIn: "1h",
          windowSeconds: 7 * 86400,
        },
      ],
    }),
  ];
  const hop = hopTarget(providers, 0);
  assert(hop != null && hop.index === 1, "hop prefers lowest score ready");
  assert(hop!.reason.includes("Codex"), "hop reason names fighter");
}

{
  const m: Meter = {
    name: "5h",
    label: "5h",
    usedPercent: 80,
    resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
    availableIn: "4h",
    windowSeconds: 5 * 3600,
  };
  // elapsed ~1h at 80% → would fill way before reset
  const sec = paceToFullSec(m);
  assert(sec != null && sec < 4 * 3600, "pace warns when burning hot");
}

{
  const report: RosterReport = {
    checkedAt: new Date().toISOString(),
    providers: [snap({ id: "codex", displayName: "Codex", score: 13, active: true })],
    pick: { id: "codex", line: "→ fight with Codex" },
    pathNotes: [],
  };
  const line = formatStatusline(report);
  assert(line.includes("Codex"), "statusline names pick");
  assert(line.includes("%") || line.includes("▮"), "statusline has signal");
}

console.log("\nall arena-moves tests passed");
