import { hopTarget, openHints } from "./arena-moves.js";
import {
  busFileSize,
  busLiveOff,
  busLiveOn,
  busNotifyExternal,
  busPollGrowth,
  busSend,
} from "./bus.js";
import { collectAll } from "./collect.js";
import { copyToClipboard } from "./clipboard.js";
import { scanInstalledClisAsync } from "./providers/detect.js";
import { envDisablesMouse } from "./terminal.js";
import { memoClear } from "./util.js";
import { ESC } from "./tui-ansi.js";
import { type LoadProgress } from "./tui-loading.js";
import { REFRESH_MS, TICK_LOADING_MS, TICK_MS } from "./tui-model.js";
import {
  drainInput,
  hitAt,
  hitKey,
  isMotionButton,
  isWheelDown,
  isWheelUp,
  type HitRegion,
  type MouseEvent,
} from "./tui-mouse.js";
import type { RosterReport } from "./types.js";
import { frame } from "./tui-frame.js";
import { openUsageProfile, usageProfileUrl } from "./usage-profile.js";

function writeScreen(content: string, prev: string | null): string {
  if (prev === content) return prev;
  process.stdout.write(`${ESC}[H${ESC}[J${content}`);
  return content;
}

let mouseEnabled = false;

function enableMouse(): void {
  if (mouseEnabled) return;
  process.stdout.write(`${ESC}[?1003h${ESC}[?1006h`);
  mouseEnabled = true;
}

function disableMouse(): void {
  if (!process.stdout.isTTY) {
    mouseEnabled = false;
    return;
  }
  process.stdout.write(`${ESC}[?1006l${ESC}[?1003l${ESC}[?1000l`);
  mouseEnabled = false;
}

function enterAlt(withMouse: boolean): void {
  process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
  if (withMouse) enableMouse();
}

function leaveAlt(): void {
  disableMouse();
  process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
}

