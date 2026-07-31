import { baseSnapshot } from "./snapshot.js";
import {
  attachPlanChange,
  buildScheduledChange,
  classifyPlanChange,
  formatPlanChangeWhen,
  isPlanChangeStale,
  planChangeLabel,
  resolveConfigChange,
} from "./plan-change.js";
import { planChangeSlot, statusSlot } from "./tui-card-body.js";
import { stripAnsi } from "./tui-ansi.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

assert(classifyPlanChange("claude", "Max 20x", "Pro") === "downgrade", "Max 20x → Pro is downgrade");
assert(classifyPlanChange("cursor", "Pro", "Ultra") === "upgrade", "Pro → Ultra is upgrade");
assert(classifyPlanChange("cursor", "Ultra", null) === "cancel", "null next is cancel");
assert(classifyPlanChange("grok", "SuperGrok Heavy", "SuperGrok") === "downgrade", "Heavy → SuperGrok");
assert(classifyPlanChange("codex", "Pro 20x", "Pro 5x") === "downgrade", "ChatGPT Pro 20x → Pro 5x");
assert(classifyPlanChange("hermes", "Ultra", null) === "cancel", "Nous Ultra → Free is cancel");
assert(classifyPlanChange("hermes", "Ultra", "Free") === "downgrade" || classifyPlanChange("hermes", "Ultra", "Free") === "cancel",
  "Ultra → Free ranks as drop");

{
  const cancel = buildScheduledChange({
    providerId: "cursor",
    currentPlan: "Ultra",
    nextPlan: null,
    effectiveAt: "2026-08-09T05:06:47.000Z",
    source: "cursor_local",
  });
  assert(cancel.kind === "cancel", "cancel kind");
  assert(planChangeLabel(cancel).includes("cancels"), "cancel label");
  assert(planChangeLabel(cancel).includes("Aug"), "cancel date short month");
  assert(formatPlanChangeWhen(cancel.effectiveAt)?.includes("Aug") === true, "when stamp");
}

{
  const down = buildScheduledChange({
    providerId: "claude",
    currentPlan: "Max 20x",
    nextPlan: "Pro",
    effectiveAt: "2026-08-07T00:00:00.000Z",
    source: "config",
  });
  assert(down.kind === "downgrade" && down.nextCost === "$20/mo", "downgrade cost for Pro");
  assert(planChangeLabel(down) === "↓ Pro · $20/mo · Aug 7" || planChangeLabel(down).startsWith("↓ Pro"),
    `downgrade label (${planChangeLabel(down)})`);
}

{
  const cursor = baseSnapshot({ id: "cursor", displayName: "Cursor", installed: true, auth: "ok" });
  cursor.plan = "Ultra";
  cursor.subscription = "Cursor Ultra · active";
  cursor.planChange = buildScheduledChange({
    providerId: "cursor",
    currentPlan: "Ultra",
    nextPlan: null,
    effectiveAt: "2026-08-09T05:06:47.000Z",
    source: "cursor_local",
  });

  // User declared destination Pro; keep Cursor's cancel date.
  const merged = attachPlanChange(cursor, {
    cursor: { to: "Pro" },
  });
  assert(merged.planChange?.nextPlan === "Pro", "config supplies next plan");
  assert(merged.planChange?.kind === "downgrade", "Ultra → Pro classified as downgrade");
  assert(merged.planChange?.effectiveAt?.startsWith("2026-08-09") === true, "keeps detected date");
  assert(merged.planChange?.nextCost === "$20/mo", "Pro list price");

  const slot = planChangeSlot(merged, 48);
  assert(slot != null && stripAnsi(slot.line).includes("Pro"), "card plan slot shows next");
  assert(stripAnsi(statusSlot(merged, "ready", 0, 48).line).includes("Ultra"), "status still shows current");

  cursor.planChange = buildScheduledChange({
    providerId: "cursor",
    currentPlan: "Ultra",
    nextPlan: "Pro",
    effectiveAt: "2026-08-09T05:06:47.000Z",
    source: "cursor_local",
  });
  const canceled = attachPlanChange(cursor, {
    cursor: { to: "cancel" },
  });
  assert(canceled.planChange?.nextPlan == null, "declared cancel overrides detected next plan");
  assert(canceled.planChange?.kind === "cancel", "declared cancel keeps cancel semantics");
  assert(canceled.planChange?.effectiveAt?.startsWith("2026-08-09") === true,
    "declared cancel keeps detected effective date");
}

{
  const claude = baseSnapshot({ id: "claude", displayName: "Claude", installed: true, auth: "ok" });
  claude.plan = "Max 20x";
  const fromCfg = resolveConfigChange(claude, {
    claude: { to: "Max 5x", on: "2026-09-01" },
  });
  assert(fromCfg?.kind === "downgrade" && fromCfg.nextPlan === "Max 5x", "config-only Claude change");
  assert(fromCfg?.effectiveAt?.startsWith("2026-09-01") === true, "YYYY-MM-DD → ISO");

  claude.profileId = "personal";
  claude.profileLabel = "personal";
  const fromProfile = resolveConfigChange(claude, {
    personal: { to: "Pro", on: "2026-09-02" },
  });
  assert(fromProfile?.nextPlan === "Pro", "legacy bare non-default profile change resolves");
}

{
  const done = baseSnapshot({ id: "claude", displayName: "Claude", installed: true, auth: "ok" });
  done.plan = "Pro";
  const change = buildScheduledChange({
    providerId: "claude",
    currentPlan: "Pro",
    nextPlan: "Pro",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    source: "config",
  });
  assert(isPlanChangeStale(done, change), "stale when already on next plan");
  const cleared = attachPlanChange(done, { claude: { to: "Pro", on: "2026-07-01" } });
  assert(cleared.planChange == null, "stale config change not shown");
}

{
  // Coarse API plan "Pro" must not hide a ChatGPT Pro 20x → Pro 5x schedule.
  const codex = baseSnapshot({ id: "codex", displayName: "Codex", installed: true, auth: "ok" });
  codex.plan = "Pro";
  codex.planBilling = {
    planName: "Pro 20x",
    cost: "$200/mo",
    listCost: null,
    renewsOn: null,
    discount: null,
    source: "config",
  };
  const live = attachPlanChange(codex, { codex: { to: "Pro 5x", on: "2026-08-12" } });
  assert(live.planChange?.kind === "downgrade", "Pro 20x → Pro 5x stays live as downgrade");
  assert(live.planChange?.nextPlan === "Pro 5x", "next plan preserved");
  assert(
    !isPlanChangeStale(
      codex,
      buildScheduledChange({
        providerId: "codex",
        currentPlan: "Pro",
        nextPlan: "Pro 5x",
        effectiveAt: "2026-08-12T00:00:00.000Z",
        source: "config",
      }),
    ),
    "API Pro is not a substring-stale match for Pro 5x",
  );
}

console.log("\nplan-change tests passed");
