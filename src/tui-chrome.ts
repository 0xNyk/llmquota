import type { ProviderSnapshot, RosterReport } from "./types.js";
import {
  BG_HERO,
  BG_PANEL,
  BG_SOON,
  BOLD,
  CYAN,
  DIM,
  FG_MUTE,
  GREEN,
  padPlain,
  RED,
  RESET,
  vlen,
  WHITE,
  YELLOW,
} from "./tui-ansi.js";
import { refPayload } from "./tui-cards.js";
import { busRead, formatBusLine } from "./bus.js";
import {
  availability,
  formatCompactDur,
  isDormant,
  isCooldown,
  soonestResetSec,
  type Avail,
} from "./tui-model.js";

export interface RefsStripResult {
  lines: string[];
  hits: { x0: number; x1: number; index: number }[];
}

export interface NextUpEntry {
  index: number;
  name: string;
  sec: number;
  avail: Avail;
  cooldown: boolean;
}

export function heroPick(report: RosterReport, cols: number, tick: number): string {
  const pick = report.pick.line.replace(/^→\s*/, "").replace(/\s*★/, "");
  const pulse = ["▶", "▷", "▶", "▹"][tick % 4]!;
  const readyN = report.providers.filter((p) => availability(p) === "ready").length;
  const left = `${GREEN}${BOLD}${pulse}${RESET} ${BOLD}${WHITE}${pick}${RESET}`;
  const right = readyN
    ? `${GREEN}${readyN} ready${RESET}`
    : `${DIM}none ready${RESET}`;
  const inner = Math.max(20, cols - 4);
  const gap = Math.max(2, inner - vlen(left) - vlen(right) - 2);
  const line =
    vlen(left) + vlen(right) + 4 < inner
      ? `${left}${" ".repeat(gap)}${right}`
      : `${left}${DIM}  ·  ${RESET}${right}`;
  return `${BG_HERO}  ${padPlain(line, inner)}${RESET}`;
}

/** Priority queue: next fighters that become usable again (soonest first). */
export function nextUpQueue(
  providers: ProviderSnapshot[],
  checkedAt?: string | null,
): NextUpEntry[] {
  const entries: NextUpEntry[] = [];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]!;
    if (isDormant(p)) continue;
    if (p.auth !== "ok") continue;
    const avail = availability(p);
    if (avail === "ready") continue;
    const sec = soonestResetSec(p, checkedAt);
    if (sec == null) continue;
    entries.push({ index: i, name: p.displayName, sec, avail, cooldown: isCooldown(p) });
  }
  entries.sort((a, b) => a.sec - b.sec || a.name.localeCompare(b.name));
  return entries;
}

export function nextUpStrip(
  providers: ProviderSnapshot[],
  cols: number,
  focusIdx: number,
  checkedAt?: string | null,
): { lines: string[]; hits: { x0: number; x1: number; index: number }[] } {
  const queue = nextUpQueue(providers, checkedAt);
  const inner = Math.max(20, cols - 4);
  const hits: { x0: number; x1: number; index: number }[] = [];

  // Quiet when nothing is waiting — cards already show ready state.
  if (!queue.length) return { lines: [], hits };

  const label = `${YELLOW}${BOLD}next ↑${RESET}`;
  const chips: { text: string; index: number; plainLen: number }[] = [];
  for (let n = 0; n < queue.length; n++) {
    const e = queue[n]!;
    const rank = `${n + 1}`;
    const clock = formatCompactDur(e.sec);
    const color = e.avail === "soon" ? YELLOW : e.avail === "limping" ? YELLOW : RED;
    const focused = e.index === focusIdx;
    const state = e.cooldown ? " cooldown" : "";
    const body = focused
      ? `${CYAN}${BOLD}[${rank}] ${e.name}${state} ${clock}${RESET}`
      : `${DIM}${rank}${RESET} ${color}${e.name}${state}${RESET} ${DIM}${clock}${RESET}`;
    chips.push({
      text: body,
      index: e.index,
      plainLen: vlen(`[${rank}] ${e.name}${state} ${clock}`),
    });
  }

  let used = vlen("next ↑  ");
  const parts: string[] = [`${label}  `];
  let x = 2 + vlen("next ↑  ");
  let shown = 0;
  for (const chip of chips) {
    const sep = shown ? 3 : 0;
    if (used + sep + chip.plainLen > inner - 4 && shown > 0) break;
    if (shown) {
      parts.push(`${DIM} · ${RESET}`);
      x += 3;
      used += 3;
    }
    hits.push({ x0: x, x1: x + chip.plainLen, index: chip.index });
    parts.push(chip.text);
    x += chip.plainLen;
    used += chip.plainLen;
    shown++;
  }
  const more = queue.length - shown;
  if (more > 0) parts.push(`${DIM} · +${more}${RESET}`);

  return {
    lines: [`${BG_SOON}  ${padPlain(parts.join(""), inner)}${RESET}`],
    hits,
  };
}

/** Top strip: all copyable refs at a glance. */
export function refsStrip(providers: ProviderSnapshot[], cols: number, focusIdx: number): RefsStripResult {
  const seen = new Set<string>();
  const hits: { x0: number; x1: number; index: number }[] = [];
  let cursor = 2;
  const parts: string[] = [];
  const label = `${DIM}refs${RESET} `;
  parts.push(label);
  cursor += vlen(label);

  let first = true;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]!;
    const payload = refPayload(p);
    if (!payload) continue;
    const key = `${p.id}:${p.referral?.code || payload}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = p.referral?.code?.trim();
    const short = (code || payload.replace(/^https?:\/\//, "")).slice(0, 18);
    const hi = i === focusIdx;
    const sep = first ? "" : " ";
    if (!first) cursor += vlen(sep);
    const bit = hi
      ? `${CYAN}[${BOLD}${p.id} ${short}${RESET}${CYAN}]${RESET}`
      : `${FG_MUTE}[${RESET}${DIM}${p.id}${RESET} ${CYAN}${short}${RESET}${FG_MUTE}]${RESET}`;
    const bitW = vlen(bit);
    hits.push({ x0: cursor, x1: cursor + bitW, index: i });
    parts.push(sep + bit);
    cursor += bitW;
    first = false;
  }
  if (first) return { lines: [], hits: [] };
  const line = `  ${parts.join("")}`;
  return {
    lines: [`${BG_PANEL}${padPlain(line, Math.max(20, cols - 2))}${RESET}`],
    hits,
  };
}

/** Compact bus strip for the arena (last few ring messages). */
export function busStripLines(cols: number, limit = 6): string[] {
  const msgs = busRead(limit);
  const inner = Math.max(20, cols - 4);
  if (!msgs.length) {
    return [
      `  ${DIM}bus${RESET}  ${FG_MUTE}empty · s shout · llmquota bus send -t all "…"${RESET}`,
    ];
  }
  const out: string[] = [];
  const recent = msgs.slice(-limit);
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i]!;
    const label = i === 0 ? `${CYAN}bus${RESET}` : `${DIM}   ${RESET}`;
    const body = formatBusLine(m);
    const room = Math.max(8, inner - 6);
    const shown = body.length > room ? `${body.slice(0, room - 1)}…` : body;
    out.push(`  ${label}  ${DIM}${shown}${RESET}`);
  }
  return out;
}
