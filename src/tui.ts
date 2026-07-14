import { collectAll, primaryMeter } from "./collect.js";
import type { Meter, ProviderSnapshot, RosterReport } from "./types.js";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const BLUE = `${ESC}[34m`;
const CYAN = `${ESC}[36m`;
const BG_DIM = `${ESC}[48;5;236m`;

const REFRESH_MS = 45_000;
const CARD_INNER = 34;
const CARD_H = 8;

type Level = "blue" | "green" | "yellow" | "red" | "unknown";

function level(used: number | null): Level {
  if (used == null) return "unknown";
  if (used >= 90) return "red";
  if (used >= 70) return "yellow";
  if (used >= 35) return "green";
  return "blue";
}

function levelColor(lvl: Level): string {
  return { blue: BLUE, green: GREEN, yellow: YELLOW, red: RED, unknown: DIM }[lvl];
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

function padVisible(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) {
    // truncate carefully (ansi-naive but ok for our strings)
    const plain = stripAnsi(s);
    return plain.slice(0, Math.max(0, width - 1)) + "…";
  }
  return s + " ".repeat(width - len);
}

function bar(used: number | null, width: number): string {
  if (used == null) return `${DIM}${"·".repeat(width)}${RESET}`;
  const pct = Math.max(0, Math.min(100, used));
  const filled = Math.round((pct / 100) * width);
  const body = "█".repeat(filled) + "░".repeat(width - filled);
  return `${levelColor(level(used))}${body}${RESET}`;
}

function statusTag(p: ProviderSnapshot): { label: string; color: string } {
  if (!p.installed) return { label: "MISSING", color: DIM };
  if (p.auth === "missing") return { label: "NO LOGIN", color: YELLOW };
  if (p.auth === "expired") return { label: "AUTH EXPIRED", color: RED };
  if (p.auth === "error") return { label: "AUTH ERROR", color: RED };
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 100)) return { label: "KO", color: RED };
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 90)) return { label: "LIMPING", color: YELLOW };
  return { label: "READY", color: GREEN };
}

function meterRow(m: Meter, width: number): string {
  const barW = Math.max(8, Math.min(16, width - 18));
  const pct = m.usedPercent == null ? "  ?" : String(Math.round(m.usedPercent)).padStart(3);
  const reset = m.availableIn ? m.availableIn : "—";
  const label = m.label.slice(0, 8).padEnd(8);
  return `${label} ${bar(m.usedPercent, barW)} ${pct}%  ${DIM}${reset}${RESET}`;
}

