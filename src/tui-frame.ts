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
  allocateRowBodyHeights,
  computeLayout,
  dormantChip,
  fighterCard,
  partialRowOffset,
  refPayload,
  zipN,
} from "./tui-cards.js";
import { preferredCardBodyH } from "./tui-card-body.js";
import { anonymousReport, redactPrivateText } from "./tui-anon.js";
import { heroPick, nextUpQueue, nextUpStrip, refsStrip, busStripLines } from "./tui-chrome.js";
import { clusterProviderRoutes, providerRouteGroup, sharedRouteGroups, type IndexedProvider } from "./tui-groups.js";
import { type LoadProgress, loadingScreen, softRefreshBanner, spinnerGlyph } from "./tui-loading.js";
import {
  availability,
  CARD_MIN_BODY,
  isDormant,
  isCooldown,
  REFRESH_MS,
  soonestResetSec,
} from "./tui-model.js";

export interface FrameResult {
  screen: string;
  hits: HitRegion[];
}

function sharedRouteRail(items: IndexedProvider[], cardW: number, gap: number): string {
  let line = "";
  for (let i = 0; i < items.length;) {
    const route = providerRouteGroup(items[i]!.p);
    let end = i + 1;
    while (end < items.length && providerRouteGroup(items[end]!.p) === route) end++;
    const count = end - i;
    if (i > 0) line += " ".repeat(gap);
    if (count > 1) {
      const span = count * cardW + (count - 1) * gap;
      const names = items.slice(i, end).map(({ p }) => p.displayName.split(" · ")[0]).join(" + ");
      const label = `╭─ ${CYAN}${BOLD}${route}${RESET}${DIM} route · ${names}${RESET} `;
      line += `${DIM}${label}${"─".repeat(Math.max(0, span - vlen(label) - 1))}╮${RESET}`;
    } else {
      line += " ".repeat(cardW);
    }
    i = end;
  }
  return line;
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
    anon?: boolean;
  },
): FrameResult {
  const tick = opts.tick ?? 0;
  const showDormant = Boolean(opts.showDormant);
  const showHelp = Boolean(opts.showHelp);
  const showBus = Boolean(opts.showBus);
  const shoutDraft = opts.shoutDraft ?? null;
  if (opts.anon && report) report = anonymousReport(report);
  const providers = report?.providers ?? [];
  const focusIdx = opts.focus ?? 0;
  const hoverIdx = opts.hover ?? null;
  const hoverKind = opts.hoverKind ?? null;
  const hits: HitRegion[] = [];
  const termCols = Math.max(40, process.stdout.columns || 80);
  const termRows = Math.max(16, process.stdout.rows || 24);

  if (opts.loading && !report && opts.loadProgress) {
    return {
      screen: loadingScreen(
        termCols,
        termRows,
        opts.loadProgress,
        tick,
        opts.error && opts.anon ? redactPrivateText(opts.error) : opts.error,
      ),
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
    for (let r = 0; r < termRows; r++) {
      const line = opts.anon ? redactPrivateText(msg[r] ?? "") : msg[r] ?? "";
      painted.push(paintLine(line, termCols, r, tick, termRows));
    }
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
  const clustered = clusterProviderRoutes(indexed);
  const fighters = clustered.filter((x) => !isDormant(x.p));
  const dormant = indexed.filter((x) => isDormant(x.p));

  const dormantLines = dormant.length ? (showDormant ? 1 + dormant.length : 1) : 0;
  const refLines = !opts.anon && report
    ? Math.min(1, providers.some((p) => refPayload(p)) ? 1 : 0)
    : 0;
  const nextUpLines =
    report && nextUpQueue(providers, report.checkedAt).length > 0 ? 1 : 0;
  const softRefreshLines = report && opts.loading && opts.loadProgress?.soft ? 1 : 0;
  const busLines = showBus || shoutDraft != null ? (shoutDraft != null ? 1 : 6) : 0;
  // First pass establishes columns; second pass reserves route rails above grouped rows.
  const baseChrome = 1 + softRefreshLines + 1 + nextUpLines + refLines + 1 + busLines + dormantLines + 1;
  const baseLayout = computeLayout(fighters.length || 1, baseChrome);
  const sharedProviders = new Set(sharedRouteGroups(fighters).map((g) => g.provider));
  const rowHasSharedRoute = (slice: IndexedProvider[]): boolean => {
    for (let i = 1; i < slice.length; i++) {
      const route = providerRouteGroup(slice[i]!.p);
      if (sharedProviders.has(route) && route === providerRouteGroup(slice[i - 1]!.p)) return true;
    }
    return false;
  };
  let routeRailRows = 0;
  for (let i = 0; i < fighters.length; i += baseLayout.columns) {
    if (rowHasSharedRoute(fighters.slice(i, i + baseLayout.columns))) routeRailRows++;
  }
  const chrome = baseChrome + routeRailRows;
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
  const koN = report ? report.providers.filter(isCooldown).length : 0;
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
  if (opts.anon) out[0] += `  ${CYAN}${BOLD}ANON${RESET}`;

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

    const strip = opts.anon ? { lines: [], hits: [] } : refsStrip(providers, cols, focusIdx);
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
      const lines = opts.anon
        ? [`  ${CYAN}bus${RESET}  ${DIM}hidden in anonymous mode${RESET}`]
        : busStripLines(cols, 6);
      while (lines.length < 6) lines.push("");
      out.push(...lines);
    }

    const rowGap =
      layout.cardRows > 1 &&
      rows - chrome >= layout.cardRows * (CARD_MIN_BODY + 3) - 1;

    const desiredRowHeights: number[] = [];
    for (let i = 0; i < fighters.length; i += columns) {
      const slice = fighters.slice(i, i + columns);
      desiredRowHeights.push(Math.max(...slice.map(({ p, i: providerIndex }) =>
        preferredCardBodyH(p, inner - 2, focusIdx === providerIndex, tick, report.checkedAt))));
    }
    const cardBodyBudget = rows - chrome - layout.cardRows * 2 - (rowGap ? layout.cardRows - 1 : 0);
    const rowBodyHeights = allocateRowBodyHeights(desiredRowHeights, cardBodyBudget);

    if (fighters.length) {
      for (let i = 0, rowIndex = 0; i < fighters.length; i += columns, rowIndex++) {
        if (i > 0 && rowGap) out.push("");
        const rowBodyH = rowBodyHeights[rowIndex] ?? bodyH;
        const rowFighters = fighters.slice(i, i + columns);
        const slice = rowFighters.map(({ p, i: providerIndex }) => ({
          ...fighterCard(
            p,
            inner,
            rowBodyH,
            focusIdx === providerIndex,
            hoverIdx === providerIndex,
            tick,
            report.checkedAt,
          ),
          index: providerIndex,
        }));
        const rowOffset = partialRowOffset(slice.length, columns, cardW, gap);
        if (rowHasSharedRoute(rowFighters)) {
          out.push(indent + " ".repeat(rowOffset) + sharedRouteRail(rowFighters, cardW, gap));
        }
        const actualCardTop = out.length;
        const lineCards: string[][] = slice.map((c) => c.lines);
        out.push(...zipN(lineCards, gap, out.length).map((l) => indent + " ".repeat(rowOffset) + l));

        for (let c = 0; c < slice.length; c++) {
          const card = slice[c]!;
          const x0 = margin + rowOffset + c * (cardW + gap);
          const x1 = x0 + cardW;
          const y0 = actualCardTop;
          const y1 = actualCardTop + rowBodyH + 2;
          hits.push({
            x0,
            x1,
            y0,
            y1,
            action: { kind: "focus", index: card.index },
          });
          if (card.refBodyRow != null) {
            const ry = actualCardTop + 1 + card.refBodyRow;
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
    { label: `${CYAN}a${RESET}${DIM}non${RESET}`, kind: null },
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
      "│  a              toggle anonymous mode    │",
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
  for (let r = 0; r < rows; r++) {
    const line = opts.anon ? redactPrivateText(out[r] ?? "") : out[r] ?? "";
    painted.push(paintLine(line, cols, r, tick, rows));
  }
  return { screen: painted.join("\n"), hits };
}
