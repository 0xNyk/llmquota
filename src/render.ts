import type { CliOptions, Meter, ProviderSnapshot, RosterReport } from "./types.js";
import { primaryMeter } from "./collect.js";
import { formatTerminalProbe, probeTerminal } from "./terminal.js";
import { usageLevel } from "./usage-level.js";
import { meterAffectsAvailability } from "./util.js";

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

function levelGlyph(opts: CliOptions, used: number | null): string {
  const lvl = usageLevel(used);
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
  const lvl = usageLevel(used);
  const code =
    lvl === "red" ? RED : lvl === "yellow" ? YELLOW : lvl === "green" ? GREEN : BLUE;
  return c(opts, code, body);
}

function statusTag(p: ProviderSnapshot): string {
  if (!p.installed) return "not installed";
  if (p.auth === "missing") return "not logged in";
  if (p.auth === "expired") return "auth expired";
  if (p.auth === "error") return "auth error";
  if (p.error && !p.windows.length) return "usage unavailable";
  if (p.requestAvailability === "blocked" && p.score == null) return "KO";
  if (p.requestAvailability === "unknown" && p.score == null) return "usage unknown";
  // Prefer aggregate score so a maxed sub-window with top-up left isn't false KO
  if (p.score != null) {
    if (p.score >= 100) return "KO";
    if (p.score >= 90) return "limping";
    return "ready";
  }
  if (p.windows.some((w) => meterAffectsAvailability(w) && (w.usedPercent ?? 0) >= 100)) return "KO";
  if (p.windows.some((w) => meterAffectsAvailability(w) && (w.usedPercent ?? 0) >= 90)) return "limping";
  return p.requestAvailability === "available" ? "ready" : "usage unknown";
}

