export const ESC = "\x1b";
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;
export const RED = `${ESC}[31m`;
export const GREEN = `${ESC}[32m`;
export const YELLOW = `${ESC}[33m`;
export const BLUE = `${ESC}[34m`;
export const CYAN = `${ESC}[36m`;
export const WHITE = `${ESC}[37m`;

export const BG = `${ESC}[48;5;233m`;
export const BG_PANEL = `${ESC}[48;5;235m`;
export const BG_HERO = `${ESC}[48;5;236m`;
export const BG_READY = `${ESC}[48;5;236m`;
export const BG_SOON = `${ESC}[48;5;237m`;
export const BG_HOVER = `${ESC}[48;5;238m`;
export const FG_GRIT = `${ESC}[38;5;236m`;
export const FG_MUTE = `${ESC}[38;5;240m`;
export const FG_SOFT = `${ESC}[38;5;245m`;
export const FOOTER_BG = `${ESC}[48;5;235m`;

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

/** OSC 8 hyperlink — Cmd/Ctrl-click in iTerm/Kitty/Ghostty/etc. */
export function osc8(url: string, label: string): string {
  let href = url.trim();
  if (!href) return label;
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  return `${ESC}]8;;${href}${ESC}\\${label}${ESC}]8;;${ESC}\\`;
}

export function vlen(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Sparse smoke glyph — denser near edges, quieter in the middle.
 * Shared by loading screen + arena padding.
 */
export function smokeAt(
  row: number,
  col: number,
  opts: { tick?: number; cols?: number; rows?: number; dense?: boolean } = {},
): string {
  const tick = opts.tick ?? 0;
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const edgeX = Math.min(col, Math.max(0, cols - 1 - col)) / Math.max(1, cols / 2);
  const edgeY = Math.min(row, Math.max(0, rows - 1 - row)) / Math.max(1, rows / 2);
  const edge = Math.min(edgeX, edgeY);
  const drift = tick * 2;
  const n =
    (row * 131 + col * 47 + drift + ((row ^ col) * 13) + Math.floor(col * 0.7 + row * 0.3)) & 255;

  // Higher threshold = fewer glyphs. Edge (rim) smokes more.
  const base = opts.dense ? 28 : 14;
  const threshold = base + Math.floor(edge * (opts.dense ? 70 : 100));
  if (n > threshold) return " ";

  const kind = n % 7;
  if (kind === 0) return "░";
  if (kind === 1 || kind === 2) return "‧";
  if (kind === 3) return "·";
  if (kind === 4) return "˚";
  if (kind === 5) return "°";
  return "·";
}

function texturedPad(
  row: number,
  startCol: number,
  width: number,
  tick: number,
  cols: number,
  rows: number,
): string {
  if (width <= 0) return "";
  let out = `${BG}${FG_GRIT}`;
  for (let i = 0; i < width; i++) {
    out += smokeAt(row, startCol + i, { tick, cols, rows });
  }
  return `${out}${RESET}`;
}

export function padVisible(
  s: string,
  width: number,
  row: number,
  startCol: number,
  tick = 0,
  cols = width,
  rows = 40,
): string {
  const len = vlen(s);
  if (len > width) return stripAnsi(s).slice(0, Math.max(0, width - 1)) + "…";
  if (len === width) return s;
  return s + texturedPad(row, startCol + len, width - len, tick, cols, rows);
}

/** Paint one arena/loading row; trailing space becomes subtle smoke. */
export function paintLine(
  content: string,
  cols: number,
  row: number,
  tick = 0,
  rows = 40,
): string {
  const len = vlen(content);
  const body = withBg(BG, content);
  if (len >= cols) {
    return `${BG}${truncateVisible(body, cols)}${RESET}`;
  }
  const isBox = /[╭╰│]/.test(stripAnsi(content));
  if (isBox) {
    // Card rows: solid pad (no smoke inside the grid gutters of the box line itself)
    return `${BG}${body}${" ".repeat(cols - len)}${RESET}`;
  }
  if (len === 0) {
    let smoke = `${BG}${FG_GRIT}`;
    for (let c = 0; c < cols; c++) smoke += smokeAt(row, c, { tick, cols, rows });
    return `${smoke}${RESET}`;
  }
  return `${BG}${padVisible(`${BG}${body}`, cols, row, 0, tick, cols, rows)}${RESET}`;
}

export function padPlain(s: string, width: number): string {
  const len = vlen(s);
  if (len >= width) return truncateVisible(s, Math.max(0, width - 1)) + "…";
  return s + " ".repeat(width - len);
}

/** Re-apply background after every SGR reset so card panels don't leak grit. */
export function withBg(bg: string, s: string): string {
  if (!bg) return s;
  return s.replaceAll(RESET, `${RESET}${bg}`);
}

export function truncateVisible(s: string, width: number): string {
  if (width <= 0) return "";
  if (vlen(s) <= width) return s;
  let out = "";
  let n = 0;
  const re = /(\x1b\[[0-9;]*m)|./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) {
      out += m[1];
      continue;
    }
    if (n >= width) break;
    out += m[0];
    n++;
  }
  return out + RESET;
}
