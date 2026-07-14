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
const WHITE = `${ESC}[37m`;

/** Charcoal arena — textured, no purple. */
const BG = `${ESC}[48;5;233m`;
const BG_PANEL = `${ESC}[48;5;235m`;
const BG_HERO = `${ESC}[48;5;236m`;
const FG_GRIT = `${ESC}[38;5;236m`;
const FG_MUTE = `${ESC}[38;5;240m`;
const FG_SOFT = `${ESC}[38;5;245m`;
const FOOTER_BG = `${ESC}[48;5;235m`;

const REFRESH_MS = 45_000;
const CARD_MIN_INNER = 30;
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

function vlen(s: string): number {
  return stripAnsi(s).length;
}

function grit(row: number, col: number): string {
  const n = (row * 131 + col * 47 + (row ^ col) * 3) & 63;
  if (n === 0) return "·";
  if (n === 1) return "░";
  if (n === 2 || n === 3) return "‧";
  return " ";
}

function texturedPad(row: number, startCol: number, width: number): string {
  if (width <= 0) return "";
  let out = `${BG}${FG_GRIT}`;
  for (let i = 0; i < width; i++) out += grit(row, startCol + i);
  return `${out}${RESET}`;
}

function padVisible(s: string, width: number, row: number, startCol: number): string {
  const len = vlen(s);
  if (len > width) {
    const plain = stripAnsi(s);
    return plain.slice(0, Math.max(0, width - 1)) + "…";
  }
  if (len === width) return s;
  return s + texturedPad(row, startCol + len, width - len);
}

function paintLine(content: string, cols: number, row: number): string {
  const body = padVisible(`${BG}${content}`, cols, row, 0);
  return `${BG}${body}${RESET}`;
}

function padPlain(s: string, width: number): string {
  const len = vlen(s);
  if (len >= width) {
    const plain = stripAnsi(s);
    return plain.slice(0, Math.max(0, width - 1)) + "…";
  }
  return s + " ".repeat(width - len);
}

function bar(used: number | null, width: number): string {
  if (used == null) return `${FG_MUTE}${"┈".repeat(width)}${RESET}`;
  const pct = Math.max(0, Math.min(100, used));
  const filled = Math.round((pct / 100) * width);
  const body = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  return `${levelColor(level(used))}${body}${RESET}`;
}

interface StatusInfo {
  label: string;
  short: string;
  color: string;
  kind: "ready" | "warn" | "ko" | "auth" | "missing";
}

function statusInfo(p: ProviderSnapshot): StatusInfo {
  if (!p.installed) return { label: "missing", short: "—", color: DIM, kind: "missing" };
  if (p.auth === "missing") return { label: "no login", short: "···", color: YELLOW, kind: "auth" };
  if (p.auth === "expired") return { label: "expired", short: "!", color: RED, kind: "auth" };
  if (p.auth === "error") return { label: "error", short: "!", color: RED, kind: "auth" };
  if (p.score != null) {
    if (p.score >= 100) return { label: "ko", short: "✕", color: RED, kind: "ko" };
    if (p.score >= 90) return { label: "limping", short: "!", color: YELLOW, kind: "warn" };
    return { label: "ready", short: "●", color: GREEN, kind: "ready" };
  }
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 100)) {
    return { label: "ko", short: "✕", color: RED, kind: "ko" };
  }
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 90)) {
    return { label: "limping", short: "!", color: YELLOW, kind: "warn" };
  }
  return { label: "ready", short: "●", color: GREEN, kind: "ready" };
}

function isDormant(p: ProviderSnapshot): boolean {
  return !p.installed || p.auth === "missing";
}