function formatMeterReset(m: Meter): string {
  // Prefer real absolute reset; relative availableIn is secondary.
  if (m.resetsAt) {
    const t = Date.parse(m.resetsAt);
    if (!Number.isNaN(t)) {
      const d = new Date(t);
      const mon = d.toLocaleString("en-US", { month: "short" });
      const stamp = `${mon} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return m.availableIn ? `reset ${stamp} (in ${m.availableIn})` : `reset ${stamp}`;
    }
  }
  if (m.availableIn) return `resets in ${m.availableIn}`;
  return "";
}

function meterLine(opts: CliOptions, m: Meter): string {
  const reset = formatMeterReset(m);
  const detail = m.detail ? `  ${DIM_PLAIN(opts, m.detail)}` : "";
  // No invented % — omit bar/% when usage was not measured.
  if (m.usedPercent == null) {
    return `  ${levelGlyph(opts, null)} ${m.label.padEnd(12)}${reset ? `  ${reset}` : ""}${detail}`;
  }
  const pct = `${String(Math.round(m.usedPercent)).padStart(3)}%`;
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
  const active = p.active ? c(opts, CYAN, " ★") : "";
  const head = `${levelGlyph(opts, primaryMeter(p)?.usedPercent ?? null)} ${c(opts, BOLD, p.displayName)}${active}${plan}  ${tag}${ver}`;

  const lines = [head];

  if (!p.installed) {
    lines.push(c(opts, DIM, `  ${p.hint || "not on PATH"}`));
    return lines.join("\n");
  }

  if (p.profileId !== "default" && p.configDir) {
    lines.push(c(opts, DIM, `  profile ${p.profileLabel}  ·  ${p.configDir}`));
  }
  if (sub) {
    lines.push(`  ${c(opts, CYAN, "subscription")}  ${sub}`);
  }
  if (p.account) {
    lines.push(`  ${c(opts, DIM, "account")}       ${p.account}`);
  }
  if (p.activeProvider) {
    lines.push(`  ${c(opts, DIM, "provider")}      ${p.activeProvider}`);
  }
  if (p.activeProvider || p.activeModel) {
    lines.push(`  ${c(opts, DIM, "model")}         ${p.activeModel || "unknown"}`);
  }
  if (p.score != null && p.auth === "ok") {
    const headroom = Math.max(0, Math.round(100 - p.score));
    lines.push(
      `  ${c(opts, DIM, "headroom")}      ${headroom}%  ·  ${Math.round(p.score)}% used`,
    );
  }
  if (p.referral?.label) {
    const codeBit = p.referral.code ? `${p.referral.code}  ` : "";
    lines.push(
      `  ${c(opts, CYAN, "referral")}     ${codeBit}${p.referral.link || p.referral.label}`,
    );
    if (p.referral.detail) {
      lines.push(c(opts, DIM, `               ${p.referral.detail}`));
    }
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
    const label = p.displayName;
    lines.push(
      `${mark} ${label.padEnd(22)} installed=${p.installed} auth=${p.auth} sub=${p.subscription || p.plan || "?"} source=${p.source}${p.active ? " ★" : ""}`,
    );
    if (p.configDir) lines.push(c(opts, DIM, `     dir ${p.configDir}`));
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

  const detected = report.providers.filter((p) => p.source === "detect");
  if (detected.length) {
    lines.push("");
    lines.push(c(opts, BOLD, "detected CLIs (no quota probe yet)"));
    for (const p of detected) {
      lines.push(
        `  ○ ${p.displayName.padEnd(18)} ${c(opts, DIM, p.binary || "—")}${p.version ? c(opts, DIM, `  ${p.version.slice(0, 36)}`) : ""}`,
      );
    }
    lines.push(c(opts, DIM, "  full catalog: llmquota scan"));
  }

  lines.push("");
  lines.push(c(opts, BOLD, "terminal"));
  const probe = probeTerminal();
  for (const line of formatTerminalProbe(probe)) {
    lines.push(c(opts, DIM, `  ${line}`));
  }
  if (!probe.tty || !probe.stdinTty) {
    lines.push(c(opts, DIM, "  mouse: n/a (not a TTY)"));
  } else if (probe.mouseDisabledByEnv) {
    lines.push(c(opts, YELLOW, "  mouse: disabled (LLMQUOTA_NO_MOUSE / --no-mouse)"));
  } else if (probe.mouseLikely) {
    lines.push(c(opts, GREEN, "  mouse: likely OK (SGR 1006) — enable reporting in the emulator if clicks do nothing"));
  } else {
    lines.push(
      c(
        opts,
        YELLOW,
        "  mouse: uncertain — try Ghostty/iTerm/Kitty, or llmquota --no-mouse inside tmux/zellij",
      ),
    );
  }

  lines.push("");
  lines.push(c(opts, CYAN, report.pick.line));
  return lines.join("\n") + "\n";
}

export function renderRefs(report: RosterReport, opts: CliOptions): string {
  const lines: string[] = [];
  lines.push(c(opts, BOLD, "llmquota referrals"));
  lines.push(c(opts, DIM, "copy with: llmquota copy <claude|codex|cursor|grok|hermes>"));
  lines.push("");
  const seen = new Set<string>();
  for (const p of report.providers) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const ref = p.referral;
    if (!ref?.label) {
      lines.push(`${p.id.padEnd(8)}  ${c(opts, DIM, "— none (set ~/.config/llmquota/referrals.json)")}`);
      continue;
    }
    const code = ref.code ? `${ref.code}  ` : "";
    lines.push(`${c(opts, BOLD, p.id.padEnd(8))}  ${code}${ref.link || ref.label}`);
    if (ref.detail) lines.push(c(opts, DIM, `          ${ref.detail}`));
    lines.push(c(opts, DIM, `          source: ${ref.source}`));
  }
  lines.push("");
  lines.push(
    c(
      opts,
      DIM,
      "Config: ~/.config/llmquota/referrals.json  ·  Claude auto-reads ~/.claude.json guest passes",
    ),
  );
  return lines.join("\n") + "\n";
}
