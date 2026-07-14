/**
 * One-shot `llmquota bus arm` — wire every metered CLI so they join the ring
 * when the arena is LIVE.
 *
 * - Claude: UserPromptSubmit hook (fires on next prompt in open sessions)
 * - Codex / Cursor / Hermes / Grok: AGENTS.md · Cursor rule · skills
 *   (picked up on new sessions; open sessions: `llmquota bus pull`)
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./util.js";

const HOOK_MARKER = "llmquota-bus";
const BLOCK_BEGIN = "<!-- llmquota-bus:begin -->";
const BLOCK_END = "<!-- llmquota-bus:end -->";

export interface ArmTargetResult {
  id: string;
  ok: boolean;
  detail: string;
}

function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

export function busHookScriptPath(): string {
  return join(packageRoot(), "examples", "bus-hook.sh");
}

export function claudeHookInstallPath(): string {
  return home(".claude", "hooks", "llmquota-bus.sh");
}

export function claudeSettingsPath(): string {
  return home(".claude", "settings.json");
}

function instructionBlock(from: string): string {
  return [
    BLOCK_BEGIN,
    `# llmquota ring bus (${from})`,
    "",
    "When the llmquota arena is LIVE (`test -f ~/.local/share/llmquota/bus/LIVE`):",
    "",
    `  export LLMQUOTA_BUS_FROM=${from}/<slot>   # unique per session, e.g. ${from}/personal`,
    "  llmquota bus pull                       # unread for you (and all)",
    "  llmquota bus who                        # peers + same-directory sessions",
    "  llmquota bus send -t all '…'            # broadcast",
    "  llmquota bus send -t here '…'           # same cwd only",
    "  llmquota bus send -t repo '…'           # same git repo",
    "  llmquota bus send -t claude/work '…'    # one session",
    "  llmquota bus send -t claude '…'         # all claude/* sessions",
    "",
    "Skip when LIVE is absent. Do not invent quota %. Read-only mailbox.",
    BLOCK_END,
  ].join("\n");
}

function skillMarkdown(from: string): string {
  return `---
name: llmquota-bus
description: >-
  Join the llmquota cross-CLI ring bus when the arena is LIVE.
  Pull unread messages and shout replies across Claude/Codex/Cursor/Grok/Hermes.
---

${instructionBlock(from)}
`;
}

function upsertMarkedBlock(path: string, block: string): { wrote: boolean; created: boolean } {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created = !existsSync(path);
  const prev = created ? "" : readFileSync(path, "utf8");
  let next: string;
  if (prev.includes(BLOCK_BEGIN) && prev.includes(BLOCK_END)) {
    next = prev.replace(
      new RegExp(`${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}`),
      block,
    );
  } else {
    next = prev.trimEnd() ? `${prev.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  if (next === prev) return { wrote: false, created: false };
  writeFileSync(path, next, { mode: 0o600 });
  return { wrote: true, created };
}

function removeMarkedBlock(path: string): boolean {
  if (!existsSync(path)) return false;
  const prev = readFileSync(path, "utf8");
  if (!prev.includes(BLOCK_BEGIN)) return false;
  const next = prev
    .replace(new RegExp(`\\n*${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n*`), "\n")
    .trimEnd();
  writeFileSync(path, next ? `${next}\n` : "", { mode: 0o600 });
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeSkill(dir: string, from: string): ArmTargetResult {
  if (!existsSync(dirname(dir)) && !existsSync(dir)) {
    // parent skills root missing — skip quietly
    const root = dirname(dir);
    if (!existsSync(root)) {
      return { id: from, ok: true, detail: `skip · no ${root}` };
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, skillMarkdown(from), { mode: 0o600 });
  return { id: from, ok: true, detail: `skill ${path}` };
}

function armClaude(): ArmTargetResult {
  const src = busHookScriptPath();
  if (!existsSync(src)) {
    return { id: "claude", ok: false, detail: `missing ${src}` };
  }
  const hooksDir = home(".claude", "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  const dest = claudeHookInstallPath();
  copyFileSync(src, dest);
  try {
    chmodSync(dest, 0o755);
  } catch {
    /* best effort */
  }

  const settingsPath = claudeSettingsPath();
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      return { id: "claude", ok: false, detail: `cannot parse ${settingsPath}` };
    }
  }

  const hooks = (settings.hooks as Record<string, unknown[]>) || {};
  const list = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
  const already = list.some((entry) => JSON.stringify(entry).includes(HOOK_MARKER));
  if (!already) {
    list.push({
      hooks: [{ type: "command", command: dest, timeout: 10 }],
    });
    hooks.UserPromptSubmit = list;
    settings.hooks = hooks;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }

  // Also drop a CLAUDE.md note for sessions that don't fire hooks
  upsertMarkedBlock(home(".claude", "CLAUDE.md"), instructionBlock("claude"));

  return {
    id: "claude",
    ok: true,
    detail: already
      ? `hook ${dest} (open sessions: next prompt)`
      : `hook + settings · open sessions: next prompt`,
  };
}

