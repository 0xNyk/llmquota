import { finalizeGrokProbeForTest } from "./providers/grok.js";
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

{
  const snap = finalizeGrokProbeForTest(base(), {
    ok: true,
    status: 200,
    json: { data: [] },
    text: "ok",
  });
  assert(snap.score == null, "ok probe → score null (no fake %)");
  assert(snap.windows.length === 0, "ok probe → no invented meter rows");
  assert(availability(snap) === "ready", "ok probe → ready");
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
  assert(availability(snap) === "ready", "API credits empty → still ready for weekly unknown");
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
