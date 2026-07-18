#!/usr/bin/env node
import { formatStatusline, hopTarget, openHints } from "./arena-moves.js";
import { busArmAll, busDisarmAll } from "./bus-arm.js";
import {
  busAgentPrompt,
  busClearHandoff,
  busClearWork,
  busDefaultFrom,
  busIsLive,
  busLiveInfo,
  busNotifyExternal,
  busPull,
  busPullContext,
  busReadHandoff,
  busRead,
  busSend,
  busSetWork,
  busWriteHandoff,
  formatBusHandoff,
  busWatch,
  busWho,
  formatBusLine,
  formatBusReadable,
} from "./bus.js";
import { collectAll } from "./collect.js";
import { copyToClipboard } from "./clipboard.js";
import { loadLlmquotaConfig } from "./profiles.js";
import { scanInstalledClisAsync } from "./providers/detect.js";
import { formatScanRows } from "./providers/discovered.js";
import { renderDoctor, renderRefs, renderRoster } from "./render.js";
import { envDisablesMouse } from "./terminal.js";
import { runTui } from "./tui.js";
import type { CliOptions, ProviderId } from "./types.js";
import { openUsageProfile, usageProfileLabel, usageProfileUrl } from "./usage-profile.js";

function parseArgs(argv: string[]): CliOptions & {
  help: boolean;
  version: boolean;
  tui: boolean;
  once: boolean;
  refs: boolean;
  copy: string | null;
  scan: boolean;
  statusline: boolean;
  open: string | null;
  hop: boolean;
  bus: boolean;
  usage: string | null;
  openBrowser: boolean;
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
    noMouse: false,
    anon: false,
    scan: false,
    statusline: false,
    open: null as string | null,
    hop: false,
    bus: false,
    usage: null as string | null,
    openBrowser: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json" || a === "-j") opts.json = true;
    else if (a === "--plain") opts.plain = true;
    else if (a === "--style" || a === "--emoji" || a === "--style=emoji") opts.emoji = true;
    else if (a === "who" || a === "--who") opts.who = true;
    else if (a === "doctor" || a === "--doctor") opts.doctor = true;
    else if (a === "scan" || a === "--scan" || a === "detect") opts.scan = true;
    else if (a === "statusline" || a === "--statusline") opts.statusline = true;
    else if (a === "hop" || a === "--hop") opts.hop = true;
    else if (a === "bus" || a === "--bus") opts.bus = true;
    else if (a === "usage" || a === "--usage") {
      opts.usage = argv[i + 1] && !argv[i + 1]!.startsWith("-") ? argv[++i]! : "";
    } else if (a === "--open-browser" || a === "--browser") {
      opts.openBrowser = true;
    } else if (a === "open" || a === "--open") {
      // `llmquota usage foo --open` → open browser; bare `open` → launch hints
      if (opts.usage != null) {
        opts.openBrowser = true;
      } else {
        opts.open = argv[i + 1] || "";
        if (argv[i + 1]) i++;
      }
    } else if (a === "tui" || a === "--tui") opts.tui = true;
    else if (a === "--once" || a === "roster") opts.once = true;
    else if (a === "refs" || a === "referrals" || a === "--refs") opts.refs = true;
    else if (a === "--no-mouse" || a === "--nomouse") opts.noMouse = true;
    else if (a === "--anon" || a === "--anonymous") opts.anon = true;
    else if (a === "copy" || a === "--copy") {
      opts.copy = argv[i + 1] || "claude";
      if (argv[i + 1]) i++;
    } else if (a === "--refresh") opts.refresh = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
  }
  const styleIdx = argv.indexOf("--style");
  if (styleIdx >= 0 && argv[styleIdx + 1] === "emoji") opts.emoji = true;
  if (envDisablesMouse()) opts.noMouse = true;
  return opts;
}

