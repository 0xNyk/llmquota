import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface ActiveSelection {
  provider: string | null;
  model: string | null;
}

function cleanScalar(
  value: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!value) return null;
  const clean = value.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  const variable = clean.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (variable) return cleanScalar(env[variable[1]!], env);
  return clean && !clean.includes("${") ? clean : null;
}

export function parseHermesModelConfig(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): ActiveSelection {
  let inModel = false;
  let provider: string | null = null;
  let model: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^model:\s*$/.test(line)) {
      inModel = true;
      continue;
    }
    if (inModel && /^\S/.test(line)) break;
    if (!inModel) {
      const flat = line.match(/^model:\s*(.+?)\s*$/);
      if (flat) model = cleanScalar(flat[1], env);
      continue;
    }
    const field = line.match(/^\s+(default|provider):\s*(.+?)\s*$/);
    if (!field) continue;
    if (field[1] === "default") model = cleanScalar(field[2], env);
    else provider = cleanScalar(field[2], env);
  }
  return { provider, model };
}

export function parseTomlModelConfig(
  text: string,
  opts: { section?: string; defaultProvider?: string | null } = {},
): ActiveSelection {
  const wanted = opts.section ?? "";
  let section = "";
  let model: string | null = null;
  let provider: string | null = opts.defaultProvider ?? null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    if (section !== wanted) continue;
    const field = line.match(/^(model|model_provider|provider|default)\s*=\s*(.+?)\s*$/);
    if (!field) continue;
    if (field[1] === "model" || field[1] === "default") model = cleanScalar(field[2]);
    else provider = cleanScalar(field[2]);
  }
  return { provider, model };
}

export function parseJsonModelConfig(text: string, defaultProvider: string | null): ActiveSelection {
  try {
    const raw = JSON.parse(text) as { model?: unknown; provider?: unknown };
    return {
      provider: typeof raw.provider === "string" ? cleanScalar(raw.provider) : defaultProvider,
      model: typeof raw.model === "string" ? cleanScalar(raw.model) : null,
    };
  } catch {
    return { provider: defaultProvider, model: null };
  }
}

