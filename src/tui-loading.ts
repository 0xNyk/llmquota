import type { DetectedCli } from "./providers/detect.js";
import {
  BG,
  BG_HERO,
  BOLD,
  CYAN,
  DIM,
  FG_GRIT,
  FG_MUTE,
  GREEN,
  padPlain,
  RED,
  RESET,
  smokeAt,
  vlen,
  WHITE,
  YELLOW,
} from "./tui-ansi.js";

export interface LoadProgress {
  scanned: DetectedCli[];
  pending: Set<string>;
  done: Set<string>;
  errors: Map<string, string>;
  startedAt: number;
  soft: boolean;
}

const METERED_IDS = ["claude", "codex", "cursor", "grok", "hermes"] as const;

export function spinnerGlyph(tick: number): string {
  return ["◐", "◓", "◑", "◒"][tick % 4]!;
}

export function progressBar(done: number, total: number, width: number, tick: number): string {
  const t = Math.max(1, total);
  const filled = Math.max(0, Math.min(width, Math.round((done / t) * width)));
  const pulse = done < t ? `${YELLOW}${tick % 2 === 0 ? "◆" : "◇"}${RESET}` : "";
  const complete = filled > 0 ? `${GREEN}${"━".repeat(filled)}${RESET}` : "";
  const rest = Math.max(0, width - filled - (done < t ? 1 : 0));
  return complete + pulse + (rest ? `${FG_MUTE}${"─".repeat(rest)}${RESET}` : "");
}

function activeProbeLabel(progress: LoadProgress): string {
  const pending = METERED_IDS.filter((id) => progress.pending.has(id) && !progress.done.has(id));
  if (pending.length > 1) return `${pending.length} checking`;
  for (const id of METERED_IDS) {
    if (progress.errors.has(id)) continue;
    if (progress.done.has(id)) continue;
    if (progress.pending.has(id)) {
      const name = progress.scanned.find((c) => c.id === id)?.displayName || id;
      return name;
    }
  }
  if (progress.done.size >= METERED_IDS.length) return "ready";
  return "scanning";
}

function probeLamps(progress: LoadProgress, tick: number): string {
  const bits: string[] = [];
  for (const id of METERED_IDS) {
    const short = id.slice(0, 2);
    if (progress.errors.has(id)) bits.push(`${RED}✕${short}${RESET}`);
    else if (progress.done.has(id)) bits.push(`${GREEN}●${short}${RESET}`);
    else if (progress.pending.has(id)) {
      const pulse = tick % 2 === 0 ? "◉" : "○";
      bits.push(`${YELLOW}${pulse}${short}${RESET}`);
    } else bits.push(`${DIM}·${short}${RESET}`);
  }
  return bits.join(" ");
}

function probeRows(progress: LoadProgress, tick: number): string[] {
  return METERED_IDS.map((id) => {
    const name = progress.scanned.find((c) => c.id === id)?.displayName || id[0]!.toUpperCase() + id.slice(1);
    if (progress.errors.has(id)) return `${RED}×${RESET} ${WHITE}${name.padEnd(8)}${RESET} ${DIM}probe failed${RESET}`;
    if (progress.done.has(id)) return `${GREEN}●${RESET} ${WHITE}${name.padEnd(8)}${RESET} ${GREEN}ready${RESET}`;
    const pulse = tick % 2 === 0 ? "◆" : "◇";
    return `${YELLOW}${pulse}${RESET} ${WHITE}${name.padEnd(8)}${RESET} ${DIM}checking${RESET}`;
  });
}

/** One row: smoke gutters + centered content (single center pass). */
function rowWithSmoke(
  content: string,
  row: number,
  cols: number,
  rows: number,
  tick: number,
): string {
  const len = vlen(content);
  if (len <= 0) {
    let smoke = `${BG}${FG_GRIT}`;
    for (let c = 0; c < cols; c++) {
      smoke += smokeAt(row, c, { tick, cols, rows, dense: true });
    }
    return `${smoke}${RESET}`;
  }

  const left = Math.max(0, Math.floor((cols - len) / 2));
  const rightStart = left + len;
  let line = `${BG}${FG_GRIT}`;
  for (let c = 0; c < left; c++) {
    line += smokeAt(row, c, { tick, cols, rows, dense: true });
  }
  line += `${RESET}${content}${BG}${FG_GRIT}`;
  for (let c = rightStart; c < cols; c++) {
    line += smokeAt(row, c, { tick, cols, rows, dense: true });
  }
  return `${line}${RESET}`;
}

/** Centered cold boot with one explicit state row per quota source. */
export function loadingScreen(
  cols: number,
  rows: number,
  progress: LoadProgress,
  tick: number,
  error?: string,
): string {
  const total = METERED_IDS.length;
  const doneN = METERED_IDS.filter(
    (id) => progress.done.has(id) || progress.errors.has(id),
  ).length;
  const spin = spinnerGlyph(tick);
  const elapsed = ((Date.now() - progress.startedAt) / 1000).toFixed(1);
  const probe = activeProbeLabel(progress);

  const barW = Math.min(34, Math.max(16, cols - 28));

  const block: string[] = [
    `${BOLD}${WHITE}llmquota${RESET}${FG_MUTE} arena${RESET}`,
    "",
    `${YELLOW}${spin}${RESET} ${DIM}checking quota sources${RESET}`,
    "",
    ...probeRows(progress, tick),
    "",
    `${progressBar(doneN, total, barW, tick)}  ${DIM}${doneN}/${total}${RESET}`,
    `${DIM}${probe}${RESET}  ${FG_MUTE}${elapsed}s${RESET}`,
  ];

  if (error) {
    block.push("");
    block.push(`${RED}⚠ ${error.slice(0, Math.max(20, cols - 8))}${RESET}`);
  } else {
    block.push("");
    block.push(`${DIM}q quit${RESET}`);
  }

  const topPad = Math.max(0, Math.floor((rows - block.length) / 2));
  const painted: string[] = [];

  for (let r = 0; r < rows; r++) {
    const bi = r - topPad;
    const content = bi >= 0 && bi < block.length ? block[bi]! : "";
    painted.push(rowWithSmoke(content, r, cols, rows, tick));
  }

  return painted.join("\n");
}

export function softRefreshBanner(progress: LoadProgress, cols: number, tick: number): string {
  const total = METERED_IDS.length;
  const doneN = METERED_IDS.filter(
    (id) => progress.done.has(id) || progress.errors.has(id),
  ).length;
  const spin = spinnerGlyph(tick);
  const bar = progressBar(doneN, total, Math.min(20, Math.max(10, cols - 42)), tick);
  const lamps = probeLamps(progress, tick);
  const line = `${YELLOW}${spin}${RESET} ${DIM}refresh${RESET}  ${bar}  ${DIM}${doneN}/${total}${RESET}  ${lamps}`;
  return `${BG_HERO}  ${padPlain(line, Math.max(20, cols - 4))}${RESET}`;
}
