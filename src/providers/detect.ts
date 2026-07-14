import { whichAll } from "../util.js";
import { detectFromCatalog, scanInstalledClis, type DetectedCli } from "./catalog.js";

export type { DetectedCli };
export { scanInstalledClis, scanInstalledClisAsync } from "./catalog.js";

export interface DetectedBinary {
  path: string | null;
  version: string | null;
  installed: boolean;
}

function asBinary(d: DetectedCli): DetectedBinary {
  return { path: d.path, version: d.version, installed: d.installed };
}

export function detectClaude(): DetectedBinary {
  return asBinary(detectFromCatalog("claude"));
}

export function detectCodex(): DetectedBinary {
  return asBinary(detectFromCatalog("codex"));
}

/** Prefer Cursor agent binary; never trust bare `agent` (Grok often wins PATH). */
export function detectCursorAgent(): DetectedBinary {
  return asBinary(detectFromCatalog("cursor"));
}

export function detectGrok(): DetectedBinary {
  return asBinary(detectFromCatalog("grok"));
}

export function detectHermes(): DetectedBinary {
  return asBinary(detectFromCatalog("hermes"));
}

export function pathCollisionNotes(): string[] {
  const notes: string[] = [];
  const cursor = detectFromCatalog("cursor");
  const pathAgents = whichAll("agent");

  if (pathAgents.length >= 2) {
    const first = pathAgents[0]!;
    const hasGrok = pathAgents.some((a) => a.includes(".grok"));
    const hasCursor = pathAgents.some(
      (a) => a.includes("cursor-agent") || a.includes(".local/bin/agent"),
    );
    if (hasGrok && hasCursor) {
      notes.push(
        `PATH collision: \`agent\` resolves to ${first}. Cursor lives at ~/.local/bin/agent; Grok also ships \`agent\`. Prefer absolute paths or \`llmquota doctor\`.`,
      );
    }
  }

  if (cursor.installed && cursor.allPaths.length > 1) {
    notes.push(
      `Cursor agent binaries: ${cursor.allPaths.slice(0, 4).join(" · ")}${cursor.allPaths.length > 4 ? "…" : ""}`,
    );
  }

  return notes;
}

/** Full machine scan — metered + extras. */
export function detectAllClis(opts: { includeMissing?: boolean } = {}): DetectedCli[] {
  return scanInstalledClis(opts);
}
