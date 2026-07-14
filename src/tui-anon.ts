import { homedir } from "node:os";
import type { ProviderSnapshot, RosterReport } from "./types.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactPrivateText(value: string): string {
  let text = value;
  const home = homedir();
  const user = home.split("/").filter(Boolean).at(-1) || "";
  if (home) text = text.replace(new RegExp(escapeRegex(home), "g"), "<home>");
  text = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\/(?:Users|home|root|private|var|tmp|Volumes)\/[^\s│]+/g, "<path>");
  if (user.length >= 3) text = text.replace(new RegExp(`\\b${escapeRegex(user)}\\b`, "gi"), "<user>");
  return text;
}

function anonymousProvider(p: ProviderSnapshot): ProviderSnapshot {
  return {
    ...p,
    displayName: p.displayName.split(" · ")[0] || p.displayName,
    account: null,
    profileId: p.profileId === "default" ? "default" : "profile",
    profileLabel: p.profileId === "default" ? "default" : "profile",
    configDir: null,
    referral: null,
    hint: p.hint ? redactPrivateText(p.hint) : null,
    error: p.error ? redactPrivateText(p.error) : null,
    windows: p.windows
      .filter((w) => !(w.detail && /[$€£]|balance|bonus|credit/i.test(w.detail)))
      .map((w) => ({ ...w, detail: w.detail ? redactPrivateText(w.detail) : null })),
  };
}

export function anonymousReport(report: RosterReport): RosterReport {
  return {
    ...report,
    providers: report.providers.map(anonymousProvider),
    pick: { ...report.pick, line: redactPrivateText(report.pick.line) },
    pathNotes: [],
  };
}