export function parseCursorModelConfig(text: string): ActiveSelection {
  try {
    const raw = JSON.parse(text) as {
      selectedModel?: { modelId?: unknown };
      model?: { modelId?: unknown } | unknown;
    };
    const selected = raw.selectedModel?.modelId;
    const configured = raw.model && typeof raw.model === "object"
      ? (raw.model as { modelId?: unknown }).modelId
      : raw.model;
    const model = typeof selected === "string"
      ? cleanScalar(selected)
      : typeof configured === "string"
        ? cleanScalar(configured)
        : null;
    return { provider: "Cursor", model };
  } catch {
    return { provider: "Cursor", model: null };
  }
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function readHermesActiveSelection(homeDir: string): ActiveSelection {
  const text = readText(join(homeDir, "config.yaml"));
  return text ? parseHermesModelConfig(text) : { provider: null, model: null };
}

export function readClaudeActiveSelection(
  configDir: string,
  cwd = process.cwd(),
): ActiveSelection {
  const sessionModel = claudeSessionModel(configDir, cwd);
  if (sessionModel) return { provider: "Anthropic", model: sessionModel };
  for (const name of ["settings.local.json", "settings.json"]) {
    const text = readText(join(configDir, name));
    if (!text) continue;
    const selected = parseJsonModelConfig(text, "Anthropic");
    if (selected.model) return selected;
  }
  return { provider: "Anthropic", model: null };
}

export function readCursorActiveSelection(cursorHome: string): ActiveSelection {
  const text = readText(join(cursorHome, "cli-config.json"));
  return text ? parseCursorModelConfig(text) : { provider: "Cursor", model: null };
}

function readTail(path: string, maxBytes = 2 * 1024 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function claudeSessionModel(configDir: string, cwd: string): string | null {
  const projectDir = join(configDir, "projects", cwd.replace(/\//g, "-"));
  try {
    const latest = readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => ({
        path: join(projectDir, entry.name),
        mtimeMs: statSync(join(projectDir, entry.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!latest) return null;
    const text = readTail(latest.path);
    if (!text) return null;
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"type":"assistant"')) continue;
      try {
        const row = JSON.parse(lines[i]!) as {
          cwd?: unknown;
          message?: { model?: unknown };
        };
        const model = row.message?.model;
        if (row.cwd !== cwd || typeof model !== "string" || model === "<synthetic>") continue;
        return cleanScalar(model);
      } catch {
        // The first tail line may be partial.
      }
    }
  } catch {
    return null;
  }
  return null;
}

function codexThreadModel(codexHome: string, threadId: string | undefined): string | null {
  if (!threadId) return null;
  const sessions = join(codexHome, "sessions");
  try {
    const names = readdirSync(sessions, { recursive: true, encoding: "utf8" });
    const relative = names.find((name) => name.endsWith(`${threadId}.jsonl`));
    if (!relative) return null;
    const text = readTail(join(sessions, relative));
    if (!text) return null;
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"type":"turn_context"')) continue;
      try {
        const row = JSON.parse(lines[i]!) as { payload?: { model?: unknown } };
        if (typeof row.payload?.model === "string") return cleanScalar(row.payload.model);
      } catch {
        // The first tail line may be partial; continue to the previous full event.
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function readCodexActiveSelection(
  codexHome: string,
  threadId = process.env.CODEX_THREAD_ID,
): ActiveSelection {
  const text = readText(join(codexHome, "config.toml"));
  const configured = text
    ? parseTomlModelConfig(text, { defaultProvider: "OpenAI" })
    : { provider: "OpenAI", model: null };
  return {
    provider: configured.provider,
    model: codexThreadModel(codexHome, threadId) || configured.model,
  };
}

function grokSessionModel(grokHome: string, cwd: string): string | null {
  const root = join(grokHome, "sessions", encodeURIComponent(cwd));
  try {
    let newest: { model: string; at: number } | null = null;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const text = readText(join(root, entry.name, "summary.json"));
      if (!text) continue;
      try {
        const summary = JSON.parse(text) as {
          info?: { cwd?: unknown };
          current_model_id?: unknown;
          last_active_at?: unknown;
          updated_at?: unknown;
        };
        if (summary.info?.cwd !== cwd || typeof summary.current_model_id !== "string") continue;
        const model = cleanScalar(summary.current_model_id);
        const stamp = summary.last_active_at ?? summary.updated_at;
        const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
        if (model && Number.isFinite(at) && (!newest || at > newest.at)) newest = { model, at };
      } catch {
        // Ignore incomplete session summaries.
      }
    }
    return newest?.model ?? null;
  } catch {
    return null;
  }
}

export function readGrokActiveSelection(
  grokHome: string,
  cwd = process.cwd(),
): ActiveSelection {
  const activeText = readText(join(grokHome, "active_sessions.json"));
  if (activeText) {
    try {
      const rows = JSON.parse(activeText) as unknown;
      if (Array.isArray(rows) && rows.length) {
        const row = rows[rows.length - 1] as Record<string, unknown>;
        const model = row.model ?? row.model_id ?? row.current_model_id;
        const provider = row.provider ?? row.provider_id;
        if (typeof model === "string") {
          return {
            provider: typeof provider === "string" ? cleanScalar(provider) : "xAI",
            model: cleanScalar(model),
          };
        }
      }
    } catch {
      // Fall back to configured new-session model.
    }
  }
  const sessionModel = grokSessionModel(grokHome, cwd);
  if (sessionModel) return { provider: "xAI", model: sessionModel };
  const config = readText(join(grokHome, "config.toml"));
  return config
    ? parseTomlModelConfig(config, { section: "models", defaultProvider: "xAI" })
    : { provider: "xAI", model: null };
}
