/**
 * Deep-links to each account's real usage / billing profile.
 * Opens https only — never invents reset dates for Grok.
 */

import { execFileSync } from "node:child_process";
import type { ProviderSnapshot } from "./types.js";

export function usageProfileUrl(p: ProviderSnapshot): string | null {
  const id = p.id;
  if (id === "claude") {
    // Claude Code / Anthropic usage surfaces
    return "https://claude.ai/settings/usage";
  }
  if (id === "codex") {
    return "https://chatgpt.com/#settings/Usage";
  }
  if (id === "cursor") {
    return "https://cursor.com/dashboard?tab=usage";
  }
  if (id === "grok") {
    // SuperGrok weekly pool lives here — no stable public % API yet
    return "https://grok.com/settings";
  }
  if (id === "hermes") {
    return "https://portal.nousresearch.com/billing";
  }
  return null;
}

export function usageProfileLabel(p: ProviderSnapshot): string {
  const url = usageProfileUrl(p);
  if (!url) return "no usage profile URL for this fighter";
  return `${p.displayName} usage → ${url}`;
}

/** Open https usage page in the default browser (macOS `open`, else `xdg-open`). */
export function openUsageProfile(url: string): { ok: boolean; error?: string } {
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, error: "refusing to open non-https URL" };
  }
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