function disarmClaude(): ArmTargetResult {
  removeMarkedBlock(home(".claude", "CLAUDE.md"));
  const settingsPath = claudeSettingsPath();
  if (!existsSync(settingsPath)) {
    return { id: "claude", ok: true, detail: "no settings" };
  }
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { id: "claude", ok: false, detail: `cannot parse ${settingsPath}` };
  }
  const hooks = (settings.hooks as Record<string, unknown[]>) || {};
  const list = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  const next = list.filter((entry) => !JSON.stringify(entry).includes(HOOK_MARKER));
  if (next.length === list.length) {
    return { id: "claude", ok: true, detail: "hook not present" };
  }
  if (next.length) hooks.UserPromptSubmit = next;
  else delete hooks.UserPromptSubmit;
  settings.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { id: "claude", ok: true, detail: "hook removed from settings" };
}

function armCodex(): ArmTargetResult {
  const path = home(".codex", "AGENTS.md");
  const r = upsertMarkedBlock(path, instructionBlock("codex"));
  return {
    id: "codex",
    ok: true,
    detail: r.created
      ? `created ${path} (new sessions; open: bus pull)`
      : r.wrote
        ? `updated ${path} (new sessions; open: bus pull)`
        : `already in ${path}`,
  };
}

function armCursor(): ArmTargetResult {
  const dir = home(".cursor", "rules");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "llmquota-bus.mdc");
  const body = `---
description: llmquota cross-CLI ring bus when arena is LIVE
alwaysApply: true
---

${instructionBlock("cursor")}
`;
  writeFileSync(path, body, { mode: 0o600 });
  return {
    id: "cursor",
    ok: true,
    detail: `rule ${path} (new chats; open: bus pull)`,
  };
}

function armHermes(): ArmTargetResult {
  const soul = home(".hermes", "SOUL.md");
  const bits: string[] = [];
  if (existsSync(soul) || existsSync(home(".hermes"))) {
    const r = upsertMarkedBlock(soul, instructionBlock("hermes"));
    bits.push(r.wrote || r.created ? `SOUL.md` : `SOUL.md (kept)`);
  }
  const skill = writeSkill(home(".hermes", "skills", "llmquota-bus"), "hermes");
  bits.push(skill.detail);
  return { id: "hermes", ok: true, detail: bits.join(" · ") + " (new sessions; open: bus pull)" };
}

function armGrok(): ArmTargetResult {
  const agents = home(".grok", "AGENTS.md");
  const bits: string[] = [];
  if (existsSync(home(".grok"))) {
    const r = upsertMarkedBlock(agents, instructionBlock("grok"));
    bits.push(r.created || r.wrote ? agents : `${agents} (kept)`);
    const skillRoot = home(".grok", "skills");
    if (existsSync(skillRoot)) {
      bits.push(writeSkill(join(skillRoot, "llmquota-bus"), "grok").detail);
    }
  } else {
    return { id: "grok", ok: true, detail: "skip · ~/.grok missing" };
  }
  return { id: "grok", ok: true, detail: bits.join(" · ") + " (new sessions; open: bus pull)" };
}

/** Arm every CLI. One command: `llmquota bus arm`. */
export function busArmAll(): { ok: boolean; results: ArmTargetResult[]; message: string } {
  const results = [armClaude(), armCodex(), armCursor(), armHermes(), armGrok()];
  const ok = results.every((r) => r.ok);
  const lines = [
    "armed all CLIs (one command):",
    ...results.map((r) => `  ${r.ok ? "✓" : "✗"} ${r.id.padEnd(7)} · ${r.detail}`),
    "",
    "Open sessions:",
    "  claude  → next user prompt (hook injects unread)",
    "  others  → run:  llmquota bus pull",
    "           or start a new session after arm",
    "Arena must be LIVE: llmquota",
  ];
  return { ok, results, message: lines.join("\n") };
}

/** Remove arm artifacts from every CLI. */
export function busDisarmAll(): { ok: boolean; results: ArmTargetResult[]; message: string } {
  const results: ArmTargetResult[] = [
    disarmClaude(),
    {
      id: "codex",
      ok: true,
      detail: removeMarkedBlock(home(".codex", "AGENTS.md"))
        ? "removed block from AGENTS.md"
        : "no block",
    },
    {
      id: "cursor",
      ok: true,
      detail: (() => {
        const path = home(".cursor", "rules", "llmquota-bus.mdc");
        if (!existsSync(path)) return "no rule";
        try {
          unlinkSync(path);
          return `removed ${path}`;
        } catch {
          return `could not remove ${path}`;
        }
      })(),
    },
    {
      id: "hermes",
      ok: true,
      detail: [
        removeMarkedBlock(home(".hermes", "SOUL.md")) ? "SOUL.md cleaned" : "SOUL.md no block",
        existsSync(home(".hermes", "skills", "llmquota-bus", "SKILL.md"))
          ? "skill left (delete ~/.hermes/skills/llmquota-bus to drop)"
          : "no skill",
      ].join(" · "),
    },
    {
      id: "grok",
      ok: true,
      detail: removeMarkedBlock(home(".grok", "AGENTS.md"))
        ? "removed block from AGENTS.md"
        : "no block",
    },
  ];
  const ok = results.every((r) => r.ok);
  return {
    ok,
    results,
    message: ["disarmed:", ...results.map((r) => `  ${r.id.padEnd(7)} · ${r.detail}`)].join("\n"),
  };
}

/** @deprecated use busArmAll */
export function busArmClaude(): { ok: boolean; message: string } {
  const r = busArmAll();
  return { ok: r.ok, message: r.message };
}

/** @deprecated use busDisarmAll */
export function busDisarmClaude(): { ok: boolean; message: string } {
  const r = busDisarmAll();
  return { ok: r.ok, message: r.message };
}
