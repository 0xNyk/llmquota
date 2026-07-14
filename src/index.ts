#!/usr/bin/env node
import { collectAll } from "./collect.js";
import { copyToClipboard } from "./clipboard.js";
import { renderDoctor, renderRefs, renderRoster } from "./render.js";
import { runTui } from "./tui.js";
import type { CliOptions, ProviderId } from "./types.js";

function parseArgs(argv: string[]): CliOptions & {
  help: boolean;
  version: boolean;
  tui: boolean;
  once: boolean;
  refs: boolean;
  copy: string | null;
} {
  const opts = {
    json: false,
    plain: false,
    emoji: false,
    who: false,
    doctor: false,
    refresh: false,
    help: false,
    version: false,
    tui: false,
    once: false,
    refs: false,
    copy: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json" || a === "-j") opts.json = true;
    else if (a === "--plain") opts.plain = true;
    else if (a === "--style" || a === "--emoji" || a === "--style=emoji") opts.emoji = true;
    else if (a === "who" || a === "--who") opts.who = true;
    else if (a === "doctor" || a === "--doctor") opts.doctor = true;
    else if (a === "tui" || a === "--tui") opts.tui = true;
    else if (a === "--once" || a === "roster") opts.once = true;
    else if (a === "refs" || a === "referrals" || a === "--refs") opts.refs = true;
    else if (a === "copy" || a === "--copy") {
      opts.copy = argv[i + 1] || "claude";
      if (argv[i + 1]) i++;
    } else if (a === "--refresh") opts.refresh = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
  }
  const styleIdx = argv.indexOf("--style");
  if (styleIdx >= 0 && argv[styleIdx + 1] === "emoji") opts.emoji = true;
  return opts;
}

function helpText(): string {
  return `llmquota — roster of Claude / Codex / Cursor / Grok rate limits

Usage:
  llmquota              live TUI arena (default in a TTY)
  llmquota tui          force TUI
  llmquota --once       one-shot text roster
  llmquota who          one-liner: who has headroom
  llmquota doctor       PATH + auth diagnostics
  llmquota refs         show referral / affiliate codes
  llmquota copy <name>  copy a referral link (claude|codex|cursor|grok)
  llmquota --json       machine-readable snapshot
  llmquota --plain      no ANSI colors (text mode)
  llmquota --style emoji
  llmquota --refresh    bypass Claude usage cache (~90s)

TUI keys:  1-9 focus  ·  tab next  ·  c copy ref  ·  r refresh  ·  q quit

Multi-profile (Claude via silo):
  Discovers ~/.claude plus ~/.silo/profiles/* (https://github.com/0xNyk/silo).
  Only slots with credentials are shown by default (plus silo default).
  Optional ~/.config/llmquota/config.json:
    { "includeNeedLogin": false, "claudeProfiles": ["personal","work"] }

Referrals:
  Claude auto-reads ~/.claude.json guest-pass link when available.
  Set others in ~/.config/llmquota/referrals.json

Read-only. Never rotates / switches accounts (use silo for that).
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

  const wantTui =
    opts.tui ||
    (!opts.once &&
      !opts.json &&
      !opts.who &&
      !opts.doctor &&
      !opts.refs &&
      !opts.copy &&
      !opts.plain &&
      Boolean(process.stdout.isTTY) &&
      Boolean(process.stdin.isTTY));

  if (wantTui) {
    await runTui({ refresh: opts.refresh });
    return;
  }

  const report = await collectAll({ refresh: opts.refresh });

  if (opts.copy) {
    const q = opts.copy.toLowerCase();
    const p =
      report.providers.find(
        (x) =>
          x.id === q ||
          x.displayName.toLowerCase() === q ||
          x.profileId.toLowerCase() === q ||
          `${x.id}:${x.profileId}`.toLowerCase() === q,
      ) || report.providers.find((x) => x.id === (q as ProviderId));
    if (!p) {
      process.stderr.write(`unknown provider/profile: ${opts.copy}\n`);
      process.exitCode = 1;
      return;
    }
    const payload = p.referral?.link || p.referral?.label || p.referral?.code;
    if (!payload) {
      process.stderr.write(
        `no referral for ${p.displayName}. Set ~/.config/llmquota/referrals.json or open Claude /passes.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (copyToClipboard(payload)) {
      process.stdout.write(`copied ${p.displayName} referral to clipboard\n${payload}\n`);
    } else {
      process.stdout.write(`${payload}\n`);
      process.stderr.write("(clipboard unavailable — printed link above)\n");
    }
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  if (opts.refs) {
    process.stdout.write(renderRefs(report, opts));
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
