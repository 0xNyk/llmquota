import { CLI_CATALOG, detectCatalogEntry, scanInstalledClis } from "./providers/catalog.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

assert(CLI_CATALOG.some((c) => c.id === "claude" && c.metered), "claude metered in catalog");
assert(CLI_CATALOG.some((c) => c.id === "ollama" && !c.metered), "ollama detect-only in catalog");

const claude = detectCatalogEntry(CLI_CATALOG.find((c) => c.id === "claude")!);
assert(typeof claude.installed === "boolean", "claude detect returns installed flag");

const installed = scanInstalledClis({ includeMissing: false });
assert(Array.isArray(installed), "scan returns array");
assert(
  installed.every((h) => h.installed),
  "scan without includeMissing only returns installed",
);

const all = scanInstalledClis({ includeMissing: true });
assert(all.length >= installed.length, "includeMissing returns full catalog");
assert(all.length === CLI_CATALOG.length, "includeMissing covers every catalog entry");

// Cursor must not resolve to Grok's agent
const cursor = detectCatalogEntry(CLI_CATALOG.find((c) => c.id === "cursor")!);
if (cursor.path) {
  assert(
    !cursor.path.includes(".grok"),
    `cursor path is not grok (${cursor.path})`,
  );
}

console.log("\nall catalog detection tests passed");