function boxLines(title: string, body: string[], inner: number): string[] {
  const top = `╭─ ${title} ${"─".repeat(Math.max(1, inner - visibleLen(title) - 3))}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  const mid = body.map((line) => `│ ${padVisible(line, inner - 2)} │`);
  while (mid.length < CARD_H - 2) {
    mid.push(`│ ${" ".repeat(inner - 2)} │`);
  }
  return [top, ...mid.slice(0, CARD_H - 2), bottom];
}

function providerCard(p: ProviderSnapshot, inner: number): string[] {
  const st = statusTag(p);
  const plan = p.plan ? ` · ${p.plan}` : "";
  const title = `${p.displayName}${plan}`.slice(0, inner - 4);
  const lines: string[] = [];
  lines.push(`${st.color}${BOLD}${st.label}${RESET}`);

  if (!p.installed) {
    lines.push(`${DIM}not installed${RESET}`);
    lines.push(p.hint || "");
  } else if (p.auth !== "ok") {
    lines.push(`${DIM}${p.hint || p.error || "re-auth needed"}${RESET}`);
  } else if (!p.windows.length) {
    lines.push(`${DIM}no live meters${RESET}`);
    if (p.hint) lines.push(`${DIM}${p.hint}${RESET}`);
  } else {
    for (const m of p.windows.slice(0, 4)) {
      lines.push(meterRow(m, inner - 2));
    }
    if (p.hint && p.windows.some((w) => (w.usedPercent ?? 0) >= 90)) {
      lines.push(`${DIM}${p.hint.slice(0, inner - 4)}${RESET}`);
    }
  }

  const primary = primaryMeter(p);
  const borderColor = levelColor(level(primary?.usedPercent ?? null));
  return boxLines(title, lines, inner).map((line, i) =>
    i === 0 || i === CARD_H - 1 ? `${borderColor}${line}${RESET}` : line,
  );
}

function zipRows(left: string[], right: string[], gap = 2): string[] {
  const rows: string[] = [];
  const n = Math.max(left.length, right.length);
  const spacer = " ".repeat(gap);
  for (let i = 0; i < n; i++) {
    rows.push(`${left[i] || ""}${spacer}${right[i] || ""}`);
  }
  return rows;
}

function frame(
  report: RosterReport | null,
  opts: { loading?: boolean; error?: string; lastRefresh?: string },
): string {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const useGrid = cols >= 78;
  const inner = useGrid
    ? Math.min(CARD_INNER, Math.floor((cols - 6) / 2))
    : Math.min(56, cols - 4);

  const out: string[] = [];
  out.push(
    `${BOLD}${CYAN} llmquota${RESET}${DIM}  arena${RESET}  ${DIM}${opts.lastRefresh || ""}${RESET}`,
  );
  out.push("");

  if (opts.loading && !report) {
    out.push(`${DIM}  gathering fighters…${RESET}`);
  } else if (opts.error && !report) {
    out.push(`${RED}  ${opts.error}${RESET}`);
  } else if (report) {
    const cards = report.providers.map((p) => providerCard(p, inner));
    if (useGrid) {
      out.push(...zipRows(cards[0]!, cards[1]!));
      out.push("");
      out.push(...zipRows(cards[2]!, cards[3]!));
    } else {
      for (const card of cards) {
        out.push(...card);
        out.push("");
      }
    }

    out.push("");
    out.push(`  ${CYAN}${BOLD}${report.pick.line}${RESET}`);
    if (opts.loading) out.push(`  ${DIM}refreshing…${RESET}`);
    for (const note of report.pathNotes.slice(0, 2)) {
      out.push(`  ${YELLOW}⚠${RESET} ${DIM}${note.slice(0, Math.max(20, cols - 6))}${RESET}`);
    }
  }

  out.push("");
  out.push(
    `  ${BG_DIM}${DIM} r refresh  ·  q quit  ·  auto ${Math.round(REFRESH_MS / 1000)}s ${RESET}`,
  );

  // pad / clip to terminal
  const clipped = out.slice(0, Math.max(1, rows - 1));
  while (clipped.length < rows - 1) clipped.push("");
  return clipped.map((l) => padVisible(l, cols)).join("\n");
}

function writeScreen(content: string): void {
  process.stdout.write(`${ESC}[H${ESC}[J${content}`);
}

function enterAlt(): void {
  process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
}

function leaveAlt(): void {
  process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
}

export async function runTui(opts: { refresh?: boolean } = {}): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("TUI needs an interactive terminal (stdout + stdin TTY)");
  }

  let report: RosterReport | null = null;
  let loading = false;
  let error: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const redraw = (): void => {
    if (closed) return;
    writeScreen(
      frame(report, {
        loading,
        error: error || undefined,
        lastRefresh: report?.checkedAt
          ? new Date(report.checkedAt).toLocaleTimeString()
          : undefined,
      }),
    );
  };

  const load = async (force = false): Promise<void> => {
    loading = true;
    error = null;
    redraw();
    try {
      report = await collectAll({ refresh: force || opts.refresh });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
      redraw();
    }
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    leaveAlt();
  };

  enterAlt();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const onKey = (key: string): void => {
    if (key === "\u0003" || key === "q" || key === "Q") {
      cleanup();
      process.exit(0);
    }
    if (key === "r" || key === "R") {
      void load(true);
    }
  };

  process.stdin.on("data", onKey);
  process.stdout.on("resize", redraw);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  await load(false);
  timer = setInterval(() => {
    void load(false);
  }, REFRESH_MS);

  // keep alive
  await new Promise<void>(() => {
    /* resolved via process.exit in onKey */
  });
}
