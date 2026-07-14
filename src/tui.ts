import { collectAll } from "./collect.js";
import { copyToClipboard } from "./clipboard.js";
import type { Meter, ProviderSnapshot, RosterReport } from "./types.js";

/**
 * Arena TUI — widget-dashboard layout inspired by btop / token-burn,
 * with aiquota-style pace markers and Ink-style sparklines.
 * Vertical budget fills the terminal; cards expand to claim free rows.
 */

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

const BG = `${ESC}[48;5;233m`;
const BG_PANEL = `${ESC}[48;5;235m`;
const BG_HERO = `${ESC}[48;5;236m`;
const FG_GRIT = `${ESC}[38;5;236m`;
const FG_MUTE = `${ESC}[38;5;240m`;
const FG_SOFT = `${ESC}[38;5;245m`;
const FOOTER_BG = `${ESC}[48;5;235m`;

const REFRESH_MS = 45_000;
const TICK_MS = 900;
const CARD_MIN_INNER = 28;
const CARD_MIN_BODY = 5;
const GAP = 2;
const MARGIN = 1;
const SPARK = "▁▂▃▄▅▆▇█";

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
  if (len > width) return stripAnsi(s).slice(0, Math.max(0, width - 1)) + "…";
  if (len === width) return s;
  return s + texturedPad(row, startCol + len, width - len);
}

function paintLine(content: string, cols: number, row: number): string {
  return `${BG}${padVisible(`${BG}${content}`, cols, row, 0)}${RESET}`;
}

function padPlain(s: string, width: number): string {
  const len = vlen(s);
  if (len >= width) return stripAnsi(s).slice(0, Math.max(0, width - 1)) + "…";
  return s + " ".repeat(width - len);
}

/** aiquota-style bar with optional pace marker (│ = time elapsed in window). */
function pacedBar(used: number | null, width: number, paceFrac: number | null): string {
  if (used == null) return `${FG_MUTE}${"┈".repeat(width)}${RESET}`;
  const pct = Math.max(0, Math.min(100, used));
  const filled = Math.round((pct / 100) * width);
  const paceCol =
    paceFrac != null && Number.isFinite(paceFrac)
      ? Math.max(0, Math.min(width - 1, Math.round(paceFrac * (width - 1))))
      : -1;

  let body = "";
  for (let i = 0; i < width; i++) {
    if (i === paceCol) body += `${WHITE}│${RESET}${levelColor(level(used))}`;
    else body += i < filled ? "█" : "░";
  }
  return `${levelColor(level(used))}${body}${RESET}`;
}

function paceFraction(m: Meter): number | null {
  if (m.windowSeconds == null || m.windowSeconds <= 0 || !m.resetsAt) return null;
  const reset = Date.parse(m.resetsAt);
  if (Number.isNaN(reset)) return null;
  const remainingSec = Math.max(0, (reset - Date.now()) / 1000);
  const elapsed = Math.max(0, m.windowSeconds - remainingSec);
  return Math.min(1, elapsed / m.windowSeconds);
}

/** Deterministic sparkline (InkUI / ink-hud vibe) from usage + seed. */
function sparkline(seed: string, used: number | null, width: number): string {
  const w = Math.max(8, width);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const peak = used == null ? 0.45 : Math.max(0.08, Math.min(1, used / 100));
  let out = "";
  for (let i = 0; i < w; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const wave = 0.55 + 0.45 * Math.sin(i * 0.55 + (h % 100) / 40);
    const v = Math.max(0, Math.min(1, peak * wave * (0.7 + (h % 50) / 100)));
    out += SPARK[Math.min(SPARK.length - 1, Math.floor(v * (SPARK.length - 1)))]!;
  }
  return `${levelColor(level(used))}${out}${RESET}`;
}

interface StatusInfo {
  label: string;
  short: string;
  color: string;
  kind: "ready" | "warn" | "ko" | "auth" | "missing";
}

