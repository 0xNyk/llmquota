import type { Meter, ProviderSnapshot } from "./types.js";
import { usageLevel, type UsageLevel } from "./usage-level.js";
import { meterAffectsAvailability } from "./util.js";
import {
  BLUE,
  BOLD,
  DIM,
  FG_MUTE,
  GREEN,
  padPlain,
  RED,
  RESET,
  WHITE,
  YELLOW,
} from "./tui-ansi.js";

export { usageLevel, type UsageLevel };

export const REFRESH_MS = 45_000;
export const TICK_MS = 500;
export const TICK_LOADING_MS = 250;
export const CARD_MIN_INNER = 28;
export const CARD_MIN_BODY = 5;
export const GAP = 2;
export const MARGIN = 1;
export const SPARK = "▁▂▃▄▅▆▇█";
const BUS_PROVIDER_IDS = new Set(["claude", "codex", "cursor", "grok", "hermes"]);

/** Provider card associated with an advisory bus session identity. */
export function providerIdFromBusIdentity(identity: string | null | undefined): string | null {
  const base = (identity || "").trim().toLowerCase().split(/[/#]/)[0] || "";
  return BUS_PROVIDER_IDS.has(base) ? base : null;
}

/** Seconds remaining from "5d6h" / "3h40m" / "45m" strings. */
export function parseAvailableIn(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i);
  if (!m) return null;
  const d = Number(m[1] || 0);
  const h = Number(m[2] || 0);
  const min = Number(m[3] || 0);
  if (!d && !h && !min) return null;
  return d * 86400 + h * 3600 + min * 60;
}

export function windowResetSec(w: Meter, checkedAt?: string | null): number | null {
  if (w.resetsAt) {
    const t = Date.parse(w.resetsAt);
    const nowMs =
      checkedAt && !Number.isNaN(Date.parse(checkedAt)) ? Date.parse(checkedAt) : Date.now();
    if (!Number.isNaN(t)) return Math.max(0, (t - nowMs) / 1000);
  }
  const parsed = parseAvailableIn(w.availableIn);
  if (parsed == null) return null;
  const drift =
    checkedAt && !Number.isNaN(Date.parse(checkedAt))
      ? Math.max(0, (Date.now() - Date.parse(checkedAt)) / 1000)
      : 0;
  return Math.max(0, parsed - drift);
}

export function windowName(w: Meter): string {
  return (
    w.label
      .replace(/GPT-5\.3-Codex-Spark/i, "Spark")
      .replace(/^named\/API$/i, "API")
      .replace(/^API\/credits$/i, "API") ||
    w.name ||
    "window"
  );
}

/**
 * Reset that matters for "available again":
 * - If any window is exhausted (≥95%), use the soonest among those.
 * - Else (ready / headroom left), soonest among all windows with a clock.
 */
/** Short local calendar stamp from a real ISO/epoch reset — never invented. */
export function formatResetAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const mon = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${day} ${hh}:${mm}`;
}

/**
 * Distinct absolute resets across windows (real `resetsAt` only).
 * Used for a compact fact line when 5h vs 7d (etc.) differ.
 */
export function distinctResetFacts(p: ProviderSnapshot): Array<{ label: string; at: string }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; at: string }> = [];
  for (const w of p.windows) {
    const at = formatResetAt(w.resetsAt);
    if (!at) continue;
    const key = `${windowName(w)}:${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: windowName(w), at });
  }
  // Collapse if every window shares the same stamp
  if (out.length > 1) {
    const stamps = new Set(out.map((x) => x.at));
    if (stamps.size === 1) return [{ label: "cycle", at: out[0]!.at }];
  }
  return out;
}

export function soonestReset(
  p: ProviderSnapshot,
  checkedAt?: string | null,
): { sec: number; label: string; limiting: boolean; resetsAt: string | null } | null {
  const timed = p.windows
    .filter(meterAffectsAvailability)
    .map((w) => {
      const sec = windowResetSec(w, checkedAt);
      if (sec == null) return null;
      return {
        sec,
        label: windowName(w),
        used: w.usedPercent,
        resetsAt: w.resetsAt && !Number.isNaN(Date.parse(w.resetsAt)) ? w.resetsAt : null,
      };
    })
    .filter(
      (x): x is { sec: number; label: string; used: number | null; resetsAt: string | null } =>
        x != null,
    );

  if (!timed.length) return null;

  const limiting = timed.filter((w) => w.used != null && w.used >= 95);
  const pool = limiting.length ? limiting : timed;
  let best = pool[0]!;
  for (const w of pool) {
    if (w.sec < best.sec) best = w;
  }
  return {
    sec: best.sec,
    label: best.label,
    limiting: limiting.length > 0,
    resetsAt: best.resetsAt,
  };
}

