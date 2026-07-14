#!/usr/bin/env node
import { collectAll } from "./collect.js";
import { renderDoctor, renderRoster } from "./render.js";
import type { CliOptions } from "./types.js";

function parseArgs(argv: string[]): CliOptions & { help: boolean; version: boolean } {
  const opts = {
    json: false,
    plain: false,
    emoji: false,
    who: false,
    doctor: false,
    refresh: false,
    help: false,
    version: false,
  };
  for (const a of argv) {
    if (a === "--json" || a === "-j") opts.json = true;
    else if (a === "--plain") opts.plain = true;
    else if (a === "--style" || a === "--emoji" || a === "--style=emoji") opts.emoji = true;
    else if (a === "who" || a === "--who") opts.who = true;
    else if (a === "doctor" || a === "--doctor") opts.doctor = true;
    else if (a === "--refresh") opts.refresh = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--style=emoji") opts.emoji = true;
  }
  // support: --style emoji
  const styleIdx = argv.indexOf("--style");
  if (styleIdx >= 0 && argv[styleIdx + 1] === "emoji") opts.emoji = true;
  return opts;
}

function helpText(): string {
  return `llmquota — roster of Claude / Codex / Cursor / Grok rate limits

Usage:
  llmquota              fun human roster (default)
  llmquota who          one-liner: who has headroom
  llmquota doctor       PATH + auth diagnostics
  llmquota --json       machine-readable snapshot
  llmquota --plain      no ANSI colors
  llmquota --style emoji
  llmquota --refresh    bypass Claude usage cache (~90s)

Read-only. Never rotates accounts (that's silo / aistat territory).
`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(helpText());
    return;
  }
  if (opts.version) {
    process.stdout.write("llmquota 0.1.0\n");
    return;
  }

  const report = await collectAll({ refresh: opts.refresh });

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  if (opts.doctor) {
    process.stdout.write(renderDoctor(report, opts));
    return;
  }

  process.stdout.write(renderRoster(report, opts));

  const hardErrors = report.providers.filter(
    (p) => p.installed && p.auth === "error" && p.error,
  );
  if (hardErrors.length && !report.providers.some((p) => p.auth === "ok" && p.windows.length)) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`llmquota failed: ${msg}\n`);
  process.exitCode = 1;
});
