import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LlmquotaConfig {
  /** Include silo/default profiles that still need login (default: false). */
  includeNeedLogin?: boolean;
  /** Allowlist of Claude silo profile names; omit = all discovered with creds. */
  claudeProfiles?: string[];
  /** Include ~/.claude default slot (default: true). */
  includeClaudeDefault?: boolean;
  /**
   * Auto-detect other installed LLM CLIs (ollama, gemini, aider, …) and show
   * them in the roster/doctor even without a quota probe (default: true).
   */
  detectExtraClis?: boolean;
  /** Only list catalog CLIs that are installed in `scan` (default scan behavior). */
  scanIncludeMissing?: boolean;
}

export interface ClaudeProfileTarget {
  profileId: string;
  profileLabel: string;
  /** Absolute CLAUDE_CONFIG_DIR for this slot */
  configDir: string;
  /** Only the global ~/.claude slot should touch macOS Keychain */
  useKeychain: boolean;
  /** silo default / env-active */
  active: boolean;
  /** File-signal that login material exists */
  hasCreds: boolean;
  source: "default" | "silo" | "env";
}

function configPath(): string {
  return (
    process.env.LLMQUOTA_CONFIG ||
    join(homedir(), ".config", "llmquota", "config.json")
  );
}

export function loadLlmquotaConfig(): LlmquotaConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LlmquotaConfig;
  } catch {
    return {};
  }
}

function siloRoot(): string {
  const override = process.env.SILO_HOME?.trim();
  if (override) return override;
  return join(homedir(), ".silo");
}

function parseSiloDefault(raw: string): string | null {
  const m = raw.match(/^\s*default_profile\s*=\s*"([^"]+)"/m);
  return m?.[1] || null;
}

/** Best-effort cred presence without printing secrets (mirrors silo::has_credentials). */
export function profileHasCreds(configDir: string): boolean {
  const credFile = join(configDir, ".credentials.json");
  if (existsSync(credFile)) return true;
  const claudeJson = join(configDir, ".claude.json");
  if (existsSync(claudeJson)) {
    try {
      if (statSync(claudeJson).size > 64) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function readSiloDefault(): string | null {
  const cfg = join(siloRoot(), "config.toml");
  if (!existsSync(cfg)) return null;
  try {
    return parseSiloDefault(readFileSync(cfg, "utf8"));
  } catch {
    return null;
  }
}

function listSiloProfileNames(): string[] {
  const dir = join(siloRoot(), "profiles");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Discover Claude slots: global ~/.claude (+ Keychain) and each silo profile dir.
 * Inspired by https://github.com/0xNyk/silo — CLAUDE_CONFIG_DIR isolation, no vault swap.
 */
export function discoverClaudeProfiles(
  cfg: LlmquotaConfig = loadLlmquotaConfig(),
): ClaudeProfileTarget[] {
  const includeNeedLogin = Boolean(cfg.includeNeedLogin);
  const includeDefault = cfg.includeClaudeDefault !== false;
  const allow = cfg.claudeProfiles?.length
    ? new Set(cfg.claudeProfiles.map((n) => n.toLowerCase()))
    : null;

  const siloDefault = readSiloDefault();
  const envDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null;
  const defaultDir = join(homedir(), ".claude");

  const out: ClaudeProfileTarget[] = [];

  if (includeDefault) {
    const hasCreds = profileHasCreds(defaultDir);
    // Always keep the default slot visible (installed Claude uses it / Keychain)
    out.push({
      profileId: "default",
      profileLabel: "default",
      configDir: defaultDir,
      useKeychain: true,
      active:
        (!envDir || envDir === defaultDir) &&
        (!siloDefault || !existsSync(join(siloRoot(), "profiles", siloDefault))),
      hasCreds,
      source: "default",
    });
  }

  for (const name of listSiloProfileNames()) {
    if (allow && !allow.has(name.toLowerCase())) continue;
    const configDir = join(siloRoot(), "profiles", name);
    const hasCreds = profileHasCreds(configDir);
    if (!hasCreds && !includeNeedLogin && name !== siloDefault) continue;

    out.push({
      profileId: name,
      profileLabel: name,
      configDir,
      useKeychain: false,
      active:
        siloDefault === name ||
        (envDir != null && (envDir === configDir || envDir.endsWith(`/profiles/${name}`))),
      hasCreds,
      source: "silo",
    });
  }

  // If CLAUDE_CONFIG_DIR points somewhere else entirely, surface it
  if (envDir && !out.some((p) => p.configDir === envDir)) {
    out.unshift({
      profileId: "env",
      profileLabel: "CLAUDE_CONFIG_DIR",
      configDir: envDir,
      useKeychain: false,
      active: true,
      hasCreds: profileHasCreds(envDir),
      source: "env",
    });
  }

  return out;
}