export function soonestResetSec(p: ProviderSnapshot, checkedAt?: string | null): number | null {
  return soonestReset(p, checkedAt)?.sec ?? null;
}

/** Compact clock for tight meter gutters: 5d4h · 1h56m · 45m · 12s */
export function formatCompactDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return h ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return r >= 10 && m < 10 ? `${m}m${r}s` : `${m}m`;
  return `${r}s`;
}

/** Live countdown for card faces / titles (ticks with TUI redraw). */
export function formatCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, "0")}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(r).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

export function countdownLine(
  p: ProviderSnapshot,
  contentWidth: number,
  tick: number,
  checkedAt?: string | null,
  opts?: { clockInTitle?: boolean },
): string | null {
  if (p.auth !== "ok") return null;
  const reset = soonestReset(p, checkedAt);
  const avail = availability(p);
  const headroom =
    p.score != null ? Math.max(0, Math.round(100 - p.score)) : null;
  const pulse = ["↻", "↺", "↻", "↺"][tick % 4]!;
  const clockOwned = Boolean(opts?.clockInTitle);

  if (!reset) {
    if (headroom == null) return null;
    return padPlain(`${DIM}${headroom}% free${RESET}`, contentWidth);
  }

  const clock = formatCountdown(reset.sec);
  const cal = formatResetAt(reset.resetsAt);
  const calBit = cal ? ` · ${cal}` : "";
  const free =
    headroom != null && (avail === "ready" || !reset.limiting)
      ? ` ${DIM}· ${headroom}% free${RESET}`
      : "";

  if (reset.sec <= 0 && reset.limiting) {
    return padPlain(`${GREEN}${BOLD}${pulse} available now${RESET}${free}`, contentWidth);
  }

  // Title already shows the clock — footer only names the limiter (+ real date).
  if (clockOwned && reset.limiting && avail !== "ready") {
    const color = avail === "soon" ? YELLOW : RED;
    return padPlain(
      `${color}${BOLD}${pulse}${RESET} ${color}until ${reset.label} clears${RESET}${DIM}${calBit}${RESET}`,
      contentWidth,
    );
  }

  if (avail === "ready" || !reset.limiting) {
    return padPlain(
      `${DIM}${pulse} resets ${clock}${RESET}${DIM} · ${reset.label}${calBit}${RESET}${free}`,
      contentWidth,
    );
  }

  const color = avail === "soon" ? YELLOW : RED;
  return padPlain(
    `${color}${BOLD}${pulse} back in ${clock}${RESET}${DIM} · ${reset.label}${calBit}${RESET}`,
    contentWidth,
  );
}

/** Fight availability for highlight / sort. */
export type Avail = "ready" | "soon" | "limping" | "tired" | "unknown" | "auth" | "missing";

export const SOON_SEC = 48 * 3600;

export function availability(p: ProviderSnapshot, checkedAt?: string | null): Avail {
  if (!p.installed) return "missing";
  if (p.auth !== "ok") return "auth";
  if (p.error && !p.windows.length) return "unknown";
  const st = statusInfo(p, 0);
  if (st.kind === "ready") return "ready";
  if (st.kind === "unknown") return "unknown";
  if (st.kind === "warn") {
    const sec = soonestResetSec(p, checkedAt);
    if (sec != null && sec <= SOON_SEC) return "soon";
    return "limping";
  }
  if (st.kind === "ko") {
    const sec = soonestResetSec(p, checkedAt);
    if (sec != null && sec <= SOON_SEC) return "soon";
    return "tired";
  }
  return st.kind === "auth" ? "auth" : st.kind === "missing" ? "missing" : "tired";
}

/** True only when current evidence says requests are blocked by quota. */
export function isCooldown(p: ProviderSnapshot): boolean {
  if (!p.installed || p.auth !== "ok") return false;
  return statusInfo(p, 0).kind === "ko";
}

export function levelColor(lvl: UsageLevel): string {
  return { blue: BLUE, green: GREEN, yellow: YELLOW, red: RED, unknown: DIM }[lvl];
}

