import { baseSnapshot } from "./snapshot.js";
import {
  attachPlanBilling,
  entryToFacts,
  normalizeCostInput,
  planBillingLabel,
} from "./plan-billing.js";
import { planCostInfo } from "./plan-cost.js";
import { planBillingSlot } from "./tui-card-body.js";
import { stripAnsi } from "./tui-ansi.js";
import { renderRoster } from "./render.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

assert(normalizeCostInput("99") === "$99/mo", "bare 99 → $99/mo");
assert(normalizeCostInput("$68.71") === "$68.71/mo", "$68.71 → monthly");
assert(normalizeCostInput("$300/mo") === "$300/mo", "already monthly");
assert(normalizeCostInput("free") === "$0", "free → $0");

{
  const facts = entryToFacts({
    cost: "$99/mo",
    listCost: "$300/mo",
    renewsOn: "2026-08-12",
    discount: "67% off until Oct 13",
  });
  assert(facts?.cost === "$99/mo", "facts cost");
  assert(facts?.planName == null, "no plan name when omitted");
  assert(planBillingLabel(facts!)?.includes("renews") === true, "label has renews");
  assert(planBillingLabel(facts!)?.includes("67%") === true, "label has discount");
}

{
  const named = entryToFacts({ plan: "Pro 20x", cost: "$200/mo" });
  assert(named?.planName === "Pro 20x" && named.cost === "$200/mo", "plan name override stored");
}

{
  const profiled = baseSnapshot({
    id: "claude",
    displayName: "Claude · personal",
    installed: true,
    auth: "ok",
  });
  profiled.profileId = "personal";
  profiled.profileLabel = "personal";
  const withFacts = attachPlanBilling([profiled], {
    personal: { cost: "$100/mo" },
  })[0]!;
  assert(withFacts.planBilling?.cost === "$100/mo", "legacy bare non-default profile billing resolves");
}

{
  const grok = baseSnapshot({ id: "grok", displayName: "Grok", installed: true, auth: "ok" });
  grok.plan = "SuperGrok Heavy";
  grok.subscription = "SuperGrok Heavy · xAI API tier 5";
  // Catalog alone would say $300/mo
  assert(planCostInfo(grok).cost === "$300/mo", "list price without facts");

  const withFacts = attachPlanBilling([grok], {
    grok: {
      cost: "$99/mo",
      listCost: "$300/mo",
      renewsOn: "2026-08-12",
      discount: "67% off until Oct 13",
    },
  })[0]!;
  assert(planCostInfo(withFacts).cost === "$99/mo", "declared cost beats list catalog");
  const slot = planBillingSlot(withFacts, 60);
  assert(slot != null && stripAnsi(slot.line).includes("renews"), "billing slot on card");
  assert(stripAnsi(slot!.line).includes("67%"), "discount on card");
}

{
  const routed = baseSnapshot({ id: "hermes", displayName: "Hermes", installed: true, auth: "ok" });
  routed.plan = "Pro";
  routed.subscription = "Codex Pro · via OpenAI Codex Pro";
  const withFacts = attachPlanBilling([routed], {
    hermes: { plan: "Pro 20x", cost: "$200/mo" },
  })[0]!;
  const rendered = renderRoster(
    {
      checkedAt: "2026-07-31T00:00:00Z",
      providers: [withFacts],
      pick: { id: "hermes", line: "test" },
      pathNotes: [],
    },
    {
      json: false,
      plain: true,
      emoji: false,
      who: false,
      doctor: false,
      refresh: false,
    },
  );
  assert(rendered.includes("Codex Pro 20x · via OpenAI Codex Pro"),
    "billing plan override preserves subscription route context");
}

console.log("\nplan-billing tests passed");
