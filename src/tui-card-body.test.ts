import { cardTitle, packCardSlots, selectionSlot, statusSlot, type CardSlot } from "./tui-card-body.js";
import { padPlain, vlen } from "./tui-ansi.js";
import { allocateRowBodyHeights, partialRowOffset } from "./tui-cards.js";
import { usageWave } from "./tui-model.js";
import { anonymousReport, redactPrivateText } from "./tui-anon.js";
import type { RosterReport } from "./types.js";
import { clusterProviderRoutes, providerRouteGroup, sharedRouteGroups } from "./tui-groups.js";
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
  const exact = padPlain("12345", 5);
  assert(exact === "12345" && vlen(exact) === 5, "exact-width content is not replaced by an ellipsis");
  assert(padPlain("123456", 5).endsWith("…"), "overflowing content still truncates visibly");
}

{
  const codex = baseSnapshot({ id: "codex", displayName: "Codex", installed: true, auth: "ok", activeProvider: "OpenAI" });
  const cursor = baseSnapshot({ id: "cursor", displayName: "Cursor", installed: true, auth: "ok", activeProvider: "Cursor" });
  const hermes = baseSnapshot({ id: "hermes", displayName: "Hermes", installed: true, auth: "ok", activeProvider: "openai-codex" });
  for (const p of [codex, cursor, hermes]) p.requestAvailability = "available";
  const clustered = clusterProviderRoutes([codex, cursor, hermes].map((p, i) => ({ p, i })));
  assert(clustered.map(({ p }) => p.id).join(",") === "codex,hermes,cursor",
    "harnesses sharing OpenAI render next to each other");
  assert(providerRouteGroup(hermes) === "OpenAI",
    "Hermes openai-codex route normalizes to OpenAI");
  assert(sharedRouteGroups(clustered)[0]?.names.join("+") === "Codex+Hermes",
    "shared route container names each grouped harness without merging cards");
}

{
  const privateSnap = baseSnapshot({
    id: "codex",
    displayName: "Codex · personal",
    installed: true,
    account: "person@example.com",
    profileId: "secret-profile",
    profileLabel: "secret-profile",
    configDir: "/Users/person/.codex",
  });
  privateSnap.referral = { code: "secret-code", link: "https://example.com/secret", label: "secret-code", source: "test", detail: null };
  privateSnap.windows = [{ name: "spend", label: "spend", usedPercent: 50, resetsAt: null, availableIn: null, windowSeconds: null, detail: "$50 used" }];
  const report: RosterReport = { checkedAt: new Date(0).toISOString(), providers: [privateSnap], pick: { id: "codex", line: "fight person@example.com" }, pathNotes: ["/Users/person/private"] };
  const safe = anonymousReport(report);
  assert(safe.providers[0]?.account == null && safe.providers[0]?.referral == null,
    "anonymous report removes account and referral identity");
  assert(safe.providers[0]?.configDir == null && safe.pathNotes.length === 0,
    "anonymous report removes local directories");
  assert(safe.providers[0]?.windows.length === 0,
    "anonymous report removes billing-only usage details");
  assert(!redactPrivateText("person@example.com /Users/person/private").includes("person@example.com"),
    "anonymous text redacts emails and home paths");
}

{
  const cooldown = baseSnapshot({
    id: "codex",
    displayName: "Codex",
    installed: true,
    auth: "ok",
  });
  cooldown.requestAvailability = "blocked";
  assert(cardTitle(cooldown, "tired", 3600).includes("COOLDOWN"), "blocked card title names cooldown explicitly");
  assert(statusSlot(cooldown, "tired", 0, 48).line.includes("COOLDOWN"), "blocked card badge names cooldown explicitly");
  cooldown.requestAvailability = "unknown";
  assert(!statusSlot(cooldown, "unknown", 0, 48).line.includes("COOLDOWN"), "unknown availability is not mislabeled cooldown");
}

{
  const track = usageWave("quota", 21, 24, 0);
  assert(!track.includes("│"), "quota track stays continuous without an unexplained divider");
  assert(track.includes("━") && track.includes("─"), "quota track distinguishes used from remaining capacity");
  assert(usageWave("quota", 0, 24, 0).includes("─") && !usageWave("quota", 0, 24, 0).includes("━"),
    "zero-percent quota renders as an empty track");
  assert(/[▁▂▃▄▅▆▇█]/.test(usageWave("quota", 92, 24, 1, 0.7)),
    "high-pressure quota renders an animated wave");
}

{
  const heights = allocateRowBodyHeights([10, 7], 14);
  assert(heights.reduce((sum, h) => sum + h, 0) === 14, "card rows fit the available body budget");
  assert(heights.every((h) => h >= 5), "card rows retain the minimum body height");
  assert(partialRowOffset(2, 3, 40, 3) === 21, "incomplete three-column row is centered");
  assert(partialRowOffset(3, 3, 40, 3) === 0, "full grid row keeps the base margin");
}

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