/** Stable quota track: heavy fill = used, thin track = remaining. */
export function usageWave(
  _seed: string,
  used: number | null,
  width: number,
  phase = 0,
  intensity = 0,
): string {
  const w = Math.max(6, width);
  if (used == null) return `${FG_MUTE}${"─".repeat(w)}${RESET}`;

  const pct = Math.max(0, Math.min(100, used));
  const filled = Math.round((pct / 100) * w);
  const fill = levelColor(usageLevel(used));
  const heat = Math.max(0, Math.min(1, intensity));
  let usedGlyphs = "";
  for (let i = 0; i < filled; i++) {
    if (heat <= 0.05) {
      usedGlyphs += "━";
      continue;
    }
    const wave = 0.5 + 0.5 * Math.sin(i * 0.48 + phase * 0.65 + (_seed.length % 7));
    const level = Math.max(0, Math.min(7, Math.round((0.18 + wave * 0.82) * heat * 7)));
    usedGlyphs += SPARK[level]!;
  }
  const usedTrack = filled > 0 ? `${fill}${usedGlyphs}${RESET}` : "";
  const remainingTrack = filled < w ? `${FG_MUTE}${"─".repeat(w - filled)}${RESET}` : "";
  return usedTrack + remainingTrack;
}

/** Animation strength: usage pressure before limit, remaining cooldown after exhaustion. */
export function meterWaveIntensity(m: Meter): number {
  if (!meterAffectsAvailability(m) || m.usedPercent == null) return 0;
  if (m.usedPercent < 70) return 0;
  if (m.usedPercent < 100) return Math.min(1, (m.usedPercent - 70) / 30);
  if (m.windowSeconds && m.resetsAt) {
    const remaining = Math.max(0, Date.parse(m.resetsAt) - Date.now()) / 1000;
    if (Number.isFinite(remaining)) return Math.min(1, remaining / m.windowSeconds);
  }
  return 1;
}

export function paceFraction(m: Meter): number | null {
  if (m.windowSeconds == null || m.windowSeconds <= 0 || !m.resetsAt) return null;
  const reset = Date.parse(m.resetsAt);
  if (Number.isNaN(reset)) return null;
  const remainingSec = Math.max(0, (reset - Date.now()) / 1000);
  const elapsed = Math.max(0, m.windowSeconds - remainingSec);
  return Math.min(1, elapsed / m.windowSeconds);
}

/** Ambient wave — boot screen only. */
export function ambientWave(seed: string, width: number, phase = 0, color = DIM): string {
  const w = Math.max(6, width);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  let out = "";
  for (let i = 0; i < w; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const wave = 0.5 + 0.5 * Math.sin(i * 0.5 + phase * 0.5 + (h % 80) / 35);
    const v = Math.max(0, Math.min(1, 0.55 * wave * (0.75 + (h % 40) / 100)));
    out += SPARK[Math.min(SPARK.length - 1, Math.floor(v * (SPARK.length - 1)))]!;
  }
  return `${color}${out}${RESET}`;
}

export interface StatusInfo {
  label: string;
  short: string;
  color: string;
  kind: "ready" | "warn" | "ko" | "unknown" | "auth" | "missing";
}

export function statusInfo(p: ProviderSnapshot, tick: number): StatusInfo {
  if (!p.installed) return { label: "missing", short: "—", color: DIM, kind: "missing" };
  if (p.auth === "missing") return { label: "no login", short: "···", color: YELLOW, kind: "auth" };
  if (p.auth === "expired") return { label: "expired", short: "!", color: RED, kind: "auth" };
  if (p.auth === "error") return { label: "error", short: "!", color: RED, kind: "auth" };
  if (p.error && !p.windows.length) {
    return { label: "usage unknown", short: "?", color: YELLOW, kind: "unknown" };
  }

  const pulse = ["●", "◉", "○", "◉"][tick % 4]!;
  if (p.score != null) {
    if (p.score >= 100) return { label: "ko", short: "✕", color: RED, kind: "ko" };
    if (p.score >= 90) return { label: "limping", short: "!", color: YELLOW, kind: "warn" };
    return { label: "ready", short: pulse, color: GREEN, kind: "ready" };
  }
  if (p.requestAvailability === "blocked") {
    return { label: "ko", short: "✕", color: RED, kind: "ko" };
  }
  if (p.requestAvailability === "unknown") {
    return { label: "usage unknown", short: "?", color: YELLOW, kind: "unknown" };
  }
  if (p.windows.some((w) => meterAffectsAvailability(w) && (w.usedPercent ?? 0) >= 100)) {
    return { label: "ko", short: "✕", color: RED, kind: "ko" };
  }
  if (p.windows.some((w) => meterAffectsAvailability(w) && (w.usedPercent ?? 0) >= 90)) {
    return { label: "limping", short: "!", color: YELLOW, kind: "warn" };
  }
  return p.requestAvailability === "available"
    ? { label: "ready", short: pulse, color: GREEN, kind: "ready" }
    : { label: "usage unknown", short: "?", color: YELLOW, kind: "unknown" };
}

export function isDormant(p: ProviderSnapshot): boolean {
  return !p.installed || p.auth === "missing";
}
