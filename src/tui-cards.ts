import type { ProviderSnapshot } from "./types.js";
import {
  BG,
  BG_HERO,
  BG_HOVER,
  BG_COOLDOWN,
  BG_PANEL,
  BG_READY,
  BG_SOON,
  CYAN,
  DIM,
  FG_MUTE,
  padPlain,
  RED,
  RESET,
  vlen,
  WHITE,
  withBg,
  YELLOW,
  GREEN,
} from "./tui-ansi.js";
import {
  buildCardSlots,
  packCardSlots,
  refSlot,
  titleClock,
} from "./tui-card-body.js";
import {
  availability,
  CARD_MIN_BODY,
  CARD_MIN_INNER,
  GAP,
  isCooldown,
  MARGIN,
  statusInfo,
} from "./tui-model.js";

export interface Layout {
  cols: number;
  rows: number;
  columns: 1 | 2 | 3;
  inner: number;
  margin: number;
  gap: number;
  bodyH: number;
  cardRows: number;
}

/** Fit natural row heights into the visible card-body budget. */
export function allocateRowBodyHeights(desired: number[], budget: number): number[] {
  const heights = desired.map((h) => Math.max(CARD_MIN_BODY, Math.min(10, Math.floor(h))));
  const floor = CARD_MIN_BODY * heights.length;
  let excess = Math.max(0, heights.reduce((sum, h) => sum + h, 0) - Math.max(floor, budget));
  while (excess > 0) {
    let tallest = -1;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i]! > CARD_MIN_BODY && (tallest < 0 || heights[i]! > heights[tallest]!)) tallest = i;
    }
    if (tallest < 0) break;
    heights[tallest]!--;
    excess--;
  }
  return heights;
}

/** Center a short final row within the full grid instead of leaving a hard-right hole. */
export function partialRowOffset(itemCount: number, columns: number, cardW: number, gap: number): number {
  if (itemCount >= columns) return 0;
  return Math.floor(((columns - itemCount) * (cardW + gap)) / 2);
}

export function refPayload(p: ProviderSnapshot): string | null {
  const ref = p.referral;
  if (!ref) return null;
  return (ref.link || ref.label || ref.code || "").trim() || null;
}

/** Thin wrapper for chrome — prefers refSlot. */
export function refLine(p: ProviderSnapshot, contentWidth: number, focused: boolean): string | null {
  return refSlot(p, contentWidth, focused)?.line ?? null;
}

export { isSpendDetail, shortenHint } from "./tui-card-body.js";