function helpText(): string {
  return `llmquota — roster of Claude / Codex / Cursor / Grok / Hermes (Nous) rate limits

Usage:
  llmquota              live TUI arena (default in a TTY)
  llmquota tui          force TUI
  llmquota --once       one-shot text roster
  llmquota who          one-liner: who has headroom
  llmquota hop          next ring — best ready fighter (or soonest reset)
  llmquota open [name]  launch hints for a fighter (never spawns CLIs)
  llmquota usage [name] print account usage profile URL (real dates live there)
  llmquota usage [name] --open   open that https page in the browser
  llmquota statusline   one-liner for tmux / prompts / waybar
  llmquota bus          show recent ring messages
  llmquota bus send [-t all|id] [-f name] "text"   shout (id = session or cli group)
  llmquota bus pull [-f name]   unread addressed to you (or all)
  llmquota bus handoff "objective=…; state=…; files=…; tests=…; next=…"
  llmquota bus resume   read latest repo takeover checkpoint
  llmquota bus work [-f name] -m "task" <file|dir>...   publish advisory write lane
  llmquota bus done [-f name]  clear this session's write lane
  llmquota bus who      list session ids + same-directory / same-repo peers
  llmquota bus watch    tail new messages
  llmquota bus prompt   one-liner for agents (paste once per session)
  llmquota bus arm      one command — arm Claude·Codex·Cursor·Grok·Hermes for the ring
  llmquota bus disarm   remove those arm artifacts
  llmquota bus live     show whether the arena LIVE marker is set
  llmquota scan         auto-detect installed LLM CLIs on this machine
  llmquota doctor       PATH + auth + terminal/mouse diagnostics
  llmquota refs         show referral / affiliate codes
  llmquota copy <name>  copy a referral link (claude|codex|cursor|grok|hermes)
  llmquota --json       machine-readable snapshot
  llmquota --plain      no ANSI colors (text mode)
  llmquota --style emoji
  llmquota --refresh    bypass usage caches
  llmquota --no-mouse   keyboard-only TUI (also: LLMQUOTA_NO_MOUSE=1)
  llmquota --anon       start TUI with personal details hidden for screenshots

TUI: click card=focus · n hop · o open · u usage · s shout · b bus · a anon · ↵/c copy · ? help · j/k · r · q
  Enable mouse reporting (iTerm/Ghostty/Kitty). Apple Terminal: View → Allow Mouse Reporting.
  tmux/zellij fighting clicks? Use --no-mouse. Cmd/Ctrl-click opens OSC-8 ref URLs.

  # tmux status
  set -g status-right '#(llmquota statusline)'

Ring bus (cross-CLI messages):
  Shared file ~/.local/share/llmquota/bus/ring.jsonl — no daemon / no TTY inject.
  Starting the TUI sets a LIVE marker so already-open sessions can join:
    1) once:  llmquota bus arm     # Claude hook + Codex/Cursor/Hermes/Grok instructions
    2) start: llmquota             # arena LIVE
    3) Claude open session → next prompt gets unread
       other open CLIs → llmquota bus pull
  Identity: LLMQUOTA_BUS_FROM=codex  or  -f name
  Inbound shouts also toast in the arena + tmux/macOS notify.

Detection:
  Scans PATH + ~/.local/bin + common home dirs for Claude, Codex, Cursor, Grok,
  Hermes, Gemini, Ollama, Aider, Amp, Goose, OpenCode, Copilot, llm, Fabric, …
  Metered CLIs get live quota cards; others appear as detected (sideline).
  Disable extras: ~/.config/llmquota/config.json → { "detectExtraClis": false }

Multi-profile (Claude via silo):
  Discovers ~/.claude plus ~/.silo/profiles/* (https://github.com/0xNyk/silo).
  Only slots with credentials are shown by default (plus silo default).
  Optional ~/.config/llmquota/config.json:
    { "includeNeedLogin": false, "claudeProfiles": ["personal","work"] }

Hermes / Nous Portal:
  Reads ~/.hermes/auth.json (Nous OAuth) → portal.nousresearch.com/api/oauth/account
  Login: hermes portal

Grok:
  Auth via ~/.grok/auth.json. Weekly SuperGrok % is not on a stable public API —
  when unknown, llmquota shows ready/auth without inventing a fake %.
  Check real weekly pool: llmquota usage grok --open

Referrals:
  Claude auto-reads ~/.claude.json guest-pass link when available.
  Set others in ~/.config/llmquota/referrals.json

Read-only quotas. Never rotates / switches accounts (use silo for that).
Never launches CLIs — open / hop / bus are hints + files only.
usage --open may open https usage pages in the browser.
`;
}

