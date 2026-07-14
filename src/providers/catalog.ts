import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  home,
  memoGet,
  memoSet,
  resolveBinary,
  versionOf,
  versionOfAsync,
  whichAll,
} from "../util.js";

/** Known LLM / coding-agent CLIs we can fingerprint on disk or PATH. */
export type CliKind =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "hermes"
  | "gemini"
  | "ollama"
  | "aider"
  | "amp"
  | "goose"
  | "opencode"
  | "copilot"
  | "llm"
  | "fabric"
  | "crush"
  | "silo"
  | "qwen"
  | "kimi"
  | "other";

export interface CliFingerprint {
  id: CliKind | string;
  displayName: string;
  bins: string[];
  homeMarkers?: string[];
  versionArgs?: string[];
  rejectIf?: (path: string, version: string | null) => boolean;
  preferIf?: (path: string, version: string | null) => boolean;
  metered: boolean;
  hint?: string;
}

export const CLI_CATALOG: CliFingerprint[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    bins: [home(".local/bin/claude"), home(".local/share/claude/versions"), "claude"],
    homeMarkers: [home(".claude")],
    metered: true,
  },
  {
    id: "codex",
    displayName: "Codex",
    bins: [
      home(".local/bin/codex"),
      home(".codex/packages/standalone/current/bin/codex"),
      "codex",
    ],
    homeMarkers: [home(".codex")],
    metered: true,
  },
  {
    id: "cursor",
    displayName: "Cursor Agent",
    bins: [
      home(".local/bin/cursor-agent"),
      home(".local/bin/agent"),
      home(".local/share/cursor-agent/versions"),
      "/opt/homebrew/bin/cursor",
      "cursor-agent",
      "cursor",
    ],
    homeMarkers: [home(".cursor")],
    metered: true,
    rejectIf: (path, ver) => {
      const lower = path.toLowerCase();
      if (lower.includes(".grok") || (ver && ver.toLowerCase().includes("grok"))) return true;
      if (basename(path) === "agent" && !lower.includes("cursor-agent")) {
        if (ver && /^\d{4}\.\d{2}\.\d{2}/.test(ver)) return false;
        return true;
      }
      return false;
    },
    preferIf: (path, ver) =>
      path.includes("cursor-agent") || Boolean(ver && /^\d{4}\.\d{2}\.\d{2}/.test(ver)),
  },
  {
    id: "grok",
    displayName: "Grok",
    bins: [home(".grok/bin/grok"), home(".local/bin/grok"), "grok"],
    homeMarkers: [home(".grok")],
    metered: true,
  },
  {
    id: "hermes",
    displayName: "Hermes",
    bins: [home(".local/bin/hermes"), "hermes"],
    homeMarkers: [home(".hermes")],
    versionArgs: ["--version"],
    metered: true,
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    bins: [home(".local/bin/gemini"), "/opt/homebrew/bin/gemini", "gemini"],
    homeMarkers: [home(".gemini"), home(".config/gemini")],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    bins: ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", home(".local/bin/ollama"), "ollama"],
    homeMarkers: [home(".ollama")],
    metered: false,
    hint: "Local models — no cloud quota",
  },
  {
    id: "aider",
    displayName: "Aider",
    bins: [home(".local/bin/aider"), "/opt/homebrew/bin/aider", "aider", "aider-chat"],
    metered: false,
    hint: "Detected — uses provider API keys (no built-in quota probe)",
  },
  {
    id: "amp",
    displayName: "Amp",
    bins: [home(".local/bin/amp"), "amp"],
    homeMarkers: [home(".config/amp"), home(".amp")],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "goose",
    displayName: "Goose",
    bins: [home(".local/bin/goose"), "/opt/homebrew/bin/goose", "goose"],
    homeMarkers: [home(".config/goose")],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    bins: [home(".local/bin/opencode"), "opencode"],
    homeMarkers: [home(".config/opencode")],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    bins: [home(".local/bin/copilot"), "copilot", "gh"],
    rejectIf: (path) => basename(path) === "gh",
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "llm",
    displayName: "llm (Simon Willison)",
    bins: [home(".local/bin/llm"), "/opt/homebrew/bin/llm", "llm"],
    metered: false,
    hint: "Detected — uses provider keys",
  },
  {
    id: "fabric",
    displayName: "Fabric",
    bins: [home(".local/bin/fabric"), "/opt/homebrew/bin/fabric", "fabric"],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "crush",
    displayName: "Crush",
    bins: [home(".local/bin/crush"), "crush"],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "silo",
    displayName: "silo",
    bins: [home(".local/bin/silo"), "silo"],
    homeMarkers: [home(".silo")],
    metered: false,
    hint: "Profile launcher for Claude — quotas live on Claude cards",
  },
  {
    id: "qwen",
    displayName: "Qwen Code",
    bins: [home(".local/bin/qwen"), "qwen", "qwen-code"],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
  {
    id: "kimi",
    displayName: "Kimi CLI",
    bins: [home(".local/bin/kimi"), "kimi"],
    metered: false,
    hint: "Detected — no quota probe yet",
  },
];

