import { collectAll, primaryMeter } from "./collect.js";
import { copyToClipboard } from "./clipboard.js";
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

/** Dark charcoal arena — base + faint grit (no purple). */
const BG = `${ESC}[48;5;234m`;
const BG_PANEL = `${ESC}[48;5;235m`;
const FG_GRIT = `${ESC}[38;5;237m`;
const FG_MUTE = `${ESC}[38;5;240m`;
const FOOTER_BG = `${ESC}[48;5;236m`;

const REFRESH_MS = 45_000;
const CARD_MIN_INNER = 28;
const GAP = 2;
const MARGIN = 1;

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

/** Stable grit glyph so redraws don't flicker. */
function grit(row: number, col: number): string {
  const n = (row * 131 + col * 47 + (row ^ col) * 3) & 31;
  if (n === 0) return "·";
  if (n === 1 || n === 2) return "░";
  if (n === 3) return "‧";
  return " ";
}

function texturedPad(row: number, startCol: number, width: number): string {
  if (width <= 0) return "";
  let out = `${BG}${FG_GRIT}`;
  for (let i = 0; i < width; i++) out += grit(row, startCol + i);
  return `${out}${RESET}`;
}

function padVisible(s: string, width: number, row: number, startCol: number): string {
  const len = visibleLen(s);
  if (len > width) {
    const plain = stripAnsi(s);
    return plain.slice(0, Math.max(0, width - 1)) + "…";
  }
  if (len === width) return s;
  return s + texturedPad(row, startCol + len, width - len);
}

function paintLine(content: string, cols: number, row: number): string {
  // Wrap entire line in BG so empty cells stay dark
  const body = padVisible(`${BG}${content}`, cols, row, 0);
  // Ensure we start with BG even if content has its own colors
  return `${BG}${body}${RESET}`;
}

function bar(used: number | null, width: number): string {
  if (used == null) return `${DIM}${"·".repeat(width)}${RESET}`;
  const pct = Math.max(0, Math.min(100, used));
  const filled = Math.round((pct / 100) * width);
  const body = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  return `${levelColor(level(used))}${body}${RESET}`;
}

function statusTag(p: ProviderSnapshot): { label: string; color: string } {
  if (!p.installed) return { label: "MISSING", color: DIM };
  if (p.auth === "missing") return { label: "NO LOGIN", color: YELLOW };
  if (p.auth === "expired") return { label: "AUTH EXPIRED", color: RED };
  if (p.auth === "error") return { label: "AUTH ERROR", color: RED };
  if (p.score != null) {
    if (p.score >= 100) return { label: "KO", color: RED };
    if (p.score >= 90) return { label: "LIMPING", color: YELLOW };
    return { label: "READY", color: GREEN };
  }
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 100)) return { label: "KO", color: RED };
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 90)) return { label: "LIMPING", color: YELLOW };
  return { label: "READY", color: GREEN };
}

function meterRow(m: Meter, contentWidth: number): string {
  const labelW = Math.min(10, Math.max(6, Math.floor(contentWidth * 0.18)));
  const pctW = 4;
  const resetW = 7;
  const barW = Math.max(10, contentWidth - labelW - pctW - resetW - 4);
  const pct = m.usedPercent == null ? "  ?" : String(Math.round(m.usedPercent)).padStart(3);
  const reset = (m.availableIn || "—").slice(0, resetW).padEnd(resetW);
  const label = m.label.slice(0, labelW).padEnd(labelW);
  return `${label} ${bar(m.usedPercent, barW)} ${pct}% ${DIM}${reset}${RESET}`;
}

