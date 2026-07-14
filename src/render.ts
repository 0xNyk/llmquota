import type { CliOptions, Meter, ProviderSnapshot, RosterReport } from "./types.js";
import { primaryMeter } from "./collect.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function colorEnabled(opts: CliOptions): boolean {
  if (opts.plain || opts.emoji || opts.json) return false;
  return Boolean(process.stdout.isTTY);
}

function c(opts: CliOptions, code: string, text: string): string {
  return colorEnabled(opts) ? `${code}${text}${RESET}` : text;
}

function level(used: number | null): "blue" | "green" | "yellow" | "red" | "unknown" {
  if (used == null) return "unknown";
  if (used >= 90) return "red";
  if (used >= 70) return "yellow";
  if (used >= 35) return "green";
  return "blue";
}

function levelGlyph(opts: CliOptions, used: number | null): string {
  const lvl = level(used);
  if (opts.emoji) {
    return { blue: "🔵", green: "🟢", yellow: "🟡", red: "🔴", unknown: "⚪" }[lvl];
  }
  const map = {
    blue: BLUE,
    green: GREEN,
    yellow: YELLOW,
    red: RED,
    unknown: DIM,
  } as const;
  const mark = { blue: "◆", green: "◆", yellow: "◆", red: "◆", unknown: "◇" }[lvl];
  return c(opts, map[lvl], mark);
}

function bar(opts: CliOptions, used: number | null, width = 14): string {
  if (used == null) {
    return c(opts, DIM, "·".repeat(width));
  }
  const pct = Math.max(0, Math.min(100, used));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const body = "█".repeat(filled) + "░".repeat(empty);
  const lvl = level(used);
  const code =
    lvl === "red" ? RED : lvl === "yellow" ? YELLOW : lvl === "green" ? GREEN : BLUE;
  return c(opts, code, body);
}

function statusTag(p: ProviderSnapshot): string {
  if (!p.installed) return "not installed";
  if (p.auth === "missing") return "not logged in";
  if (p.auth === "expired") return "auth expired";
  if (p.auth === "error") return "auth error";
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 100)) return "KO";
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 90)) return "limping";
  return "ready";
}

function meterLine(opts: CliOptions, m: Meter): string {
  const pct =
    m.usedPercent == null ? "  ?%" : `${String(Math.round(m.usedPercent)).padStart(3)}%`;
  const reset = m.availableIn ? `resets in ${m.availableIn}` : m.resetsAt ? `reset ${m.resetsAt}` : "";
  const detail = m.detail ? `  ${DIM_PLAIN(opts, m.detail)}` : "";
  return `  ${levelGlyph(opts, m.usedPercent)} ${m.label.padEnd(12)} ${bar(opts, m.usedPercent)} ${pct}  ${reset}${detail}`;
}

function DIM_PLAIN(opts: CliOptions, text: string): string {
  return c(opts, DIM, text);
}

export function renderRoster(report: RosterReport, opts: CliOptions): string {
  if (opts.who) {
    return report.pick.line + "\n";
  }

  const lines: string[] = [];
  lines.push(c(opts, BOLD, "llmquota roster") + c(opts, DIM, `  ·  ${report.checkedAt}`));
  lines.push("");

  for (const p of report.providers) {
    lines.push(renderProvider(p, opts));
    lines.push("");
  }

  lines.push(c(opts, CYAN, report.pick.line));

  for (const note of report.pathNotes) {
    lines.push(c(opts, YELLOW, `⚠ ${note}`));
  }

  return lines.join("\n").trimEnd() + "\n";
}

function renderProvider(p: ProviderSnapshot, opts: CliOptions): string {
  const tag = statusTag(p);
  const sub = p.subscription || (p.plan ? `${p.displayName} ${p.plan}` : null);
  const plan = p.plan ? c(opts, DIM, ` · ${p.plan}`) : "";
  const ver = p.version ? c(opts, DIM, `  ${p.version}`) : "";
  const head = `${levelGlyph(opts, primaryMeter(p)?.usedPercent ?? null)} ${c(opts, BOLD, p.displayName)}${plan}  ${tag}${ver}`;

  const lines = [head];

  if (!p.installed) {
    lines.push(c(opts, DIM, `  ${p.hint || "not on PATH"}`));
    return lines.join("\n");
  }

  if (sub) {
    lines.push(`  ${c(opts, CYAN, "subscription")}  ${sub}`);
  }
  if (p.account) {
    lines.push(`  ${c(opts, DIM, "account")}       ${p.account}`);
  }

  if (p.binary) {
    lines.push(c(opts, DIM, `  ${p.binary}`));
  }

  if (p.windows.length) {
    for (const m of p.windows) {
      lines.push(meterLine(opts, m));
    }
  } else if (p.auth === "ok") {
    lines.push(c(opts, DIM, "  (no live meters — see hint)"));
  }

  if (p.error) lines.push(c(opts, RED, `  ⚠ ${p.error}`));
  if (p.hint) lines.push(c(opts, DIM, `  ${p.hint}`));

  return lines.join("\n");
}

export function renderDoctor(report: RosterReport, opts: CliOptions): string {
  const lines: string[] = [];
  lines.push(c(opts, BOLD, "llmquota doctor"));
  lines.push("");

  for (const p of report.providers) {
    const ok = p.installed && p.auth === "ok";
    const mark = ok ? c(opts, GREEN, "OK") : c(opts, YELLOW, "…");
    lines.push(
      `${mark} ${p.displayName.padEnd(8)} installed=${p.installed} auth=${p.auth} sub=${p.subscription || p.plan || "?"} source=${p.source}`,
    );
    if (p.binary) lines.push(c(opts, DIM, `     bin ${p.binary}`));
    if (p.error) lines.push(c(opts, RED, `     ${p.error}`));
    if (p.hint) lines.push(c(opts, DIM, `     ${p.hint}`));
  }

  lines.push("");
  if (report.pathNotes.length) {
    lines.push(c(opts, YELLOW, "PATH notes"));
    for (const n of report.pathNotes) lines.push(`  ${n}`);
  } else {
    lines.push(c(opts, GREEN, "No agent PATH collisions detected (or only one agent on PATH)."));
  }

  lines.push("");
  lines.push(c(opts, CYAN, report.pick.line));
  return lines.join("\n") + "\n";
}