export function boxCard(
  title: string,
  body: string[],
  inner: number,
  bodyH: number,
  focused: boolean,
  hovered: boolean,
  accent: string,
  panelBg: string,
  interactionGlyph = "",
): string[] {
  const focusGlyph = interactionGlyph || (focused ? "◆" : hovered ? "◇" : " ");
  const titleText = `${focusGlyph} ${title}`.slice(0, Math.max(1, inner - 2));
  const dash = Math.max(0, inner - vlen(titleText) - 1);
  const top = `╭${titleText} ${"─".repeat(dash)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;

  const padded = [...body];
  while (padded.length < bodyH) padded.push("");
  const mid = padded.slice(0, bodyH).map((line) => `│ ${padPlain(line, inner - 2)} │`);

  return [top, ...mid, bottom].map((line, i) => {
    if (i === 0 || i === bodyH + 1) return `${accent}${withBg(accent, line)}${RESET}`;
    return `${panelBg}${withBg(panelBg, line)}${RESET}`;
  });
}

function cardChrome(avail: ReturnType<typeof availability>, cooldown: boolean, focused: boolean, hovered: boolean, interacting = false, interactionBright = false) {
  const accent = interacting
    ? interactionBright ? WHITE : CYAN
    : focused
    ? CYAN
    : hovered
      ? WHITE
      : avail === "ready"
        ? GREEN
        : avail === "soon" || avail === "limping"
          ? YELLOW
          : avail === "tired" || avail === "auth"
            ? RED
            : FG_MUTE;

  const panelBg = interacting
    ? interactionBright ? BG_HOVER : BG_HERO
    : focused
    ? BG_HERO
    : hovered
      ? BG_HOVER
      : cooldown
        ? BG_COOLDOWN
      : avail === "ready"
        ? BG_READY
        : avail === "soon"
          ? BG_SOON
          : BG_PANEL;

  return { accent, panelBg };
}

/**
 * Fighter card — modular slots packed by density.
 * Clock once (title if waiting, footer if ready). Meters = wave + % only.
 */
export function fighterCard(
  p: ProviderSnapshot,
  inner: number,
  bodyH: number,
  focused: boolean,
  hovered: boolean,
  tick: number,
  checkedAt?: string | null,
  interacting = false,
  reducedMotion = false,
): { lines: string[]; refBodyRow: number | null } {
  const contentW = inner - 2;
  const { avail, title } = titleClock(p, checkedAt);
  const interactionBright = !reducedMotion && tick % 2 === 0;
  const { accent, panelBg } = cardChrome(avail, isCooldown(p), focused, hovered, interacting, interactionBright);

  const slots = buildCardSlots(p, contentW, bodyH, focused, tick, checkedAt);
  const packed = packCardSlots(slots, bodyH);

  return {
    lines: boxCard(
      title,
      packed.lines,
      inner,
      bodyH,
      focused,
      hovered,
      accent,
      panelBg,
      interacting ? (reducedMotion ? "↔" : interactionBright ? "◆" : "◇") : "",
    ),
    refBodyRow: packed.refBodyRow,
  };
}

export function dormantChip(p: ProviderSnapshot, width: number, focused: boolean, tick: number): string {
  const st = statusInfo(p, tick);
  const mark = focused ? `${CYAN}▸${RESET}` : `${DIM}·${RESET}`;
  const refBit = p.referral?.code ? `  ${CYAN}ref ${p.referral.code}${RESET}` : "";
  return padPlain(
    `${mark} ${p.displayName}  ${st.color}${st.label}${RESET}${refBit}  ${DIM}${(p.hint || "").slice(0, 28)}${RESET}`,
    width,
  );
}

export function computeLayout(fighterCount: number, chromeRows: number): Layout {
  const cols = Math.max(40, process.stdout.columns || 80);
  const rows = Math.max(16, process.stdout.rows || 24);
  const margin = MARGIN;
  const gap = GAP;

  let columns: 1 | 2 | 3 = 1;
  if (cols >= 110 && fighterCount >= 3) columns = 3;
  else if (cols >= 72 && fighterCount >= 2) columns = 2;

  const usable = cols - margin * 2 - gap * (columns - 1);
  const cardOuter = Math.floor(usable / columns);
  const inner = Math.max(CARD_MIN_INNER, cardOuter - 2);

  const cardRows = Math.max(1, Math.ceil(Math.max(1, fighterCount) / columns));
  const gapsBetweenRows = rows - chromeRows < cardRows * (CARD_MIN_BODY + 4) ? 0 : Math.max(0, cardRows - 1);
  const available = Math.max(CARD_MIN_BODY + 2, rows - chromeRows - gapsBetweenRows);
  const cardH = Math.max(CARD_MIN_BODY + 2, Math.floor(available / cardRows));
  const bodyH = Math.max(CARD_MIN_BODY, cardH - 2);

  return { cols, rows, columns, inner, margin, gap, bodyH, cardRows };
}

export function zipN(cards: string[][], gap: number, _rowOffset: number): string[] {
  if (!cards.length) return [];
  const out: string[] = [];
  const height = Math.max(...cards.map((c) => c.length));
  const widths = cards.map((c) => (c[0] ? vlen(c[0]) : 0));
  const gapStr = `${BG}${" ".repeat(gap)}${RESET}`;

  for (let r = 0; r < height; r++) {
    let line = "";
    for (let i = 0; i < cards.length; i++) {
      if (i > 0) line += gapStr;
      const cell = cards[i]![r];
      if (cell) line += cell;
      else line += `${BG}${" ".repeat(widths[i] || 0)}${RESET}`;
    }
    out.push(line);
  }
  return out;
}
