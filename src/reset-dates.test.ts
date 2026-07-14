import { busPollGrowth, busSend, busFileSize } from "./bus.js";
import { distinctResetFacts, formatResetAt } from "./tui-model.js";
import { baseSnapshot } from "./snapshot.js";
import { usageProfileUrl } from "./usage-profile.js";
import type { Meter } from "./types.js";
import { isoFromEpochSec, normalizeIsoTimestamp } from "./util.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

{
  assert(isoFromEpochSec(1784163600) === "2026-07-16T01:00:00.000Z",
    "epoch seconds normalize to ISO");
  assert(isoFromEpochSec(1784163600000) === "2026-07-16T01:00:00.000Z",
    "epoch milliseconds normalize to ISO");
  assert(isoFromEpochSec(Number.MAX_VALUE) == null,
    "extreme finite reset epoch remains unknown without throwing");
  assert(isoFromEpochSec(-1) == null, "negative reset epoch remains unknown");
  assert(normalizeIsoTimestamp("2026-07-15T12:00:00+00:00") != null,
    "timezone-bearing provider ISO accepted");
  assert(normalizeIsoTimestamp("2026-07-15 12:00:00") == null,
    "ambiguous timezone-free timestamp rejected");
  assert(normalizeIsoTimestamp("2026-02-30T12:00:00Z") == null,
    "impossible calendar date rejected instead of normalized");
  assert(normalizeIsoTimestamp("not-a-date") == null, "invalid provider ISO rejected");
}

{
  const iso = "2026-07-15T09:40:00.000Z";
  const stamp = formatResetAt(iso);
  assert(stamp != null && /\d/.test(stamp), "formatResetAt returns calendar stamp");
  assert(formatResetAt(null) == null, "formatResetAt null → null");
  assert(formatResetAt("not-a-date") == null, "formatResetAt junk → null");
}

{
  const windows: Meter[] = [
    {
      name: "five_hour",
      label: "5h",
      usedPercent: 40,
      resetsAt: "2026-07-14T18:00:00.000Z",
      availableIn: "2h",
      windowSeconds: 5 * 3600,
    },
    {
      name: "seven_day",
      label: "7d",
      usedPercent: 20,
      resetsAt: "2026-07-20T12:00:00.000Z",
      availableIn: "5d",
      windowSeconds: 7 * 86400,
    },
  ];
  const p = baseSnapshot({
    id: "claude",
    displayName: "Claude",
    installed: true,
    auth: "ok",
  });
  p.windows = windows;
  const facts = distinctResetFacts(p);
  assert(facts.length === 2, "distinctResetFacts keeps different window dates");
}

{
  const same: Meter[] = [
    {
      name: "a",
      label: "plan",
      usedPercent: 10,
      resetsAt: "2026-07-20T00:00:00.000Z",
      availableIn: null,
      windowSeconds: null,
    },
    {
      name: "b",
      label: "auto",
      usedPercent: 20,
      resetsAt: "2026-07-20T00:00:00.000Z",
      availableIn: null,
      windowSeconds: null,
    },
  ];
  const p = baseSnapshot({
    id: "cursor",
    displayName: "Cursor",
    installed: true,
    auth: "ok",
  });
  p.windows = same;
  const facts = distinctResetFacts(p);
  assert(facts.length === 1, "same stamp collapses to one fact");
}

{
  const p = baseSnapshot({ id: "grok", displayName: "Grok", installed: true });
  const url = usageProfileUrl(p);
  assert(Boolean(url && url.startsWith("https://")), "grok usage URL is https");
  const claudeUrl = usageProfileUrl(
    baseSnapshot({ id: "claude", displayName: "Claude", installed: true }),
  );
  assert(Boolean(claudeUrl?.includes("claude")), "claude usage URL");
}

{
  const before = busFileSize();
  const token = `growth-${Date.now()}`;
  busSend({ text: token, to: "all", from: "test-growth" });
  const growth = busPollGrowth(before);
  assert(growth.size > before, "busPollGrowth sees file grow");
  assert(
    growth.newMessages.some((m) => m.text === token),
    "busPollGrowth returns new message",
  );
  const idle = busPollGrowth(growth.size);
  assert(idle.newMessages.length === 0, "busPollGrowth idle → empty");
}

console.log("\nall reset-dates / usage / bus-growth tests passed");