export async function runTui(
  opts: { refresh?: boolean; noMouse?: boolean } = {},
): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("TUI needs an interactive terminal (stdout + stdin TTY)");
  }

  const useMouse = !opts.noMouse && !envDisablesMouse();

  let report: RosterReport | null = null;
  let loading = false;
  let loadProgress: LoadProgress | null = null;
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
  let lastHits: HitRegion[] = [];
  let inputBuf = "";
  let hover: number | null = null;
  let hoverKind: "focus" | "copy" | null = null;
  let showHelp = false;
  let showBus = false;
  let shoutDraft: string | null = null;
  let pressHit: HitRegion | null = null;
  let lastClick: { key: string; at: number } | null = null;
  let lastScreen: string | null = null;
  let redrawQueued = false;
  let redrawTimer: NodeJS.Timeout | null = null;
  let busSeenSize = busFileSize();

  const setTickRate = (ms: number): void => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      tick = (tick + 1) % 64;
      // Live ring: auto-show strip + toast when another CLI shouts
      const growth = busPollGrowth(busSeenSize);
      if (growth.newMessages.length) {
        busSeenSize = growth.size;
        showBus = true;
        const last = growth.newMessages[growth.newMessages.length - 1]!;
        // Skip toast for our own arena shouts (already toasted on send)
        if (last.from !== "arena") {
          showToast(`bus ← ${last.from}: ${last.text.slice(0, 40)}`);
          busNotifyExternal(`${last.from}: ${last.text}`);
        }
      } else {
        busSeenSize = growth.size;
      }
      scheduleRedraw();
    }, ms);
  };

  const showToast = (msg: string): void => {
    toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
      scheduleRedraw();
    }, 2200);
    scheduleRedraw();
  };

  const clampFocus = (): void => {
    const n = report?.providers.length ?? 0;
    if (!n) {
      focus = 0;
      return;
    }
    focus = ((focus % n) + n) % n;
  };

  const copyRef = (index: number): void => {
    const p = report?.providers[index];
    const payload = p?.referral?.link || p?.referral?.label || p?.referral?.code;
    if (!payload) {
      showToast("no referral on this fighter");
      return;
    }
    if (copyToClipboard(payload)) {
      const shown = p!.referral?.code || payload.replace(/^https?:\/\//, "").slice(0, 40);
      showToast(`copied ${p!.displayName} · ${shown}`);
    } else showToast(payload.slice(0, 60));
  };

  const redrawNow = (): void => {
    if (closed) return;
    redrawQueued = false;
    clampFocus();
    const nextRefreshIn = Math.max(0, REFRESH_MS - (Date.now() - lastFetchAt));
    const framed = frame(report, {
      loading,
      loadProgress,
      error: error || undefined,
      lastRefresh: report?.checkedAt
        ? new Date(report.checkedAt).toLocaleTimeString()
        : undefined,
      focus,
      hover,
      hoverKind,
      toast: toast || undefined,
      showDormant,
      showHelp,
      showBus,
      shoutDraft,
      tick,
      nextRefreshIn,
    });
    lastHits = framed.hits;
    lastScreen = writeScreen(framed.screen, lastScreen);
  };

  /** Coalesce burst redraws (mouse motion / parallel progress) into one paint. */
  const scheduleRedraw = (immediate = false): void => {
    if (closed) return;
    if (immediate) {
      if (redrawTimer) {
        clearTimeout(redrawTimer);
        redrawTimer = null;
      }
      redrawNow();
      return;
    }
    if (redrawQueued) return;
    redrawQueued = true;
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      redrawNow();
    }, 16);
  };

  // Alias used by older call sites in this function
  const redraw = (immediate = false): void => scheduleRedraw(immediate);

  const load = async (force = false): Promise<void> => {
    const soft = Boolean(report);
    loading = true;
    error = null;
    if (force) memoClear("scan:");
    const scanned = await scanInstalledClisAsync({ includeMissing: false });
    loadProgress = {
      scanned,
      pending: new Set(["claude", "codex", "cursor", "grok", "hermes"]),
      done: new Set(),
      errors: new Map(),
      startedAt: Date.now(),
      soft,
    };
    setTickRate(TICK_LOADING_MS);
    redraw(true);
    try {
      report = await collectAll({
        refresh: force || opts.refresh,
        scanned,
        onProgress: (ev) => {
          if (!loadProgress) return;
          if (ev.phase === "start") {
            loadProgress.pending = new Set(ev.ids);
          } else if (ev.phase === "done") {
            loadProgress.pending.delete(ev.id);
            loadProgress.done.add(ev.id);
            redraw();
          } else if (ev.phase === "error") {
            loadProgress.pending.delete(ev.id);
            loadProgress.errors.set(ev.id, ev.message);
            redraw();
          }
        },
      });
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
      loadProgress = null;
      setTickRate(TICK_MS);
      redraw(true);
    }
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    busLiveOff();
    if (refreshTimer) clearInterval(refreshTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (redrawTimer) clearTimeout(redrawTimer);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    process.stdin.pause();
    leaveAlt();
  };

  const onFatal = (): void => {
    cleanup();
  };
  process.on("exit", onFatal);
  process.on("uncaughtException", (err) => {
    try {
      process.stderr.write(`\nllmquota crash: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    } catch {
      /* ignore */
    }
    cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    try {
      process.stderr.write(`\nllmquota rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
    } catch {
      /* ignore */
    }
    cleanup();
    process.exit(1);
  });

  enterAlt(useMouse);
  busLiveOn();
  try {
    busSend({
      text: "arena LIVE — open CLIs: next Claude prompt gets unread (if bus arm), others run llmquota bus pull",
      to: "all",
      from: "arena",
    });
    busSeenSize = busFileSize();
  } catch {
    /* ignore announce failure */
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  if (!useMouse) {
    setTimeout(() => showToast("mouse off · --no-mouse / LLMQUOTA_NO_MOUSE"), 50);
  }
  setTimeout(() => showToast("bus LIVE · open sessions can pull / Claude hook"), 80);

  const onKey = (key: string): void => {
    // One-line shout compose mode
    if (shoutDraft != null) {
      if (key === "\u001b") {
        shoutDraft = null;
        redraw();
        return;
      }
      if (key === "\u0003") {
        cleanup();
        process.exit(0);
      }
      if (key === "\r" || key === "\n") {
        const text = shoutDraft.trim();
        shoutDraft = null;
        if (text) {
          try {
            const from = process.env.LLMQUOTA_BUS_FROM?.trim() || "arena";
            busSend({ text, to: "all", from });
            busSeenSize = busFileSize();
            showBus = true;
            showToast(`bus ← ${text.slice(0, 48)}`);
          } catch (err) {
            showToast(err instanceof Error ? err.message : "send failed");
          }
        } else {
          redraw();
        }
        return;
      }
      if (key === "\u007f" || key === "\b") {
        shoutDraft = shoutDraft.slice(0, -1);
        redraw();
        return;
      }
      if (key.length === 1 && key >= " ") {
        if (shoutDraft.length < 200) shoutDraft += key;
        redraw();
      }
      return;
    }

    if (showHelp && key !== "?" && key !== "\u0003" && key !== "q" && key !== "Q" && key !== "\u001b") {
      showHelp = false;
      redraw();
      if (key !== "q" && key !== "Q" && key !== "\u0003") return;
    }
    if (key === "\u0003" || key === "q" || key === "Q") {
      cleanup();
      process.exit(0);
    }
    if (key === "?" || key === "\u001b") {
      showHelp = key === "?" ? !showHelp : false;
      redraw();
      return;
    }
    if (key === "\r" || key === "\n") {
      copyRef(focus);
      return;
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
    if (key === "b" || key === "B") {
      showBus = !showBus;
      redraw();
      return;
    }
    if (key === "s" || key === "S") {
      shoutDraft = "";
      showBus = true;
      redraw();
      return;
    }
    if (key >= "1" && key <= "9") {
      const idx = Number(key) - 1;
      if (report && idx < report.providers.length) {
        focus = idx;
        hover = idx;
        redraw();
      }
      return;
    }
    if (key === "j" || key === "\t" || key === `${ESC}[B`) {
      if (report?.providers.length) {
        focus = (focus + 1) % report.providers.length;
        hover = focus;
        redraw();
      }
      return;
    }
    if (key === "k" || key === `${ESC}[A`) {
      if (report?.providers.length) {
        focus = (focus - 1 + report.providers.length) % report.providers.length;
        hover = focus;
        redraw();
      }
      return;
    }
    if (key === "c" || key === "C") {
      copyRef(focus);
      return;
    }
    if (key === "n" || key === "N") {
      if (!report?.providers.length) return;
      const hop = hopTarget(report.providers, focus);
      if (!hop) {
        showToast("nowhere to hop");
        return;
      }
      focus = hop.index;
      hover = hop.index;
      showToast(hop.reason);
      redraw();
      return;
    }
    if (key === "o" || key === "O") {
      const p = report?.providers[focus];
      if (!p) return;
      const hints = openHints(p);
      showToast(hints.slice(0, 2).join(" · ").replace(/^open\s+/, "open "));
      return;
    }
    if (key === "u" || key === "U") {
      const p = report?.providers[focus];
      if (!p) return;
      const url = usageProfileUrl(p);
      if (!url) {
        showToast("no usage profile URL");
        return;
      }
      const r = openUsageProfile(url);
      if (r.ok) showToast(`usage → ${url.replace(/^https?:\/\//, "").slice(0, 48)}`);
      else showToast(r.error || "open failed");
      return;
    }
  };

  const applyHit = (hit: HitRegion): void => {
    const a = hit.action;
    if (a.kind === "help-close") {
      showHelp = false;
      redraw();
      return;
    }
    if (a.kind === "focus") {
      focus = a.index;
      hover = a.index;
      redraw();
      return;
    }
    if (a.kind === "copy") {
      focus = a.index;
      hover = a.index;
      copyRef(a.index);
      return;
    }
    if (a.kind === "dormant") {
      showDormant = !showDormant;
      redraw();
      return;
    }
    if (a.kind === "refresh") {
      void load(true);
      return;
    }
    if (a.kind === "quit") {
      cleanup();
      process.exit(0);
    }
  };

  const onMouse = (ev: MouseEvent): void => {
    if (!useMouse) return;

    if (isWheelUp(ev.button) || isWheelDown(ev.button)) {
      if (!report?.providers.length) return;
      const n = report.providers.length;
      focus = isWheelUp(ev.button)
        ? (focus - 1 + n) % n
        : (focus + 1) % n;
      hover = focus;
      hoverKind = "focus";
      redraw();
      return;
    }

    if (isMotionButton(ev.button)) {
      const hit = hitAt(lastHits, ev.x, ev.y);
      let next: number | null = null;
      let nextKind: "focus" | "copy" | null = null;
      if (hit?.action.kind === "focus" || hit?.action.kind === "copy") {
        next = hit.action.index;
        nextKind = hit.action.kind;
      }
      if (next !== hover || nextKind !== hoverKind) {
        hover = next;
        hoverKind = nextKind;
        redraw();
      }
      return;
    }

    const btn = ev.button & 0b11;
    if (btn !== 0) return;

    if (ev.press) {
      pressHit = hitAt(lastHits, ev.x, ev.y);
      return;
    }

    const releaseHit = hitAt(lastHits, ev.x, ev.y);
    const pressed = pressHit;
    pressHit = null;
    if (!pressed || !releaseHit) return;
    if (hitKey(pressed.action) !== hitKey(releaseHit.action)) return;

    const key = hitKey(releaseHit.action);
    const now = Date.now();
    const isDouble = Boolean(lastClick && lastClick.key === key && now - lastClick.at < 400);
    lastClick = { key, at: now };

    if (isDouble && (releaseHit.action.kind === "focus" || releaseHit.action.kind === "copy")) {
      focus = releaseHit.action.index;
      hover = releaseHit.action.index;
      copyRef(releaseHit.action.index);
      return;
    }

    applyHit(releaseHit);
  };

  const onData = (chunk: string): void => {
    inputBuf += chunk;
    const { events, keys, rest } = drainInput(inputBuf);
    inputBuf = rest;
    for (const ev of events) onMouse(ev);
    for (const key of keys) onKey(key);
  };

  process.stdin.on("data", onData);
  process.stdout.on("resize", redraw);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  setTickRate(TICK_LOADING_MS);
  await load(false);

  refreshTimer = setInterval(() => {
    void load(false);
  }, REFRESH_MS);

  await new Promise<void>(() => {
    /* resolved via process.exit */
  });
}