export interface DetectedCli {
  id: string;
  displayName: string;
  path: string | null;
  version: string | null;
  installed: boolean;
  homePresent: boolean;
  metered: boolean;
  hint: string | null;
  allPaths: string[];
}

const MAX_VERSION_DIR_KIDS = 2;
const MAX_VERSION_PROBES = 3;
const SCAN_MEMO_MS = 2_500;

function expandVersionedDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return [dir];
    const kids = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((p) => {
        try {
          const s = statSync(p);
          return s.isFile() || s.isSymbolicLink();
        } catch {
          return false;
        }
      });
    kids.sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
    return kids.slice(0, MAX_VERSION_DIR_KIDS);
  } catch {
    return [];
  }
}

function candidatePaths(fp: CliFingerprint): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    try {
      const real = existsSync(p) ? realpathSync(p) : p;
      if (seen.has(real)) return;
      seen.add(real);
      out.push(p);
    } catch {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  };

  for (const raw of fp.bins) {
    if (!raw) continue;
    if (raw.includes("/") && raw.endsWith("/versions")) {
      for (const kid of expandVersionedDir(raw)) add(kid);
      continue;
    }
    if (raw.includes("/")) {
      if (existsSync(raw)) add(raw);
      continue;
    }
    for (const hit of whichAll(raw)) add(hit);
  }

  const primary = fp.bins.find((b) => !b.includes("/")) || fp.id;
  for (const dir of [home(".local/bin"), home(".grok/bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    const p = join(dir, primary);
    if (existsSync(p)) add(p);
  }

  return out;
}

function cheapReject(fp: CliFingerprint, path: string): boolean {
  if (!fp.rejectIf) return false;
  if (!fp.rejectIf(path, null)) return false;
  if (!fp.rejectIf(path, "2099.01.01-deadbeef")) return false;
  return true;
}

function listExisting(fp: CliFingerprint): { homePresent: boolean; existing: string[] } {
  const homePresent = Boolean(fp.homeMarkers?.some((m) => existsSync(m)));
  const existing: string[] = [];
  for (const path of candidatePaths(fp)) {
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    if (cheapReject(fp, path)) continue;
    existing.push(path);
  }
  existing.sort((a, b) => {
    const pa = Number(Boolean(fp.preferIf?.(a, null)));
    const pb = Number(Boolean(fp.preferIf?.(b, null)));
    return pb - pa;
  });
  return { homePresent, existing };
}

function probeVersionSync(path: string, fp: CliFingerprint): string | null {
  let ver = versionOf(path, fp.versionArgs || ["--version"]);
  if (fp.id === "hermes" && ver && ver.toLowerCase().startsWith("usage:")) {
    ver = versionOf(path, ["version"]);
  }
  return ver;
}

async function probeVersionAsync(path: string, fp: CliFingerprint): Promise<string | null> {
  let ver = await versionOfAsync(path, fp.versionArgs || ["--version"]);
  if (fp.id === "hermes" && ver && ver.toLowerCase().startsWith("usage:")) {
    ver = await versionOfAsync(path, ["version"]);
  }
  return ver;
}

function finishDetect(
  fp: CliFingerprint,
  homePresent: boolean,
  scored: { path: string; version: string | null; prefer: boolean }[],
): DetectedCli {
  scored.sort((a, b) => Number(b.prefer) - Number(a.prefer));
  const best = scored[0];
  return {
    id: fp.id,
    displayName: fp.displayName,
    path: best?.path ?? null,
    version: best?.version ?? null,
    installed: Boolean(best),
    homePresent,
    metered: fp.metered,
    hint: fp.hint || null,
    allPaths: scored.map((s) => s.path),
  };
}

function scoreExisting(
  fp: CliFingerprint,
  existing: string[],
  versions: Array<string | null>,
): { path: string; version: string | null; prefer: boolean }[] {
  const scored: { path: string; version: string | null; prefer: boolean }[] = [];
  for (let i = 0; i < existing.length; i++) {
    const path = existing[i]!;
    const probed = i < versions.length;
    const version = probed ? versions[i]! : null;
    if (probed && fp.rejectIf?.(path, version)) continue;
    if (!probed && fp.rejectIf?.(path, null)) continue;
    scored.push({
      path,
      version,
      prefer: Boolean(fp.preferIf?.(path, version)),
    });
    if (scored.length && scored[scored.length - 1]!.prefer && version) {
      for (let j = i + 1; j < existing.length; j++) {
        const rest = existing[j]!;
        if (cheapReject(fp, rest)) continue;
        scored.push({ path: rest, version: null, prefer: false });
      }
      break;
    }
  }
  return scored;
}

export function detectCatalogEntry(fp: CliFingerprint): DetectedCli {
  const { homePresent, existing } = listExisting(fp);
  const toProbe = existing.slice(0, MAX_VERSION_PROBES);
  const versions = toProbe.map((p) => probeVersionSync(p, fp));
  return finishDetect(fp, homePresent, scoreExisting(fp, existing, versions));
}

export async function detectCatalogEntryAsync(fp: CliFingerprint): Promise<DetectedCli> {
  const { homePresent, existing } = listExisting(fp);
  const toProbe = existing.slice(0, MAX_VERSION_PROBES);
  const versions = await Promise.all(toProbe.map((p) => probeVersionAsync(p, fp)));
  return finishDetect(fp, homePresent, scoreExisting(fp, existing, versions));
}

function scanMemoKey(includeMissing: boolean): string {
  return `scan:${includeMissing ? "all" : "installed"}`;
}

function hasInstallHint(fp: CliFingerprint): boolean {
  if (fp.homeMarkers?.some((m) => existsSync(m))) return true;
  for (const b of fp.bins) {
    if (!b) continue;
    if (b.includes("/")) {
      if (existsSync(b)) return true;
      continue;
    }
  }
  const primary = fp.bins.find((b) => b && !b.includes("/"));
  if (primary && whichAll(primary)[0]) return true;
  return false;
}

export function scanInstalledClis(opts: { includeMissing?: boolean } = {}): DetectedCli[] {
  const includeMissing = Boolean(opts.includeMissing);
  const key = scanMemoKey(includeMissing);
  const cached = memoGet<DetectedCli[]>(key, SCAN_MEMO_MS);
  if (cached) return cached;

  const out: DetectedCli[] = [];
  for (const fp of CLI_CATALOG) {
    if (!includeMissing && !hasInstallHint(fp)) continue;
    const hit = detectCatalogEntry(fp);
    if (!includeMissing && !hit.installed && !hit.homePresent) continue;
    if (!includeMissing && !hit.installed) continue;
    out.push(hit);
  }
  return memoSet(key, out);
}

export async function scanInstalledClisAsync(
  opts: { includeMissing?: boolean } = {},
): Promise<DetectedCli[]> {
  const includeMissing = Boolean(opts.includeMissing);
  const key = scanMemoKey(includeMissing);
  const cached = memoGet<DetectedCli[]>(key, SCAN_MEMO_MS);
  if (cached) return cached;

  const fps = CLI_CATALOG.filter((fp) => includeMissing || hasInstallHint(fp));
  const hits = await Promise.all(fps.map((fp) => detectCatalogEntryAsync(fp)));
  const out = hits.filter((hit) => {
    if (!includeMissing && !hit.installed && !hit.homePresent) return false;
    if (!includeMissing && !hit.installed) return false;
    return true;
  });
  return memoSet(key, out);
}

export function detectFromCatalog(id: string): DetectedCli {
  for (const key of [scanMemoKey(false), scanMemoKey(true)] as const) {
    const cached = memoGet<DetectedCli[]>(key, SCAN_MEMO_MS);
    const hit = cached?.find((c) => c.id === id);
    if (hit) return hit;
  }

  const fp = CLI_CATALOG.find((c) => c.id === id);
  if (!fp) {
    return {
      id,
      displayName: id,
      path: null,
      version: null,
      installed: false,
      homePresent: false,
      metered: false,
      hint: null,
      allPaths: [],
    };
  }
  return detectCatalogEntry(fp);
}

export function resolveFirst(bins: string[]): string | null {
  return resolveBinary(bins);
}