function meterRow(m: Meter, contentWidth: number): string {
  const labelW = Math.min(8, Math.max(5, Math.floor(contentWidth * 0.14)));
  const rightW = 11;
  const barW = Math.max(8, contentWidth - labelW - rightW - 2);
  const label = m.label.slice(0, labelW).padEnd(labelW);

  if (m.usedPercent == null) {
    const detail = (m.detail || "—").slice(0, contentWidth - labelW - 2);
    return `${FG_SOFT}${label}${RESET} ${DIM}${detail}${RESET}`;
  }

  const pct = String(Math.round(m.usedPercent)).padStart(3);
  const reset = (m.availableIn || "").slice(0, 6).padStart(6);
  return `${FG_SOFT}${label}${RESET} ${bar(m.usedPercent, barW)} ${levelColor(level(m.usedPercent))}${pct}%${RESET}${DIM}${reset ? ` ${reset}` : ""}${RESET}`;
}

function boxCard(
  title: string,
  body: string[],
  inner: number,
  focused: boolean,
  accent: string,
): string[] {
  const focusGlyph = focused ? "◆" : " ";
  const titleText = `${focusGlyph} ${title}`.slice(0, Math.max(1, inner - 2));
  const dash = Math.max(0, inner - vlen(titleText) - 1);
  const top = `╭${titleText} ${"─".repeat(dash)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  const mid = body.map((line) => `│ ${padPlain(line, inner - 2)} │`);
  return [top, ...mid, bottom].map((line, i) => {
    if (i === 0 || i === body.length + 1) return `${accent}${line}${RESET}`;
    return `${BG_PANEL}${line}${RESET}`;
  });
}

function fighterCard(p: ProviderSnapshot, inner: number, focused: boolean): string[] {
  const st = statusInfo(p);
  const accent = focused
    ? CYAN
    : st.kind === "ready"
      ? GREEN
      : st.kind === "warn"
        ? YELLOW
        : st.kind === "ko" || st.kind === "auth"
          ? RED
          : FG_MUTE;

  const title = p.displayName;
  const lines: string[] = [];

  // Status + plan on one line
  const plan = (p.subscription || p.plan || "—").replace(/^Claude\s+/i, "").replace(/^Nous\s+/i, "Nous ");
  lines.push(
    `${st.color}${BOLD}${st.short}${RESET} ${st.color}${st.label}${RESET}  ${DIM}${plan.slice(0, Math.max(8, inner - 14))}${RESET}`,
  );

  if (p.auth === "ok" && p.windows.length) {
    for (const m of p.windows.slice(0, 3)) {
      lines.push(meterRow(m, inner - 2));
    }
  } else if (p.auth !== "ok") {
    const hint = (p.hint || p.error || "sign in required").replace(/\s+/g, " ");
    lines.push(`${DIM}${hint.slice(0, inner - 4)}${RESET}`);
  } else {
    lines.push(`${DIM}no meters yet${RESET}`);
  }

  if (focused && p.active) {
    lines.push(`${CYAN}★ active profile${RESET}`);
  }

  return boxCard(title, lines, inner, focused, accent);
}

function dormantChip(p: ProviderSnapshot, width: number, focused: boolean): string {
  const st = statusInfo(p);
  const mark = focused ? `${CYAN}▸${RESET}` : `${DIM}·${RESET}`;
  const body = `${mark} ${p.displayName}  ${st.color}${st.label}${RESET}  ${DIM}${(p.hint || "").slice(0, 28)}${RESET}`;
  return padPlain(body, width);
}

interface Layout {
  cols: number;
  rows: number;
  columns: 1 | 2 | 3;
  inner: number;
  margin: number;
  gap: number;
}

function computeLayout(cardCount: number): Layout {
  const cols = Math.max(40, process.stdout.columns || 80);
  const rows = Math.max(16, process.stdout.rows || 24);
  const margin = MARGIN;
  const gap = GAP;

  let columns: 1 | 2 | 3 = 1;
  if (cols >= 120 && cardCount >= 3) columns = 3;
  else if (cols >= 72) columns = 2;

  const usable = cols - margin * 2 - gap * (columns - 1);
  const cardOuter = Math.floor(usable / columns);
  const inner = Math.max(CARD_MIN_INNER, cardOuter - 2);

  return { cols, rows, columns, inner, margin, gap };
}

function zipN(cards: string[][], gap: number, rowOffset: number): string[] {
  if (!cards.length) return [];
  const rows: string[] = [];
  const height = Math.max(...cards.map((c) => c.length));
  const widths = cards.map((c) => (c[0] ? vlen(c[0]) : 0));

  for (let r = 0; r < height; r++) {
    let line = "";
    let col = 0;
    for (let i = 0; i < cards.length; i++) {
      if (i > 0) {
        line += texturedPad(rowOffset + r, col, gap);
        col += gap;
      }
      const cell = cards[i]![r] || texturedPad(rowOffset + r, col, widths[i]!);
      line += cell;
      col += widths[i]!;
    }
    rows.push(line);
  }
  return rows;
}

function heroPick(report: RosterReport, cols: number): string {
  const pick = report.pick.line.replace(/^→\s*/, "").replace(/\s*★/, "");
  const inner = Math.max(20, cols - 4);
  const text = `${BOLD}${WHITE}→  ${pick}${RESET}`;
  return `${BG_HERO}  ${padPlain(text, inner)}${RESET}`;
}

function focusStrip(p: ProviderSnapshot | undefined, cols: number): string {
  if (!p) return "";
  const bits: string[] = [`${CYAN}${p.displayName}${RESET}`];
  if (p.account) bits.push(`${DIM}${p.account}${RESET}`);
  if (p.hint) bits.push(`${DIM}${p.hint.replace(/\s+/g, " ").slice(0, 48)}${RESET}`);
  if (p.referral?.code) bits.push(`${FG_SOFT}ref ${p.referral.code}${RESET}`);
  else if (p.referral?.label) bits.push(`${FG_SOFT}c · copy ref${RESET}`);
  const line = bits.join(`${DIM}  ·  ${RESET}`);
  return `  ${padPlain(line, cols - 4)}`;
}

function frame(
  report: RosterReport | null,
  opts: {
    loading?: boolean;
    error?: string;
    lastRefresh?: string;
    focus?: number;
    toast?: string;
    showDormant?: boolean;
  },
): string {
  const showDormant = opts.showDormant !== false;
  const providers = report?.providers ?? [];
  const focusIdx = opts.focus ?? 0;

  // Visual order: ready fighters first, then limping/ko, dormant last
  const indexed = providers.map((p, i) => ({ p, i }));
  const rank = (p: ProviderSnapshot): number => {
    const st = statusInfo(p);
    if (st.kind === "ready") return 0;
    if (st.kind === "warn") return 1;
    if (st.kind === "ko") return 2;
    if (st.kind === "auth") return 3;
    return 4;
  };
  indexed.sort((a, b) => {
    const d = rank(a.p) - rank(b.p);
    if (d) return d;
    return a.i - b.i;
  });

  const fighters = indexed.filter((x) => !isDormant(x.p));
  const dormant = indexed.filter((x) => isDormant(x.p));

  const layout = computeLayout(Math.max(1, fighters.length));
  const { cols, rows, columns, inner, margin, gap } = layout;
  const out: string[] = [];
  const indent = " ".repeat(margin);

  // Header — brand + time only
  out.push(
    ` ${BOLD}${WHITE}llmquota${RESET}${FG_MUTE}  arena${RESET}` +
      `${DIM}  ${opts.lastRefresh || ""}${RESET}`,
  );

  if (opts.loading && !report) {
    out.push("");
    out.push(`${DIM}  reading quotas…${RESET}`);
  } else if (opts.error && !report) {
    out.push("");
    out.push(`${RED}  ${opts.error}${RESET}`);
  } else if (report) {
    out.push("");
    out.push(heroPick(report, cols));
    out.push("");

    // Fighter cards in responsive grid (original index preserved for focus)
    const cards = fighters.map(({ p, i }) => fighterCard(p, inner, focusIdx === i));

    if (cards.length) {
      for (let i = 0; i < cards.length; i += columns) {
        if (i > 0) out.push("");
        const slice = cards.slice(i, i + columns);
        out.push(...zipN(slice, gap, out.length).map((l) => indent + l));
      }
    }

    // Dormant strip — one line each, or collapsed count
    if (dormant.length) {
      out.push("");
      if (showDormant) {
        out.push(`  ${DIM}sidelined${RESET}`);
        for (const { p, i } of dormant) {
          out.push(
            `  ${dormantChip(p, cols - 4, focusIdx === i)}`,
          );
        }
      } else {
        out.push(
          `  ${DIM}sidelined  ${dormant.length}  ·  press ${RESET}${CYAN}h${RESET}${DIM} to show${RESET}`,
        );
      }
    }

    out.push("");
    out.push(focusStrip(providers[focusIdx], cols));
    if (opts.loading) out.push(`  ${DIM}refreshing…${RESET}`);
    if (opts.toast) out.push(`  ${GREEN}${opts.toast}${RESET}`);
  }

  // Footer
  const n = providers.length;
  const focusHint = n <= 9 ? `1–${n}` : "1–9";
  const footer =
    `${FOOTER_BG}${DIM} ${focusHint}/tab/j/k  ·  c ref  ·  h sidelined  ·  r refresh  ·  q  ·  ${Math.round(REFRESH_MS / 1000)}s ${RESET}`;
  while (out.length < rows - 1) out.push("");
  out[rows - 1] = footer;

  const painted: string[] = [];
  for (let r = 0; r < rows; r++) {
    painted.push(paintLine(out[r] ?? "", cols, r));
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
  let showDormant = false;

  const showToast = (msg: string): void => {
    toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
      redraw();
    }, 2200);
    redraw();
  };

  const clampFocus = (): void => {
    const n = report?.providers.length ?? 0;
    if (!n) {
      focus = 0;
      return;
    }
    focus = ((focus % n) + n) % n;
  };

  const redraw = (): void => {
    if (closed) return;
    clampFocus();
    writeScreen(
      frame(report, {
        loading,
        error: error || undefined,
        lastRefresh: report?.checkedAt
          ? new Date(report.checkedAt).toLocaleTimeString()
          : undefined,
        focus,
        toast: toast || undefined,
        showDormant,
      }),
    );
  };

  const load = async (force = false): Promise<void> => {
    loading = true;
    error = null;
    redraw();
    try {
      report = await collectAll({ refresh: force || opts.refresh });
      // Prefer focusing the pick / first ready fighter
      if (report.pick.id) {
        const idx = report.providers.findIndex(
          (p) => p.id === report!.pick.id && p.auth === "ok" && (p.score == null || p.score < 95),
        );
        if (idx >= 0) focus = idx;
      }
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
    if (key === "h" || key === "H") {
      showDormant = !showDormant;
      redraw();
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
    // j / down / tab → next
    if (key === "j" || key === "\t" || key === `${ESC}[B`) {
      if (report?.providers.length) {
        focus = (focus + 1) % report.providers.length;
        redraw();
      }
      return;
    }
    // k / up → prev
    if (key === "k" || key === `${ESC}[A`) {
      if (report?.providers.length) {
        focus = (focus - 1 + report.providers.length) % report.providers.length;
        redraw();
      }
      return;
    }
    if (key === "c" || key === "C") {
      const p: ProviderSnapshot | undefined = report?.providers[focus];
      const payload = p?.referral?.link || p?.referral?.label || p?.referral?.code;
      if (!payload) {
        showToast("no referral on this fighter");
        return;
      }
      if (copyToClipboard(payload)) {
        showToast(`copied ${p!.displayName} ref`);
      } else {
        showToast(payload.slice(0, 60));
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
