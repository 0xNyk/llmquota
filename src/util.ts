import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function home(...parts: string[]): string {
  return join(homedir(), ...parts);
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

export function versionOf(binary: string | null, args: string[] = ["--version"]): string | null {
  if (!binary) return null;
  try {
    const out = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
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
  if (resetsAtEpochSec == null) return null;
  const now = Math.floor(Date.now() / 1000);
  return formatDuration(resetsAtEpochSec - now);
}

export function availableInFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return formatDuration(Math.floor((t - Date.now()) / 1000));
}

export function isoFromEpochSec(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  // Cursor sometimes sends ms as strings like "1783573607000"
  let n = sec;
  if (n > 1e12) n = Math.floor(n / 1000);
  return new Date(n * 1000).toISOString();
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
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
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