function statusInfo(p: ProviderSnapshot, tick: number): StatusInfo {
  if (!p.installed) return { label: "missing", short: "—", color: DIM, kind: "missing" };
  if (p.auth === "missing") return { label: "no login", short: "···", color: YELLOW, kind: "auth" };
  if (p.auth === "expired") return { label: "expired", short: "!", color: RED, kind: "auth" };
  if (p.auth === "error") return { label: "error", short: "!", color: RED, kind: "auth" };

  const pulse = ["●", "◉", "○", "◉"][tick % 4]!;
  if (p.score != null) {
    if (p.score >= 100) return { label: "ko", short: "✕", color: RED, kind: "ko" };
    if (p.score >= 90) return { label: "limping", short: "!", color: YELLOW, kind: "warn" };
    return { label: "ready", short: pulse, color: GREEN, kind: "ready" };
  }
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 100)) {
    return { label: "ko", short: "✕", color: RED, kind: "ko" };
  }
  if (p.windows.some((w) => (w.usedPercent ?? 0) >= 90)) {
    return { label: "limping", short: "!", color: YELLOW, kind: "warn" };
  }
  return { label: "ready", short: pulse, color: GREEN, kind: "ready" };
}

function isDormant(p: ProviderSnapshot): boolean {
  return !p.installed || p.auth === "missing";
}

function meterRow(m: Meter, contentWidth: number): string {
  const labelW = Math.min(8, Math.max(5, Math.floor(contentWidth * 0.12)));
  const rightW = 12;
  const barW = Math.max(12, contentWidth - labelW - rightW - 2);
  const label = m.label.slice(0, labelW).padEnd(labelW);

  if (m.usedPercent == null) {
    const detail = (m.detail || "—").slice(0, contentWidth - labelW - 2);
    return `${FG_SOFT}${label}${RESET} ${DIM}${detail}${RESET}`;
  }

  const pct = String(Math.round(m.usedPercent)).padStart(3);
  const reset = (m.availableIn || "").slice(0, 6).padStart(6);
  return `${FG_SOFT}${label}${RESET} ${pacedBar(m.usedPercent, barW, paceFraction(m))} ${levelColor(level(m.usedPercent))}${pct}%${RESET}${DIM}${reset ? ` ${reset}` : ""}${RESET}`;
}