function parseBusSendArgs(argv: string[]): { to: string; text: string; from: string } {
  let to = "all";
  let from = busDefaultFrom();
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "-t" || a === "--to") && argv[i + 1]) {
      to = argv[++i]!;
      continue;
    }
    if ((a === "-f" || a === "--from") && argv[i + 1]) {
      from = argv[++i]!;
      continue;
    }
    if (a === "send") continue;
    parts.push(a);
  }
  const text = parts.join(" ").trim();
  return { to, from, text };
}

async function runBusCommand(argv: string[], json: boolean): Promise<void> {
  const rest = argv.slice(1);
  const sub = rest[0];

  if (sub === "prompt") {
    process.stdout.write(busAgentPrompt() + "\n");
    return;
  }

  if (sub === "live") {
    const info = busLiveInfo();
    if (json) {
      process.stdout.write(JSON.stringify({ live: Boolean(info), info }, null, 2) + "\n");
      return;
    }
    if (!info) {
      process.stdout.write("arena not LIVE — start `llmquota` TUI to arm running sessions\n");
      return;
    }
    process.stdout.write(`LIVE · pid ${info.pid} · since ${info.startedAt}\n`);
    return;
  }

  if (sub === "arm") {
    const r = busArmAll();
    process.stdout.write(r.message + "\n");
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (sub === "disarm") {
    const r = busDisarmAll();
    process.stdout.write(r.message + "\n");
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (sub === "who") {
    const w = busWho();
    if (json) {
      process.stdout.write(JSON.stringify(w, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `you are: ${w.me}${w.live ? " · arena LIVE" : ""}\n` +
        `here:    ${w.workspace.cwd}` +
        (w.workspace.repo ? `  (repo ${w.workspace.project})` : "") +
        "\n",
    );
    if (w.sameDir.length) {
      process.stdout.write("same directory:\n");
      for (const s of w.sameDir) {
        process.stdout.write(`  ${s.id.padEnd(28)}  ${s.cli}\n`);
      }
    } else {
      process.stdout.write("same directory: (none else)\n");
    }
    if (w.sameRepo.length && w.sameRepo.length !== w.sameDir.length) {
      process.stdout.write("same repo:\n");
      for (const s of w.sameRepo) {
        if (w.sameDir.some((d) => d.id === s.id)) continue;
        process.stdout.write(`  ${s.id.padEnd(28)}  ${s.cwd}\n`);
      }
    }
    if (w.sessions.length) {
      process.stdout.write("all sessions (recent pull/send):\n");
      for (const s of w.sessions) {
        const mark =
          w.sameDir.some((d) => d.id === s.id) ? "⌂" : s.id === w.me ? "·" : " ";
        const loc = s.project ? s.project : "?";
        process.stdout.write(
          `  ${mark} ${s.id.padEnd(26)}  ${loc.padEnd(16)}  ${s.seenAt.slice(11, 19)}\n`,
        );
        if (s.work) {
          process.stdout.write(`      working: ${s.work.summary} · ${s.work.files.join(", ")}\n`);
        }
      }
    }
    if (w.recentFrom.length) {
      process.stdout.write(`recent from: ${w.recentFrom.join(", ")}\n`);
    }
    process.stdout.write(
      "address: -t all | -t here | -t repo | -t @project | -t claude/personal\n",
    );
    return;
  }

  if (sub === "hook-context") {
    // Used by examples/bus-hook.sh — only when LIVE; identity from env / CLAUDE_CONFIG_DIR
    process.stdout.write(busPullContext(undefined, { onlyWhenLive: true }));
    return;
  }

  if (sub === "handoff") {
    if (rest[1] === "clear") {
      const cleared = busClearHandoff();
      if (json) process.stdout.write(JSON.stringify({ cleared }) + "\n");
      else process.stdout.write(cleared ? "handoff cleared\n" : "no handoff for this repo\n");
      return;
    }
    const { from, text } = parseBusSendArgs(["send", ...rest.slice(1)]);
    if (!text) {
      process.stderr.write(
        'usage: llmquota bus handoff [-f name] "objective=…; state=…; files=…; tests=…; next=…"\n',
      );
      process.exitCode = 1;
      return;
    }
    const handoff = busWriteHandoff({ text, from });
    busSend({
      from: handoff.from,
      to: "repo",
      text: `takeover checkpoint updated for ${handoff.project} · run: llmquota bus resume`,
    });
    if (json) process.stdout.write(JSON.stringify(handoff, null, 2) + "\n");
    else process.stdout.write(formatBusHandoff(handoff) + "\n");
    return;
  }

  if (sub === "resume") {
    const handoff = busReadHandoff();
    if (json) {
      process.stdout.write(JSON.stringify({ handoff }, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      handoff
        ? formatBusHandoff(handoff) + "\n"
        : "no takeover checkpoint for this repo · inspect git status and current task\n",
    );
    return;
  }

  if (sub === "work") {
    let from: string | undefined;
    let summary = "";
    const files: string[] = [];
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i]!;
      if ((a === "-f" || a === "--from") && rest[i + 1]) from = rest[++i]!;
      else if ((a === "-m" || a === "--message") && rest[i + 1]) summary = rest[++i]!;
      else files.push(a);
    }
    if (!summary || !files.length) {
      process.stderr.write('usage: llmquota bus work [-f name] -m "task" <file|dir>...\n');
      process.exitCode = 1;
      return;
    }
    const result = busSetWork({ summary, files, from });
    busSend({
      from: result.presence.id,
      to: "repo",
      text: `working: ${result.presence.work!.summary} · files: ${result.presence.work!.files.join(", ")}`,
    });
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      process.stdout.write(`work published · ${result.presence.work!.files.join(", ")}\n`);
      for (const peer of result.conflicts) {
        process.stdout.write(`WARNING overlap with ${peer.id}: ${peer.work!.files.join(", ")}\n`);
      }
    }
    return;
  }

  if (sub === "done") {
    let from: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      if ((rest[i] === "-f" || rest[i] === "--from") && rest[i + 1]) from = rest[++i]!;
    }
    const cleared = busClearWork(from);
    if (json) process.stdout.write(JSON.stringify({ cleared }) + "\n");
    else process.stdout.write(cleared ? "work lane cleared\n" : "no active work lane\n");
    return;
  }

  if (sub === "pull") {
    let from: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i]!;
      if ((a === "-f" || a === "--from") && rest[i + 1]) {
        from = rest[++i]!;
      }
    }
    const { messages, live, offset, me } = busPull({ from });
    if (json) {
      process.stdout.write(JSON.stringify({ live, me, offset, messages }, null, 2) + "\n");
      return;
    }
    if (!messages.length) {
      process.stdout.write(
        live
          ? `bus: no unread for ${me} (arena LIVE)\n`
          : `bus: no unread for ${me} — start llmquota TUI to go LIVE\n`,
      );
      return;
    }
    process.stdout.write(
      (live ? "arena LIVE · " : "") + `unread for ${me}:\n` + formatBusReadable(messages),
    );
    return;
  }

  if (sub === "send") {
    const { to, from, text } = parseBusSendArgs(rest);
    if (!text) {
      process.stderr.write('usage: llmquota bus send [-t all|id] [-f name] "message"\n');
      process.exitCode = 1;
      return;
    }
    const msg = busSend({ text, to, from });
    if (busIsLive()) busNotifyExternal(`${msg.from}: ${msg.text}`);
    if (json) {
      process.stdout.write(JSON.stringify(msg, null, 2) + "\n");
      return;
    }
    process.stdout.write(`sent → ${formatBusLine(msg)}\n`);
    return;
  }

  if (sub === "watch") {
    process.stdout.write("watching ~/.local/share/llmquota/bus/ring.jsonl (Ctrl-C quit)\n");
    const ac = new AbortController();
    const onSig = (): void => ac.abort();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    await busWatch(
      (m) => {
        process.stdout.write(formatBusLine(m) + "\n");
      },
      { signal: ac.signal },
    );
    return;
  }

  const msgs = busRead(30);
  if (json) {
    process.stdout.write(
      JSON.stringify({
        path: "~/.local/share/llmquota/bus/ring.jsonl",
        live: busIsLive(),
        messages: msgs,
      }, null, 2) + "\n",
    );
    return;
  }
  if (busIsLive()) process.stdout.write("arena LIVE\n");
  process.stdout.write(formatBusReadable(msgs));
}

