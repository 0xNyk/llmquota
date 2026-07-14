import { packCardSlots, selectionSlot, type CardSlot } from "./tui-card-body.js";
import { baseSnapshot } from "./snapshot.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

const slots: CardSlot[] = [
  { kind: "status", priority: 10, line: "status", sticky: true },
  { kind: "who", priority: 40, line: "who" },
  { kind: "meter", priority: 20, line: "hot" },
  { kind: "meter", priority: 50, line: "cool" },
  { kind: "meter", priority: 80, line: "cold" },
  { kind: "fact", priority: 60, line: "spend" },
  { kind: "hint", priority: 80, line: "hint" },
  { kind: "when", priority: 90, line: "when", sticky: true },
];

{
  const { lines, refBodyRow } = packCardSlots(slots, 5);
  assert(lines.length === 5, "packs to bodyH");
  assert(lines[0] === "status", "status first");
  assert(lines[lines.length - 1] === "when", "when last sticky");
  assert(lines.includes("hot"), "hottest meter kept");
  assert(!lines.includes("hint"), "hint dropped in tight pack");
  assert(refBodyRow == null, "no ref row");
}

{
  const hermes = baseSnapshot({
    id: "hermes",
    displayName: "Hermes",
    installed: true,
    activeProvider: "openai-codex",
    activeModel: "gpt-5.6-sol",
  });
  const slot = selectionSlot(hermes, 40);
  assert(Boolean(slot?.line.includes("openai-codex") && slot.line.includes("gpt-5.6-sol")),
    "active provider and model render in TUI selection slot");
  hermes.activeModel = null;
  assert(selectionSlot(hermes, 40)?.line.includes("model unknown") === true,
    "unknown active model is explicit instead of invented or hidden");
}

{
  const withRef: CardSlot[] = [
    ...slots,
    { kind: "ref", priority: 45, line: "ref" },
  ];
  const { lines, refBodyRow } = packCardSlots(withRef, 8);
  assert(lines.includes("ref"), "ref kept when room");
  assert(refBodyRow != null && lines[refBodyRow!] === "ref", "refBodyRow points at ref");
}

console.log("\nall card-body tests passed");