function boxCard(
  title: string,
  body: string[],
  inner: number,
  bodyH: number,
  focused: boolean,
  accent: string,
): string[] {
  const focusGlyph = focused ? "◆" : " ";
  const titleText = `${focusGlyph} ${title}`.slice(0, Math.max(1, inner - 2));
  const dash = Math.max(0, inner - vlen(titleText) - 1);
  const top = `╭${titleText} ${"─".repeat(dash)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;

  const padded = [...body];
  while (padded.length < bodyH) padded.push("");
  const mid = padded.slice(0, bodyH).map((line) => `│ ${padPlain(line, inner - 2)} │`);

  return [top, ...mid, bottom].map((line, i) => {
    if (i === 0 || i === bodyH + 1) return `${accent}${line}${RESET}`;
    return `${BG_PANEL}${line}${RESET}`;
  });
}

function fighterCard(
  p: ProviderSnapshot,
  inner: number,
  bodyH: number,
  focused: boolean,
  tick: number,
): string[] {
  const st = statusInfo(p, tick);
  const accent = focused
    ? CYAN
    : st.kind === "ready"
      ? GREEN
      : st.kind === "warn"
        ? YELLOW
        : st.kind === "ko" || st.kind === "auth"
          ? RED
          : FG_MUTE;

  const contentW = inner - 2;
  const lines: string[] = [];

  const plan = (p.subscription || p.plan || "—")
    .replace(/^Claude\s+/i, "")
    .replace(/^Codex\s+/i, "")
    .replace(/^Cursor\s+/i, "")
    .replace(/^Grok\s+·\s+/i, "")
    .replace(/^Nous\s+/i, "Nous ");
  lines.push(
    `${st.color}${BOLD}${st.short}${RESET} ${st.color}${st.label}${RESET}  ${DIM}${plan.slice(0, Math.max(10, contentW - 12))}${RESET}`,
  );

  if (p.auth === "ok" && p.windows.length) {
    const meterBudget = Math.max(1, bodyH - 3); // leave room for spark + footer bits
    const show = p.windows.slice(0, Math.min(4, meterBudget));
    for (const m of show) lines.push(meterRow(m, contentW));

    const primary = show[0]!;
    if (bodyH >= lines.length + 2) {
      lines.push(`${DIM}trend${RESET} ${sparkline(p.displayName + primary.label, primary.usedPercent, Math.max(12, contentW - 7))}`);
    }
    if (bodyH >= lines.length + 2 && primary.detail) {
      lines.push(`${DIM}${primary.detail.slice(0, contentW)}${RESET}`);
    }
    if (focused && p.active && bodyH >= lines.length + 1) {
      lines.push(`${CYAN}★ active profile${RESET}`);
    }
    if (focused && p.hint && bodyH >= lines.length + 1) {
      lines.push(`${DIM}${p.hint.replace(/\s+/g, " ").slice(0, contentW)}${RESET}`);
    }
  } else if (p.auth !== "ok") {
    const hint = (p.hint || p.error || "sign in required").replace(/\s+/g, " ");
    lines.push(`${DIM}${hint.slice(0, contentW)}${RESET}`);
    if (bodyH >= 4) {
      lines.push("");
      lines.push(`${FG_MUTE}${sparkline(p.displayName, null, Math.max(12, contentW - 2))}${RESET}`);
    }
  } else {
    lines.push(`${DIM}no meters yet${RESET}`);
  }

  return boxCard(p.displayName, lines, inner, bodyH, focused, accent);
}

function dormantChip(p: ProviderSnapshot, width: number, focused: boolean, tick: number): string {
  const st = statusInfo(p, tick);
  const mark = focused ? `${CYAN}▸${RESET}` : `${DIM}·${RESET}`;
  return padPlain(
    `${mark} ${p.displayName}  ${st.color}${st.label}${RESET}  ${DIM}${(p.hint || "").slice(0, 36)}${RESET}`,
    width,
  );
}

interface Layout {
  cols: number;
  rows: number;
  columns: 1 | 2 | 3;
  inner: number;
  margin: number;
  gap: number;
  /** Lines inside each card (between borders) */
  bodyH: number;
  cardRows: number;
}

function computeLayout(fighterCount: number, chromeRows: number): Layout {
  const cols = Math.max(40, process.stdout.columns || 80);
  const rows = Math.max(16, process.stdout.rows || 24);
  const margin = MARGIN;
  const gap = GAP;

  let columns: 1 | 2 | 3 = 1;
  if (cols >= 140 && fighterCount >= 3) columns = 3;
  else if (cols >= 88 && fighterCount >= 2) columns = 2;
  else if (cols >= 72 && fighterCount >= 2) columns = 2;

  const usable = cols - margin * 2 - gap * (columns - 1);
  const cardOuter = Math.floor(usable / columns);
  const inner = Math.max(CARD_MIN_INNER, cardOuter - 2);

  const cardRows = Math.max(1, Math.ceil(Math.max(1, fighterCount) / columns));
  const gapsBetweenRows = Math.max(0, cardRows - 1);
  const available = Math.max(CARD_MIN_BODY + 2, rows - chromeRows - gapsBetweenRows);
  const cardH = Math.max(CARD_MIN_BODY + 2, Math.floor(available / cardRows));
  const bodyH = Math.max(CARD_MIN_BODY, cardH - 2);

  return { cols, rows, columns, inner, margin, gap, bodyH, cardRows };
}

function zipN(cards: string[][], gap: number, rowOffset: number): string[] {
  if (!cards.length) return [];
  const out: string[] = [];
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
    out.push(line);
  }
  return out;
}

function heroPick(report: RosterReport, cols: number, tick: number): string {
  const pick = report.pick.line.replace(/^→\s*/, "").replace(/\s*★/, "");
  const pulse = ["→", "▸", "→", "▹"][tick % 4]!;
  const inner = Math.max(20, cols - 4);
  const text = `${BOLD}${WHITE}${pulse}  ${pick}${RESET}`;
  return `${BG_HERO}  ${padPlain(text, inner)}${RESET}`;
}

function focusPanel(p: ProviderSnapshot | undefined, cols: number, lines: number): string[] {
  if (!p || lines <= 0) return Array.from({ length: Math.max(0, lines) }, () => "");
  const out: string[] = [];
  const st = statusInfo(p, 0);
  const head = [
    `${CYAN}${BOLD}${p.displayName}${RESET}`,
    `${st.color}${st.label}${RESET}`,
    p.subscription || p.plan || "",
  ]
    .filter(Boolean)
    .join(`${DIM}  ·  ${RESET}`);
  out.push(`  ${padPlain(head, cols - 4)}`);

  if (lines >= 2) {
    const bits: string[] = [];
    if (p.account) bits.push(p.account);
    if (p.score != null) bits.push(`${Math.round(p.score)}% used`);
    if (p.referral?.code) bits.push(`ref ${p.referral.code}  ·  c copy`);
    else if (p.referral?.label) bits.push("c · copy ref");
    out.push(`  ${DIM}${padPlain(bits.join("  ·  ") || "—", cols - 4)}${RESET}`);
  }
  if (lines >= 3 && p.hint) {
    out.push(`  ${DIM}${padPlain(p.hint.replace(/\s+/g, " "), cols - 4)}${RESET}`);
  }
  while (out.length < lines) out.push("");
  return out.slice(0, lines);
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
    tick?: number;
    nextRefreshIn?: number;
  },
): string {
  const tick = opts.tick ?? 0;
  const showDormant = Boolean(opts.showDormant);
  const providers = report?.providers ?? [];
  const focusIdx = opts.focus ?? 0;

  const indexed = providers.map((p, i) => ({ p, i }));
  const rank = (p: ProviderSnapshot): number => {
    const st = statusInfo(p, 0);
    if (st.kind === "ready") return 0;
    if (st.kind === "warn") return 1;
    if (st.kind === "ko") return 2;
    if (st.kind === "auth") return 3;
    return 4;
  };
  indexed.sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i);

  const fighters = indexed.filter((x) => !isDormant(x.p));
  const dormant = indexed.filter((x) => isDormant(x.p));

  const dormantLines = dormant.length ? (showDormant ? 1 + dormant.length : 1) : 0;
  // Fixed chrome — leftover rows go into card body height (fill the arena)
  const chrome =
    1 + // header
    1 + // blank
    1 + // hero
    1 + // blank after hero
    1 + // blank before focus
    2 + // focus panel
    dormantLines +
    (dormantLines ? 1 : 0) +
    1; // footer

  const layout = computeLayout(fighters.length || 1, chrome);
  const { cols, rows, columns, inner, margin, gap, bodyH } = layout;

  if (cols < 60 || rows < 18) {
    const msg = [
      ` ${BOLD}llmquota${RESET}`,
      "",
      ` ${YELLOW}terminal too small${RESET}`,
      ` ${DIM}need ≥ 60×18  ·  now ${cols}×${rows}${RESET}`,
      ` ${DIM}resize and the arena will fill the space${RESET}`,
    ];
    const painted: string[] = [];
    for (let r = 0; r < rows; r++) painted.push(paintLine(msg[r] ?? "", cols, r));
    return painted.join("\n");
  }

  const out: string[] = [];
  const indent = " ".repeat(margin);

  out.push(
    ` ${BOLD}${WHITE}llmquota${RESET}${FG_MUTE}  arena${RESET}` +
      `${DIM}  ${opts.lastRefresh || ""}${RESET}` +
      `${DIM}  ${cols}×${rows}${RESET}`,
  );

  if (opts.loading && !report) {
    out.push("");
    out.push(`  ${DIM}${["◐", "◓", "◑", "◒"][tick % 4]} reading quotas…${RESET}`);
  } else if (opts.error && !report) {
    out.push("");
    out.push(`  ${RED}${opts.error}${RESET}`);
  } else if (report) {
    out.push("");
    out.push(heroPick(report, cols, tick));
    out.push("");

    const cards = fighters.map(({ p, i }) =>
      fighterCard(p, inner, bodyH, focusIdx === i, tick),
    );

    if (cards.length) {
      for (let i = 0; i < cards.length; i += columns) {
        if (i > 0) out.push("");
        const slice = cards.slice(i, i + columns);
        out.push(...zipN(slice, gap, out.length).map((l) => indent + l));
      }
    }

    out.push("");
    if (dormant.length) {
      if (showDormant) {
        out.push(`  ${DIM}sidelined${RESET}`);
        for (const { p, i } of dormant) {
          out.push(`  ${dormantChip(p, cols - 4, focusIdx === i, tick)}`);
        }
      } else {
        out.push(
          `  ${DIM}sidelined ${dormant.length}  ·  ${RESET}${CYAN}h${RESET}${DIM} show${RESET}`,
        );
      }
      out.push("");
    }

    out.push(...focusPanel(providers[focusIdx], cols, 2));

    if (opts.loading) {
      out.push(`  ${DIM}${["◐", "◓", "◑", "◒"][tick % 4]} refreshing…${RESET}`);
    } else if (opts.toast) {
      out.push(`  ${GREEN}${opts.toast}${RESET}`);
    }
  }

  const n = providers.length;
  const focusHint = n <= 9 ? `1–${n}` : "1–9";
  const eta =
    opts.nextRefreshIn != null
      ? `${Math.max(0, Math.ceil(opts.nextRefreshIn / 1000))}s`
      : `${Math.round(REFRESH_MS / 1000)}s`;
  const footer =
    `${FOOTER_BG}${DIM} ${focusHint}/tab/j/k  ·  c ref  ·  h sidelined  ·  r  ·  q  ·  next ${eta}  ·  │=pace ${RESET}`;

  while (out.length < rows - 1) out.push("");
  out.length = rows - 1;
  out.push(footer);

  const painted: string[] = [];
  for (let r = 0; r < rows; r++) painted.push(paintLine(out[r] ?? "", cols, r));
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
  let refreshTimer: NodeJS.Timeout | null = null;
  let tickTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let focus = 0;
  let toast: string | null = null;
  let toastTimer: NodeJS.Timeout | null = null;
  let showDormant = false;
  let tick = 0;
  let lastFetchAt = Date.now();

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
    const nextRefreshIn = Math.max(0, REFRESH_MS - (Date.now() - lastFetchAt));
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
        tick,
        nextRefreshIn,
      }),
    );
  };

  const load = async (force = false): Promise<void> => {
    loading = true;
    error = null;
    redraw();
    try {
      report = await collectAll({ refresh: force || opts.refresh });
      lastFetchAt = Date.now();
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
    if (refreshTimer) clearInterval(refreshTimer);
    if (tickTimer) clearInterval(tickTimer);
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
    if (key === "?") {
      showToast("│ pace marker · spark = trend · h sidelined · j/k move");
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
    if (key === "j" || key === "\t" || key === `${ESC}[B`) {
      if (report?.providers.length) {
        focus = (focus + 1) % report.providers.length;
        redraw();
      }
      return;
    }
    if (key === "k" || key === `${ESC}[A`) {
      if (report?.providers.length) {
        focus = (focus - 1 + report.providers.length) % report.providers.length;
        redraw();
      }
      return;
    }
    if (key === "c" || key === "C") {
      const p = report?.providers[focus];
      const payload = p?.referral?.link || p?.referral?.label || p?.referral?.code;
      if (!payload) {
        showToast("no referral on this fighter");
        return;
      }
      if (copyToClipboard(payload)) showToast(`copied ${p!.displayName} ref`);
      else showToast(payload.slice(0, 60));
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

  refreshTimer = setInterval(() => {
    void load(false);
  }, REFRESH_MS);

  tickTimer = setInterval(() => {
    tick = (tick + 1) % 4;
    redraw();
  }, TICK_MS);

  await new Promise<void>(() => {
    /* resolved via process.exit */
  });
}
