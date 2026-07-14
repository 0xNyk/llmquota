import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBinary, versionOf, whichAll } from "../util.js";

export interface DetectedBinary {
  path: string | null;
  version: string | null;
  installed: boolean;
}

export function detectClaude(): DetectedBinary {
  const path = resolveBinary([
    join(homedir(), ".local/bin/claude"),
    "claude",
  ]);
  return { path, version: versionOf(path), installed: Boolean(path) };
}

export function detectCodex(): DetectedBinary {
  const path = resolveBinary([
    join(homedir(), ".local/bin/codex"),
    "codex",
  ]);
  return { path, version: versionOf(path), installed: Boolean(path) };
}

/** Prefer Cursor agent binary; never trust bare `agent` (Grok often wins PATH). */
export function detectCursorAgent(): DetectedBinary {
  const preferred = [
    join(homedir(), ".local/share/cursor-agent/versions"),
    join(homedir(), ".local/bin/agent"),
    join(homedir(), ".local/bin/cursor-agent"),
  ];

  // If versions dir exists, resolve via ~/.local/bin/agent when it points at cursor-agent
  const localAgent = join(homedir(), ".local/bin/agent");
  if (existsSync(localAgent)) {
    const ver = versionOf(localAgent);
    if (ver && /^\d{4}\.\d{2}\.\d{2}/.test(ver) && !ver.toLowerCase().includes("grok")) {
      return { path: localAgent, version: ver, installed: true };
    }
  }

  for (const p of preferred) {
    if (!existsSync(p)) continue;
    if (p.endsWith("versions")) continue;
    const ver = versionOf(p);
    if (ver && /^\d{4}\.\d{2}\.\d{2}/.test(ver)) {
      return { path: p, version: ver, installed: true };
    }
  }

  for (const hit of whichAll("agent")) {
    if (hit.includes("cursor-agent")) {
      const ver = versionOf(hit);
      if (ver && !ver.toLowerCase().includes("grok")) {
        return { path: hit, version: ver, installed: true };
      }
    }
  }

  const ide = resolveBinary(["/opt/homebrew/bin/cursor", "cursor"]);
  if (ide) {
    return { path: ide, version: versionOf(ide), installed: true };
  }
  return { path: null, version: null, installed: false };
}

export function detectGrok(): DetectedBinary {
  const path = resolveBinary([
    join(homedir(), ".grok/bin/grok"),
    "grok",
  ]);
  return { path, version: versionOf(path), installed: Boolean(path) };
}

export function detectHermes(): DetectedBinary {
  const path = resolveBinary([
    join(homedir(), ".local/bin/hermes"),
    "hermes",
  ]);
  // hermes --version is multi-line; versionOf takes first line
  let version = versionOf(path, ["--version"]);
  if (version && version.toLowerCase().startsWith("usage:")) {
    version = versionOf(path, ["version"]);
  }
  return { path, version, installed: Boolean(path) };
}

export function pathCollisionNotes(): string[] {
  const notes: string[] = [];
  const agents = whichAll("agent");
  if (agents.length >= 2) {
    const first = agents[0]!;
    const hasGrok = agents.some((a) => a.includes(".grok"));
    const hasCursor = agents.some((a) => a.includes("cursor-agent") || a.includes(".local/bin/agent"));
    if (hasGrok && hasCursor) {
      notes.push(
        `PATH collision: \`agent\` resolves to ${first}. Cursor lives at ~/.local/bin/agent; Grok also ships \`agent\`. Prefer absolute paths or \`llmquota doctor\`.`,
      );
    }
  }
  return notes;
}