function findProvider(report: Awaited<ReturnType<typeof collectAll>>, q: string) {
  const needle = q.toLowerCase();
  return (
    report.providers.find(
      (x) =>
        x.id === needle ||
        x.displayName.toLowerCase() === needle ||
        x.profileId.toLowerCase() === needle ||
        `${x.id}:${x.profileId}`.toLowerCase() === needle,
    ) || report.providers.find((x) => x.id === (needle as ProviderId))
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(helpText());
    return;
  }
  if (opts.version) {
    process.stdout.write("llmquota 0.1.0\n");
    return;
  }

  if (opts.bus) {
    await runBusCommand(argv, opts.json);
    return;
  }

  const wantTui =
    opts.tui ||
    (!opts.once &&
      !opts.json &&
      !opts.who &&
      !opts.doctor &&
      !opts.scan &&
      !opts.refs &&
      !opts.copy &&
      !opts.statusline &&
      !opts.hop &&
      opts.open == null &&
      opts.usage == null &&
      !opts.plain &&
      Boolean(process.stdout.isTTY) &&
      Boolean(process.stdin.isTTY));

  if (wantTui) {
    await runTui({ refresh: opts.refresh, noMouse: opts.noMouse, anon: opts.anon });
    return;
  }

  if (opts.scan) {
    const cfg = loadLlmquotaConfig();
    const hits = await scanInstalledClisAsync({
      includeMissing: Boolean(cfg.scanIncludeMissing) || process.argv.includes("--all"),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(), clis: hits }, null, 2) + "\n");
      return;
    }
    const metered = hits.filter((h) => h.metered && h.installed).length;
    const extra = hits.filter((h) => !h.metered && h.installed).length;
    process.stdout.write(
      `llmquota scan — ${hits.filter((h) => h.installed).length} installed` +
        ` (${metered} metered · ${extra} detected)\n` +
        `● metered (live quota)  ○ detected (no probe yet)\n\n`,
    );
    process.stdout.write(formatScanRows(hits) + "\n");
    if (!hits.some((h) => h.installed)) {
      process.stdout.write("\nNo LLM CLIs found. Install Claude Code, Codex, Cursor, Grok, or Hermes.\n");
    }
    return;
  }

  const report = await collectAll({ refresh: opts.refresh });

  if (opts.statusline) {
    process.stdout.write(formatStatusline(report) + "\n");
    return;
  }

  if (opts.hop) {
    const hop = hopTarget(report.providers, -1);
    if (!hop) {
      process.stdout.write("nowhere to hop\n");
      process.exitCode = 1;
      return;
    }
    const p = report.providers[hop.index]!;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ index: hop.index, id: p.id, reason: hop.reason }, null, 2) + "\n",
      );
      return;
    }
    process.stdout.write(`${hop.reason}\n`);
    return;
  }

  if (opts.open != null) {
    const q = opts.open.trim();
    const p = q
      ? findProvider(report, q)
      : report.providers.find((x) => x.id === report.pick.id) || report.providers[0];
    if (!p) {
      process.stderr.write(`unknown fighter: ${q || "(none)"}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(openHints(p).join("\n") + "\n");
    return;
  }

  if (opts.usage != null) {
    const q = opts.usage.trim();
    const p = q
      ? findProvider(report, q)
      : report.providers.find((x) => x.id === report.pick.id) || report.providers[0];
    if (!p) {
      process.stderr.write(`unknown fighter: ${q || "(none)"}\n`);
      process.exitCode = 1;
      return;
    }
    const url = usageProfileUrl(p);
    if (!url) {
      process.stderr.write(`no usage profile URL for ${p.displayName}\n`);
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ id: p.id, url, label: usageProfileLabel(p) }, null, 2) + "\n");
      return;
    }
    process.stdout.write(`${usageProfileLabel(p)}\n`);
    if (opts.openBrowser) {
      const r = openUsageProfile(url);
      if (!r.ok) {
        process.stderr.write(`open failed: ${r.error}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write("opened in browser\n");
    }
    return;
  }

  if (opts.copy) {
    const p = findProvider(report, opts.copy);
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
