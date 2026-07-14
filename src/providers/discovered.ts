import type { ProviderSnapshot } from "../types.js";
import { loadLlmquotaConfig } from "../profiles.js";
import { baseSnapshot } from "../snapshot.js";
import { CLI_CATALOG, scanInstalledClis, type DetectedCli } from "./catalog.js";

const METERED_IDS = new Set(CLI_CATALOG.filter((c) => c.metered).map((c) => c.id));

/**
 * Snapshots for installed CLIs that have no live quota collector yet.
 * Shown in the arena sideline / doctor / scan so discovery is visible.
 */
export function collectDiscoveredExtras(scanned?: DetectedCli[]): ProviderSnapshot[] {
  const cfg = loadLlmquotaConfig();
  if (cfg.detectExtraClis === false) return [];

  const installed = scanned ?? scanInstalledClis({ includeMissing: false });
  const out: ProviderSnapshot[] = [];

  for (const hit of installed) {
    if (METERED_IDS.has(hit.id)) continue;
    out.push(detectedToSnapshot(hit));
  }

  return out;
}

export function detectedToSnapshot(hit: DetectedCli): ProviderSnapshot {
  return baseSnapshot({
    id: hit.id,
    displayName: hit.displayName,
    installed: hit.installed,
    binary: hit.path,
    version: hit.version,
    source: "detect",
    hint: hit.hint || (hit.metered ? null : "Detected — no quota probe yet"),
    active: false,
  });
}

/** Machine-readable scan rows (used by `llmquota scan`). */
export function formatScanRows(hits: DetectedCli[]): string {
  const lines: string[] = [];
  const width = Math.max(8, ...hits.map((h) => h.displayName.length));
  for (const h of hits) {
    const mark = h.installed ? (h.metered ? "●" : "○") : "·";
    const ver = h.version ? h.version.slice(0, 40) : "—";
    const where = h.path || (h.homePresent ? "(home only)" : "—");
    const tag = h.metered ? "metered" : "detect";
    lines.push(
      `${mark} ${h.displayName.padEnd(width)}  ${tag.padEnd(7)}  ${ver.padEnd(42)}  ${where}`,
    );
    if (h.allPaths.length > 1) {
      for (const p of h.allPaths.slice(1, 4)) {
        lines.push(`${"".padEnd(width + 3)}  also  ${p}`);
      }
    }
  }
  return lines.join("\n");
}
