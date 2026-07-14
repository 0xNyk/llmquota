import type { HitAction, HitRegion } from "./tui-mouse.js";
import type { ProviderSnapshot, RosterReport } from "./types.js";
import {
  BOLD,
  BG_HERO,
  CYAN,
  DIM,
  FG_MUTE,
  FOOTER_BG,
  GREEN,
  padPlain,
  paintLine,
  RED,
  RESET,
  vlen,
  WHITE,
  YELLOW,
} from "./tui-ansi.js";
import {
  computeLayout,
  dormantChip,
  fighterCard,
  refPayload,
  zipN,
} from "./tui-cards.js";
import { heroPick, nextUpQueue, nextUpStrip, refsStrip, busStripLines } from "./tui-chrome.js";
import { type LoadProgress, loadingScreen, softRefreshBanner, spinnerGlyph } from "./tui-loading.js";
import {
  availability,
  CARD_MIN_BODY,
  isDormant,
  REFRESH_MS,
  soonestResetSec,
} from "./tui-model.js";

export interface FrameResult {
  screen: string;
  hits: HitRegion[];
}

export function frame(
  report: RosterReport | null,
  opts: {
    loading?: boolean;
    loadProgress?: LoadProgress | null;
    error?: string;
    lastRefresh?: string;
    focus?: number;
    hover?: number | null;
    hoverKind?: "focus" | "copy" | null;
    toast?: string;
    showDormant?: boolean;
    showHelp?: boolean;
    showBus?: boolean;
    shoutDraft?: string | null;
    tick?: number;
    nextRefreshIn?: number;
  },
): FrameResult {
  const tick = opts.tick ?? 0;
  const showDormant = Boolean(opts.showDormant);
  const showHelp = Boolean(opts.showHelp);
  const showBus = Boolean(opts.showBus);
  const shoutDraft = opts.shoutDraft ?? null;
  const providers = report?.providers ?? [];
  const focusIdx = opts.focus ?? 0;
  const hoverIdx = opts.hover ?? null;
  const hoverKind = opts.hoverKind ?? null;
  const hits: HitRegion[] = [];
  const termCols = Math.max(40, process.stdout.columns || 80);
  const termRows = Math.max(16, process.stdout.rows || 24);

  if (opts.loading && !report && opts.loadProgress) {
    return {
      screen: loadingScreen(termCols, termRows, opts.loadProgress, tick, opts.error),
      hits: [],
    };
  }
  if (!report && opts.error) {
    const msg = [
      ` ${BOLD}llmquota${RESET}`,
      "",
      ` ${RED}failed to read quotas${RESET}`,
      ` ${DIM}${opts.error}${RESET}`,
      "",
      ` ${DIM}press r to retry · q to quit${RESET}`,
    ];
    const painted: string[] = [];
    for (let r = 0; r < termRows; r++) painted.push(paintLine(msg[r] ?? "", termCols, r, tick, termRows));
    return { screen: painted.join("\n"), hits: [] };
  }

  const indexed = providers.map((p, i) => ({ p, i }));
  const rank = (p: ProviderSnapshot): number => {
    const a = availability(p);
    if (a === "ready") return 0;
    if (a === "soon") return 1;
    if (a === "limping") return 2;
    if (a === "tired") return 3;
    if (a === "unknown") return 4;
    if (a === "auth") return 5;
    return 6;
  };
  indexed.sort((a, b) => {
    const rd = rank(a.p) - rank(b.p);
    if (rd) return rd;
    if (availability(a.p) === "soon") {
      return (soonestResetSec(a.p) ?? 1e12) - (soonestResetSec(b.p) ?? 1e12);
    }
    return a.i - b.i;
  });

  const fighters = indexed.filter((x) => !isDormant(x.p));
  const dormant = indexed.filter((x) => isDormant(x.p));

  const dormantLines = dormant.length ? (showDormant ? 1 + dormant.length : 1) : 0;
  const refLines = report
    ? Math.min(1, providers.some((p) => refPayload(p)) ? 1 : 0)
    : 0;
  const nextUpLines =
    report && nextUpQueue(providers, report.checkedAt).length > 0 ? 1 : 0;
  const softRefreshLines = report && opts.loading && opts.loadProgress?.soft ? 1 : 0;
  const busLines = showBus || shoutDraft != null ? (shoutDraft != null ? 1 : 6) : 0;
  // header + soft? + hero + next? + refs? + blank + bus? + dormant? + footer
  const chrome =
    1 + softRefreshLines + 1 + nextUpLines + refLines + 1 + busLines + dormantLines + 1;

  const layout = computeLayout(fighters.length || 1, chrome);
  const { cols, rows, columns, inner, margin, gap, bodyH } = layout;
  const cardW = inner + 2;

  if (cols < 60 || rows < 18) {
    const msg = [
      ` ${BOLD}llmquota${RESET}`,
      "",
      ` ${YELLOW}terminal too small${RESET}`,
      ` ${DIM}need ≥ 60×18  ·  now ${cols}×${rows}${RESET}`,
      ` ${DIM}resize and the arena will fill the space${RESET}`,
    ];
    const painted: string[] = [];
    for (let r = 0; r < rows; r++) painted.push(paintLine(msg[r] ?? "", cols, r, tick, rows));
    return { screen: painted.join("\n"), hits };
  }

  const out: string[] = [];
  const indent = " ".repeat(margin);

  const readyN = report ? report.providers.filter((p) => availability(p) === "ready").length : 0;
  const soonN = report ? report.providers.filter((p) => availability(p) === "soon").length : 0;
  const koN = report
    ? report.providers.filter((p) => {
        const a = availability(p);
        return a === "tired" || a === "limping";
      }).length
    : 0;
  const tally =
    report
      ? `${GREEN}${readyN}▮${RESET}${DIM}/${RESET}${YELLOW}${soonN}◐${RESET}${DIM}/${RESET}${RED}${koN}✕${RESET}`
      : "";
  out.push(
    ` ${BOLD}${WHITE}llmquota${RESET}${FG_MUTE} arena${RESET}` +
      (tally ? `  ${tally}` : "") +
      (opts.loading && opts.loadProgress?.soft
        ? `  ${YELLOW}${spinnerGlyph(tick)}${RESET}${DIM} refresh${RESET}`
        : "") +
      `${DIM}  ${opts.lastRefresh || ""}${RESET}`,
  );

  if (report) {
    if (opts.loading && opts.loadProgress?.soft) {
      out.push(softRefreshBanner(opts.loadProgress, cols, tick));
    }
    out.push(heroPick(report, cols, tick));

    const next = nextUpStrip(providers, cols, focusIdx, report.checkedAt);
    const nextRow = out.length;
    out.push(...next.lines);
    for (const h of next.hits) {
      hits.push({
        x0: h.x0,
        x1: h.x1,
        y0: nextRow,
        y1: nextRow + 1,
        action: { kind: "focus", index: h.index },
      });
    }

    const strip = refsStrip(providers, cols, focusIdx);
    const stripRow = out.length;
    out.push(...strip.lines);
    for (const h of strip.hits) {
      hits.push({
        x0: h.x0,
        x1: h.x1,
        y0: stripRow,
        y1: stripRow + 1,
        action: { kind: "copy", index: h.index },
      });
    }
    out.push("");

    if (shoutDraft != null) {
      out.push(
        `  ${YELLOW}shout ›${RESET} ${WHITE}${shoutDraft}${RESET}${DIM}█${RESET}  ${FG_MUTE}↵ send · esc cancel${RESET}`,
      );
    } else if (showBus) {
      const lines = busStripLines(cols, 6);
      while (lines.length < 6) lines.push("");
      out.push(...lines);
    }

    const built = fighters.map(({ p, i }) => ({
      ...fighterCard(
        p,
        inner,
        bodyH,
        focusIdx === i,
        hoverIdx === i,
        tick,
        report.checkedAt,
      ),
      index: i,
    }));

    const rowGap =
      layout.cardRows > 1 &&
      rows - (1 + softRefreshLines + 1 + nextUpLines + refLines + 1 + dormantLines + 1) >=
        layout.cardRows * (CARD_MIN_BODY + 4);

    if (built.length) {
      for (let i = 0; i < built.length; i += columns) {
        if (i > 0 && rowGap) out.push("");
        const slice = built.slice(i, i + columns);
        const cardTop = out.length;
        const lineCards: string[][] = slice.map((c) => c.lines);
        out.push(...zipN(lineCards, gap, out.length).map((l) => indent + l));

        for (let c = 0; c < slice.length; c++) {
          const card = slice[c]!;
          const x0 = margin + c * (cardW + gap);
          const x1 = x0 + cardW;
          const y0 = cardTop;
          const y1 = cardTop + bodyH + 2;
          hits.push({
            x0,
            x1,
            y0,
            y1,
            action: { kind: "focus", index: card.index },
          });
          if (card.refBodyRow != null) {
            const ry = cardTop + 1 + card.refBodyRow;
            hits.push({
              x0,
              x1,
              y0: ry,
              y1: ry + 1,
              action: { kind: "copy", index: card.index },
            });
          }
        }
      }
    }

    if (dormant.length) {
      if (showDormant) {
        out.push(`  ${DIM}sidelined${RESET}`);
        for (const { p, i } of dormant) {
          const y = out.length;
          out.push(`  ${dormantChip(p, cols - 4, focusIdx === i, tick)}`);
          hits.push({
            x0: 2,
            x1: cols - 2,
            y0: y,
            y1: y + 1,
            action: { kind: "focus", index: i },
          });
        }
      } else {
        const y = out.length;
        out.push(
          `  ${FG_MUTE}[${RESET}${DIM}sidelined ${dormant.length}${RESET}${FG_MUTE}]${RESET}  ${CYAN}h${RESET}${DIM} expand${RESET}`,
        );
        hits.push({
          x0: 2,
          x1: cols - 2,
          y0: y,
          y1: y + 1,
          action: { kind: "dormant" },
        });
      }
    }

    if (opts.loading && opts.loadProgress?.soft) {
      // soft refresh already shown under header
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
  const hoverName =
    hoverIdx != null && providers[hoverIdx]
      ? providers[hoverIdx]!.displayName
      : null;
  const focusName = providers[focusIdx]?.displayName;
  const statusBit = hoverName
    ? hoverKind === "copy"
      ? `${YELLOW}▸ copy ${hoverName}${RESET}`
      : `${WHITE}▸ focus ${hoverName}${RESET}`
    : focusName
      ? `${CYAN}◆ ${focusName}${RESET}`
      : `${DIM}arena${RESET}`;
  const actions = [
    { label: `${DIM}${focusHint}/j/k${RESET}`, kind: null as null },
    { label: `${CYAN}n${RESET}${DIM}hop${RESET}`, kind: "hop" as const },
    { label: `${CYAN}o${RESET}${DIM}pen${RESET}`, kind: "open" as const },
    { label: `${CYAN}s${RESET}${DIM}hout${RESET}`, kind: null },
    { label: `${CYAN}b${RESET}${DIM}us${RESET}`, kind: null },
    { label: `${CYAN}c${RESET}${DIM}opy${RESET}`, kind: "copy-focus" as const },
    { label: `${CYAN}h${RESET}${DIM} side${RESET}`, kind: "dormant" as const },
    { label: `${CYAN}?${RESET}${DIM}help${RESET}`, kind: null },
    { label: `${CYAN}r${RESET}${DIM}efresh${RESET}`, kind: "refresh" as const },
    { label: `${CYAN}q${RESET}${DIM}uit${RESET}`, kind: "quit" as const },
    { label: `${DIM}↻${eta}${RESET}`, kind: "refresh" as const },
  ];
  const footerHits: { x0: number; x1: number; action: HitAction }[] = [];
  let footer = `${FOOTER_BG} `;
  let fx = 1;
  footer += statusBit + `${DIM} │ ${RESET}`;
  fx += vlen(statusBit) + 3;
  for (const a of actions) {
    footer += `${DIM}  ${RESET}`;
    fx += 2;
    const x0 = fx;
    footer += a.label;
    fx += vlen(a.label);
    if (a.kind === "refresh") {
      footerHits.push({ x0, x1: fx, action: { kind: "refresh" } });
    } else if (a.kind === "quit") {
      footerHits.push({ x0, x1: fx, action: { kind: "quit" } });
    } else if (a.kind === "dormant") {
      footerHits.push({ x0, x1: fx, action: { kind: "dormant" } });
    } else if (a.kind === "copy-focus" && providers[focusIdx]) {
      footerHits.push({ x0, x1: fx, action: { kind: "copy", index: focusIdx } });
    }
  }
  footer += ` ${RESET}`;

  while (out.length < rows - 1) out.push("");
  out.length = rows - 1;
  const footerY = out.length;
  out.push(footer);
  for (const h of footerHits) {
    hits.push({ ...h, y0: footerY, y1: footerY + 1 });
  }

  if (showHelp) {
    const help = [
      "╭─ interactive ────────────────────────────╮",
      "│  click card     focus fighter            │",
      "│  click next ↑   focus soonest reset      │",
      "│  click ref      copy referral link       │",
      "│  double-click   copy fighter ref         │",
      "│  wheel          cycle focus              │",
      "│  n              hop → best ready         │",
      "│  o              open launch hints        │",
      "│  u              open usage profile URL   │",
      "│  s              shout to ring bus        │",
      "│  b              toggle bus strip         │",
      "│  ↵ / c          copy focused ref         │",
      "│  j/k tab 1-9    move focus               │",
      "│  h              toggle sidelined         │",
      "│  r              refresh now              │",
      "│  ?              close this help          │",
      "│  q              quit                     │",
      "│  Cmd/Ctrl-click open OSC-8 ref URL       │",
      "│  --no-mouse     keyboard-only mode       │",
      "╰──────────────────────────────────────────╯",
    ];
    const top = Math.max(2, Math.floor((rows - help.length) / 2));
    const leftPad = Math.max(2, Math.floor((cols - 44) / 2));
    for (let i = 0; i < help.length; i++) {
      const row = top + i;
      if (row >= rows - 1) break;
      const line = " ".repeat(leftPad) + `${BG_HERO}${CYAN}${help[i]}${RESET}`;
      out[row] = padPlain(line, cols);
    }
    hits.length = 0;
    hits.push({
      x0: 0,
      y0: 0,
      x1: cols,
      y1: rows,
      action: { kind: "help-close" },
    });
  }

  const painted: string[] = [];
  for (let r = 0; r < rows; r++) painted.push(paintLine(out[r] ?? "", cols, r, tick, rows));
  return { screen: painted.join("\n"), hits };
}

