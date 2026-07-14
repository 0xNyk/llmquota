import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Meter } from "./types.js";

const execFileAsync = promisify(execFile);

export function home(...parts: string[]): string {
  return join(homedir(), ...parts);
}

export function hasAnyOwn(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    keys.some((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}

export function whichAll(name: string): string[] {
  const result = spawnSync("which", ["-a", name], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function resolveBinary(candidates: string[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes("/") && existsSync(c)) return c;
  }
  for (const c of candidates) {
    if (!c || c.includes("/")) continue;
    const hits = whichAll(c);
    if (hits[0]) return hits[0];
  }
  return null;
}

const VER_MEMO_MS = 60_000;
const VER_TIMEOUT_MS = 2_500;

function versionCacheKey(binary: string, args: string[]): string {
  return `ver:${binary}:${args.join("\0")}`;
}

export function versionOf(binary: string | null, args: string[] = ["--version"]): string | null {
  if (!binary) return null;
  const cacheKey = versionCacheKey(binary, args);
  const hit = memo.get(cacheKey);
  if (hit && Date.now() - hit.at <= VER_MEMO_MS) return hit.value as string | null;

  try {
    const out = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: VER_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const ver = out.split("\n")[0]?.trim() || null;
    return memoSet(cacheKey, ver);
  } catch {
    return memoSet(cacheKey, null);
  }
}

/** Parallel-friendly version probe — same memo as sync `versionOf`. */
export async function versionOfAsync(
  binary: string | null,
  args: string[] = ["--version"],
): Promise<string | null> {
  if (!binary) return null;
  const cacheKey = versionCacheKey(binary, args);
  const hit = memo.get(cacheKey);
  if (hit && Date.now() - hit.at <= VER_MEMO_MS) return hit.value as string | null;

  try {
    const { stdout } = await execFileAsync(binary, args, {
      encoding: "utf8",
      timeout: VER_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const ver = String(stdout).trim().split("\n")[0]?.trim() || null;
    return memoSet(cacheKey, ver);
  } catch {
    return memoSet(cacheKey, null);
  }
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

export function availableInFromEpoch(resetsAtEpochSec: number | null | undefined): string | null {
  return availableInFromIso(isoFromEpochSec(resetsAtEpochSec));
}

export function availableInFromIso(iso: string | null | undefined): string | null {
  const normalized = normalizeIsoTimestamp(iso);
  if (!normalized) return null;
  const t = Date.parse(normalized);
  return formatDuration(Math.floor((t - Date.now()) / 1000));
}

export function normalizeIsoTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const iso = value.trim();
  const match = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  const offsetHour = Number(match[8] || 0);
  const offsetMinute = Number(match[9] || 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) return null;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function isoFromEpochSec(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  // Cursor sometimes sends ms as strings like "1783573607000"
  let n = sec;
  if (n >= 1e12) n = Math.floor(n / 1000);
  const date = new Date(n * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function windowLabel(seconds: number | null | undefined): string {
  if (seconds == null) return "window";
  if (seconds <= 6 * 3600) return "5h";
  if (seconds <= 2 * 86400) return "daily";
  if (seconds <= 8 * 86400) return "7d";
  if (seconds <= 35 * 86400) return "30d";
  return `${Math.round(seconds / 3600)}h`;
}

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const { timeoutMs = 15000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, json: null, text };
    }
  } finally {
    clearTimeout(timer);
  }
}

const CACHE_DIR = home(".cache", "llmquota");

export function readCache<T>(key: string, maxAgeMs: number): T | null {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { at: number; data: T };
    if (Date.now() - raw.at > maxAgeMs) return null;
    return raw.data;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), data }), {
    mode: 0o600,
  });
}

export function headroomScore(usedPercents: Array<number | null>): number | null {
  const vals = usedPercents.filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return Math.max(...vals);
}

export function meterAffectsAvailability(meter: Meter): boolean {
  return meter.affectsAvailability !== false;
}

export function availabilityScore(meters: Meter[]): number | null {
  return headroomScore(
    meters.filter(meterAffectsAvailability).map((meter) => meter.usedPercent),
  );
}

/** In-memory TTL cache for expensive sync probes (CLI scan, etc.). */
const memo = new Map<string, { at: number; value: unknown }>();

export function memoGet<T>(key: string, maxAgeMs: number): T | null {
  const hit = memo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > maxAgeMs) {
    memo.delete(key);
    return null;
  }
  return hit.value as T;
}

export function memoSet<T>(key: string, value: T): T {
  memo.set(key, { at: Date.now(), value });
  return value;
}

export function memoClear(prefix?: string): void {
  if (!prefix) {
    memo.clear();
    return;
  }
  for (const k of memo.keys()) {
    if (k.startsWith(prefix)) memo.delete(k);
  }
}

export function nonEmpty(s: string | undefined | null): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}
