import { baseSnapshot } from "./snapshot.js";
import {
  extractCostFromText,
  listPriceFor,
  planCostInfo,
  planCostLabel,
  shortPlanName,
} from "./plan-cost.js";
import { planLabel, statusSlot } from "./tui-card-body.js";
import { stripAnsi } from "./tui-ansi.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

assert(extractCostFromText("Nous tier 2 · $20.00/mo") === "$20/mo", "normalizes $20.00/mo to $20/mo");
assert(extractCostFromText("Pro") == null, "no phantom cost when absent");
assert(listPriceFor("claude", "Max 20x") === "$200/mo", "Claude Max 20x list price");
assert(listPriceFor("claude", "Max 5x") === "$100/mo", "Claude Max 5x list price ($100, not $99)");
assert(listPriceFor("claude", "Pro") === "$20/mo", "Claude Pro list price");
assert(listPriceFor("claude", "Max") == null, "ambiguous Claude Max has no list price");
assert(listPriceFor("cursor", "Ultra") === "$200/mo", "Cursor Ultra list price");
assert(listPriceFor("cursor", "Pro+") === "$60/mo", "Cursor Pro+ list price");
assert(listPriceFor("codex", "Pro") === "$200/mo", "Codex bare Pro defaults to $200 tier");
assert(listPriceFor("codex", "Pro 5x") === "$100/mo", "ChatGPT Pro 5x is $100/mo");
assert(listPriceFor("codex", "Pro 20x") === "$200/mo", "ChatGPT Pro 20x is $200/mo");
assert(listPriceFor("codex", "Plus") === "$20/mo", "Codex Plus list price");
assert(listPriceFor("hermes", "Pro 5x") === "$100/mo", "Hermes openai-codex Pro 5x is $100");
assert(listPriceFor("grok", "SuperGrok Heavy · xAI API tier 5") === "$300/mo", "SuperGrok Heavy list price");
assert(listPriceFor("grok", "SuperGrok · xAI API tier 2") === "$30/mo", "SuperGrok list price");

{
  const claude = baseSnapshot({ id: "claude", displayName: "Claude", installed: true, auth: "ok" });
  claude.plan = "Max 20x";
  claude.subscription = "Claude Max 20x";
  const info = planCostInfo(claude);
  assert(info.name === "Max 20x" && info.cost === "$200/mo", "Claude card plan+cost");
  assert(planCostLabel(claude) === "Max 20x · $200/mo", "Claude planCostLabel");
  assert(planLabel(claude) === "Max 20x · $200/mo", "planLabel includes cost");
  const plain = stripAnsi(statusSlot(claude, "ready", 0, 48).line);
  assert(plain.includes("Max 20x") && plain.includes("$200/mo"), "status line highlights plan and cost");
}

{
  const hermes = baseSnapshot({ id: "hermes", displayName: "Hermes", installed: true, auth: "ok" });
  hermes.plan = "tier 2";
  hermes.subscription = "Nous tier 2 · $20.00/mo";
  const info = planCostInfo(hermes);
  assert(info.name === "Nous tier 2" && info.cost === "$20/mo", "Hermes uses live monthly_charge");
  assert(shortPlanName(hermes).includes("tier 2"), "short plan keeps Nous tier");
}

{
  const cursor = baseSnapshot({ id: "cursor", displayName: "Cursor", installed: true, auth: "ok" });
  cursor.plan = "Ultra";
  cursor.subscription = "Cursor Ultra · active";
  assert(planCostInfo(cursor).cost === "$200/mo", "Cursor Ultra · active → $200/mo");
  assert(planCostLabel(cursor) === "Ultra · $200/mo", "Cursor plan label drops active suffix");
}

{
  const free = baseSnapshot({ id: "claude", displayName: "Claude", installed: true, auth: "ok" });
  free.plan = "Free";
  free.subscription = "Claude Free";
  assert(planCostInfo(free).cost === "$0", "Free plan costs $0");
}

{
  const unknown = baseSnapshot({ id: "gemini", displayName: "Gemini", installed: true });
  unknown.plan = "something";
  assert(planCostInfo(unknown).cost == null, "unknown provider has no invented price");
}

console.log("\nplan-cost tests passed");
