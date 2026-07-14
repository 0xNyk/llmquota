import {
  applyGrokBillingRecord,
  finalizeGrokProbeForTest,
  parseGrokBillingLogLine,
} from "./providers/grok.js";
import { baseSnapshot } from "./snapshot.js";
import { availability } from "./tui-model.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

function base() {
  return baseSnapshot({
    id: "grok",
    displayName: "Grok",
    installed: true,
    binary: "/tmp/grok",
    version: "0.1",
    auth: "ok",
  });
}

const billingLine = JSON.stringify({
  ts: "2026-07-14T16:10:28.586Z",
  msg: "billing: fetched credits config",
  ctx: {
    config: {
      creditUsagePercent: 100,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-13T02:47:16.234615+00:00",
        end: "2026-07-20T02:47:16.234615+00:00",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
    },
    onDemandEnabled: null,
    subscriptionTier: "SuperGrok Heavy",
  },
});

{
  const record = parseGrokBillingLogLine(billingLine);
  assert(record?.usedPercent === 100 && record.subscriptionTier === "SuperGrok Heavy",
    "Grok authoritative weekly billing log parses without invented values");
  const snap = applyGrokBillingRecord(base(), record!, Date.parse("2026-07-14T18:10:28Z"));
  assert(snap.windows[0]?.usedPercent === 100 &&
    snap.windows[0]?.resetsAt?.startsWith("2026-07-20") === true,
    "Grok weekly percent and reset come from the provider-fetched record");
  assert(snap.requestAvailability === "blocked" && availability(snap) === "tired",
    "Grok recorded exhaustion remains blocking until its real weekly reset");
  assert(snap.subscription?.includes("SuperGrok Heavy") === true,
    "Grok subscription tier comes from the provider-fetched billing record");

  const stalePartial = applyGrokBillingRecord(base(), { ...record!, usedPercent: 94 },
    Date.parse("2026-07-14T18:10:28Z"));
  assert(stalePartial.score == null && stalePartial.requestAvailability === "unknown",
    "Grok stale partial usage stays visible without pretending to be current availability");

  const onDemand = applyGrokBillingRecord(base(), {
    ...record!,
    onDemandEnabled: true,
    onDemandCap: 20,
    onDemandUsed: 5,
  }, Date.parse("2026-07-14T18:10:28Z"));
  assert(onDemand.requestAvailability === "available" && onDemand.score == null,
    "Grok real on-demand headroom prevents a false weekly KO score");
}

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: true,
    status: 200,
    json: { data: [] },
    text: "ok",
  });
  assert(snap.score == null, "ok probe → score null (no fake %)");
  assert(snap.windows.length === 0, "ok probe → no invented meter rows");
  assert(availability(snap) === "unknown", "ok probe → weekly availability remains unknown");
  assert(Boolean(snap.hint), "ok probe → hint points to real usage UI");
}

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: false,
    status: 403,
    json: { error: "You have run out of credits or need a Grok subscription. Add credits at https://" },
    text: "run out",
  });
  assert(snap.score == null, "API credits 403 → score null (not SuperGrok KO)");
  assert(snap.windows.length === 0, "API credits 403 → no invented meter rows");
  assert(availability(snap) === "unknown", "API credits empty → weekly availability remains unknown");
  assert(/api\.x\.ai credits/i.test(snap.hint || ""), "API credits → real hint");
}

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: false,
    status: 403,
    json: { error: "rate limit exceeded" },
    text: "rate limit",
  });
  assert(snap.score == null, "rate-limit 403 → no invented 100%");
  assert(snap.windows.length === 0, "rate-limit → no invented meter rows");
  assert(/limit signal|rate/i.test(snap.hint || ""), "rate-limit → hint only");
}

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: false,
    status: 403,
    json: { error: "forbidden" },
    text: "forbidden",
  });
  assert(snap.score == null, "vague 403 → no invented KO score");
  assert(snap.windows.length === 0, "vague 403 → no invented meter rows");
}

console.log("\nall grok probe tests passed");