function boxLines(title: string, body: string[], inner: number, focused: boolean): string[] {
  const titleText = title.slice(0, Math.max(1, inner - 4));
  const dash = Math.max(1, inner - visibleLen(titleText) - 3);
  const focusMark = focused ? "▌" : "─";
  const top = `╭${focusMark} ${titleText} ${"─".repeat(dash)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  const mid = body.map((line) => `│ ${padVisiblePlain(line, inner - 2)} │`);
  const cardH = Math.max(8, body.length + 2);
  while (mid.length < cardH - 2) {
    mid.push(`│ ${" ".repeat(inner - 2)} │`);
  }
  return [top, ...mid.slice(0, cardH - 2), bottom];
}

function padVisiblePlain(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) {
    const plain = stripAnsi(s);
    return plain.slice(0, Math.max(0, width - 1)) + "…";
  }
  return s + " ".repeat(width - len);
}

function providerCard(
  p: ProviderSnapshot,
  inner: number,
  focused: boolean,
): string[] {
  const st = statusTag(p);
  const sub = p.subscription || (p.plan ? `${p.id} ${p.plan}` : null);
  const titleMark = p.active ? `${p.displayName} ★` : p.displayName;
  const lines: string[] = [];
  lines.push(`${st.color}${BOLD}${st.label}${RESET}`);
  if (sub) lines.push(`${CYAN}sub${RESET}  ${sub}`);
  else lines.push(`${DIM}sub  unknown${RESET}`);
  if (p.account) lines.push(`${DIM}${p.account}${RESET}`);
  if (p.referral?.label) {
    const code = p.referral.code ? `${p.referral.code} ` : "";
    const link = (p.referral.link || p.referral.label).slice(0, Math.max(12, inner - 10));
    lines.push(`${CYAN}ref${RESET}  ${code}${link}`);
  }

  if (!p.installed) {
    lines.push(`${DIM}not installed${RESET}`);
    if (p.hint) lines.push(`${DIM}${p.hint}${RESET}`);
  } else if (p.auth !== "ok") {
    lines.push(`${DIM}${(p.hint || p.error || "re-auth needed").slice(0, inner - 4)}${RESET}`);
  } else if (!p.windows.length) {
    lines.push(`${DIM}no live meters${RESET}`);
    if (p.hint) lines.push(`${DIM}${p.hint.slice(0, inner - 4)}${RESET}`);
  } else {
    for (const m of p.windows.slice(0, 4)) {
      lines.push(meterRow(m, inner - 2));
    }
    if (p.hint && p.windows.some((w) => (w.usedPercent ?? 0) >= 90)) {
      lines.push(`${DIM}${p.hint.slice(0, inner - 4)}${RESET}`);
    }
  }

  const primary = primaryMeter(p);
  const borderColor = focused
    ? CYAN
    : levelColor(level(primary?.usedPercent ?? (p.auth === "ok" ? 0 : null)));
  const boxed = boxLines(titleMark, lines, inner, focused);
  return boxed.map((line, i) => {
    if (i === 0 || i === boxed.length - 1) {
      return `${borderColor}${line}${RESET}`;
    }
    return `${BG_PANEL}${line}${RESET}`;
  });
}

function zipRows(left: string[], right: string[], gap: number, rowOffset: number): string[] {
  const rows: string[] = [];
  const n = Math.max(left.length, right.length);
  const leftW = left[0] ? visibleLen(left[0]) : 0;
  for (let i = 0; i < n; i++) {
    const L = left[i] || texturedPad(rowOffset + i, 0, leftW);
    const R = right[i] || "";
    const spacer = texturedPad(rowOffset + i, leftW, gap);
    rows.push(`${L}${spacer}${R}`);
  }
  return rows;
}

interface Layout {
  cols: number;
  rows: number;
  useGrid: boolean;
  inner: number;
  margin: number;
  gap: number;
}

function computeLayout(): Layout {
  const cols = Math.max(40, process.stdout.columns || 80);
  const rows = Math.max(16, process.stdout.rows || 24);
  const margin = MARGIN;
  const gap = GAP;
  // 2-col when we can fit two decent cards
  const useGrid = cols >= 72;
  let inner: number;
  if (useGrid) {
    // Fill width: margin + card + gap + card + margin = cols
    // each card outer width = inner + 2 (borders already in box using inner as inside width between corners)
    // box outer visible width = inner + 2
    const usable = cols - margin * 2 - gap;
    const cardOuter = Math.floor(usable / 2);
    inner = Math.max(CARD_MIN_INNER, cardOuter - 2);
  } else {
    const cardOuter = cols - margin * 2;
    inner = Math.max(CARD_MIN_INNER, cardOuter - 2);
  }
  return { cols, rows, useGrid, inner, margin, gap };
}

function frame(
  report: RosterReport | null,
  opts: {
    loading?: boolean;
    error?: string;
    lastRefresh?: string;
    focus?: number;
    toast?: string;
  },
): string {
  const layout = computeLayout();
  const { cols, rows, useGrid, inner, margin, gap } = layout;
  const out: string[] = [];

  const header =
    `${BOLD}${CYAN} llmquota${RESET}${FG_MUTE}  arena${RESET}` +
    `${DIM}  ${opts.lastRefresh || ""}${RESET}` +
    `${DIM}  ${cols}×${rows}${RESET}`;
  out.push(header);
  out.push("");

  if (opts.loading && !report) {
    out.push(`${DIM}  gathering fighters…${RESET}`);
  } else if (opts.error && !report) {
    out.push(`${RED}  ${opts.error}${RESET}`);
  } else if (report) {
    const cards = report.providers.map((p, i) =>
      providerCard(p, inner, opts.focus === i),
    );

    const indent = " ".repeat(margin);
    if (useGrid) {
      for (let i = 0; i < cards.length; i += 2) {
        if (i > 0) out.push("");
        const left = cards[i]!;
        const right = cards[i + 1];
        if (right) {
          out.push(
            ...zipRows(left, right, gap, out.length).map((l) => indent + l),
          );
        } else {
          for (const line of left) out.push(indent + line);
        }
      }
    } else {
      for (const card of cards) {
        for (const line of card) out.push(indent + line);
        out.push("");
      }
    }

    out.push("");
    out.push(`  ${CYAN}${BOLD}${report.pick.line}${RESET}`);
    if (opts.loading) out.push(`  ${DIM}refreshing…${RESET}`);
    if (opts.toast) out.push(`  ${GREEN}${opts.toast}${RESET}`);
    for (const note of report.pathNotes.slice(0, 1)) {
      out.push(`  ${YELLOW}⚠${RESET} ${DIM}${note.slice(0, Math.max(20, cols - 6))}${RESET}`);
    }
  }

  out.push("");
  const n = report?.providers.length ?? 0;
  const focusHint =
    n <= 9 ? `1-${Math.min(9, Math.max(1, n))} focus` : `1-9 focus · tab next`;
  const footer =
    `${FOOTER_BG}${DIM} ${focusHint} · c copy ref · r refresh · q quit · silo profiles · auto ${Math.round(REFRESH_MS / 1000)}s ${RESET}`;
  out.push(footer);

  // Paint full canvas with textured dark background
  const painted: string[] = [];
  for (let r = 0; r < rows; r++) {
    const line = out[r] ?? "";
    painted.push(paintLine(line, cols, r));
  }
  return painted.join("\n");
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
  let focus = 0;
  let toast: string | null = null;
  let toastTimer: NodeJS.Timeout | null = null;

  const showToast = (msg: string): void => {
    toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
      redraw();
    }, 2500);
    redraw();
  };

  const redraw = (): void => {
    if (closed) return;
    writeScreen(
      frame(report, {
        loading,
        error: error || undefined,
        lastRefresh: report?.checkedAt
          ? new Date(report.checkedAt).toLocaleTimeString()
          : undefined,
        focus,
        toast: toast || undefined,
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
    if (toastTimer) clearTimeout(toastTimer);
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
      return;
    }
    if (key >= "1" && key <= "9") {
      const idx = Number(key) - 1;
      if (report && idx < report.providers.length) {
        focus = idx;
        redraw();
      }
      return;
    }
    if (key === "\t") {
      if (report?.providers.length) {
        focus = (focus + 1) % report.providers.length;
        redraw();
      }
      return;
    }
    if (key === "c" || key === "C") {
      const p: ProviderSnapshot | undefined = report?.providers[focus];
      const payload = p?.referral?.link || p?.referral?.label || p?.referral?.code;
      if (!payload) {
        showToast(
          `${p?.displayName || "provider"}: no referral — set ~/.config/llmquota/referrals.json`,
        );
        return;
      }
      if (copyToClipboard(payload)) {
        showToast(`copied ${p!.displayName} referral → clipboard`);
      } else {
        showToast(`clipboard failed — ${payload}`);
      }
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

  await new Promise<void>(() => {
    /* resolved via process.exit in onKey */
  });
}
