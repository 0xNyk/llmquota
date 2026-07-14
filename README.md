# llmquota

Fun terminal **roster** for Claude Code · Codex · Cursor · Grok · **Hermes (Nous Portal)** rate limits — who's installed, what's left on the plan, and when you can fight again.

```bash
pnpm install
pnpm build            # once (or after pulling src changes)
./llmquota              # live TUI arena (default)
./llmquota --once       # classic one-shot text
./llmquota who          # one-liner pick
./llmquota hop          # next best ready fighter
./llmquota usage        # account usage profile URL (pick)
./llmquota usage grok --open   # open real SuperGrok usage page
./llmquota bus          # cross-CLI ring messages
./llmquota doctor       # PATH + auth + terminal/mouse probe
./llmquota --no-mouse   # keyboard-only arena (tmux/zellij-friendly)
./llmquota --json       # scripts / statuslines
```

Requires **Node 22+** (uses built-in `node:sqlite` for Cursor).

### Ring bus (talk across open CLIs)

Shared mailbox at `~/.local/share/llmquota/bus/ring.jsonl` — no daemon, no TTY inject.

**Already-running sessions** join when the arena is LIVE:

```bash
# one command — arms Claude · Codex · Cursor · Grok · Hermes
./llmquota bus arm

# then start the arena — sets LIVE marker + announces on the ring
./llmquota
```

| CLI | After `bus arm` |
|---|---|
| **Claude** | Hook injects unread on the **next prompt** (even in an open session) |
| **Codex / Cursor / Grok / Hermes** | Instructions/rules/skills for **new** sessions; open ones run `llmquota bus pull` |

**Addressing (multi-session):** each session needs a unique id (`claude/personal`, `codex#ttys004`). Auto from `CLAUDE_CONFIG_DIR` / tty, or set `LLMQUOTA_BUS_FROM`. Presence also records **cwd + git repo** so peers in the same directory show up.

```bash
llmquota bus who                          # list ids + same-directory peers
llmquota bus send -t all "broadcast"
llmquota bus send -t here "only sessions in this cwd"
llmquota bus send -t repo "same git root"
llmquota bus send -t @myskills "same project name"
llmquota bus send -t claude "all Claude sessions"
llmquota bus send -t claude/work "one silo"
LLMQUOTA_BUS_FROM=claude/personal llmquota bus pull
```

```bash
./llmquota bus send -t all "auth module ready — check types"
./llmquota bus                 # last ~30 messages
./llmquota bus pull -f codex   # unread for an open non-Claude CLI
./llmquota bus live            # is the arena LIVE?
./llmquota bus disarm          # undo arm
```

Inbound shouts toast in the TUI and fire a tmux banner / macOS notification when LIVE.

TUI: `s` shout · `b` toggle bus strip (auto-opens on new traffic).

### Detect installed CLIs

```bash
./llmquota scan          # every known LLM CLI found on this machine
./llmquota scan --json   # machine-readable
./llmquota scan --all    # include catalog entries not installed
```

Scans PATH, `~/.local/bin`, Homebrew, and common home dirs. **Metered** CLIs (Claude · Codex · Cursor · Grok · Hermes) get live quota cards; others (Ollama, Gemini, Aider, …) appear as detected sidelined fighters. Opt out with `"detectExtraClis": false` in `~/.config/llmquota/config.json`.

### Interactive arena

| Input | Action |
|---|---|
| Click card | Focus fighter |
| Click ref / refs strip | Copy referral link |
| Double-click card | Copy that fighter’s ref |
| Hover | Soft highlight (`◇`); focus uses `◆` |
| Wheel | Cycle focus |
| `↵` / `c` | Copy focused ref |
| `n` | Hop → best ready fighter |
| `o` | Open launch hints |
| `u` | Open focused fighter’s usage profile (browser) |
| `s` | Shout to ring bus |
| `b` | Toggle bus strip |
| `j` `k` / `tab` / `1–9` | Move focus |
| `h` | Toggle sidelined |
| `?` | Help overlay |
| `r` / `q` | Refresh / quit |

Cmd/Ctrl-click OSC-8 ref URLs in Ghostty / iTerm / Kitty / WezTerm.

**Mouse reporting:** enable in the emulator (iTerm: Profiles → Terminal → Enable mouse reporting; Apple Terminal: View → Allow Mouse Reporting ⌘R).

**tmux / zellij:** if clicks fight the multiplexer (`[<0;12;5M` junk), run `llmquota --no-mouse` or set `LLMQUOTA_NO_MOUSE=1`. Recommended tmux:

```tmux
set -g mouse on
set -g allow-passthrough on
```

Arena fills the terminal (btop-style): usage waves (fill = %, │ = time elapsed), live countdown (~45s refresh).

### Signature moves

| Command / key | What |
|---|---|
| `n` / `llmquota hop` | Jump to the best ready fighter (or soonest reset) |
| `o` / `llmquota open [name]` | Print launch hints (`silo go …`, `codex`, …) — never spawns CLIs |
| `u` / `llmquota usage [name] [--open]` | Usage profile URL; `--open` opens https in the browser |
| `llmquota statusline` | One-liner for tmux / prompts (`set -g status-right '#(llmquota statusline)'`) |
| pace ⚠ on cards | Warns when burn rate would fill a window before reset |

Loading screen: centered brand + waves + **smoky edge texture** + silo-style probe lamps (`●cl ◉co …`).

If `pnpm install` asks about build scripts, allow **esbuild** (needed by the optional `tsx` dev runner). The project already has `pnpm-workspace.yaml` → `allowBuilds.esbuild: true`.

```bash
# optional: put on PATH
ln -sfn "$(pwd)/llmquota" ~/.local/bin/llmquota
```

## What you get

- Installed? · auth? · plan? · % used · cooldown / **calendar reset** (from usage APIs)
- `who` / `hop` → which CLI has the most headroom
- `usage` → open each account’s real usage profile page
- `bus` → cross-CLI ring messages (shared JSONL mailbox; auto-shows in TUI)
- `doctor` → PATH collisions + TERM/tmux/mouse capability probe
- `--no-mouse` → keyboard-only TUI when mux steals clicks

## Sources

| Provider | How |
|---|---|
| Claude | `~/.claude` + each [silo](https://github.com/0xNyk/silo) profile under `~/.silo/profiles/*` → refresh via `platform.claude.com` → OAuth usage (cached ~90s). Keychain only for the default slot. |
| Codex | `~/.codex/auth.json` → ChatGPT WHAM usage |
| Cursor | Cursor `state.vscdb` token → dashboard period usage |
| Grok | `~/.grok/auth.json` OIDC → `api.x.ai/v1/models` probe. Weekly SuperGrok % has no stable public API — no invented meters/scores; `llmquota usage grok --open` → Settings. |
| Hermes | `~/.hermes/auth.json` Nous OAuth → `portal.nousresearch.com/api/oauth/account` (subscription + credits). Login: `hermes portal`. |

**Read-only.** No account switching (use **silo** to launch Claude as a profile).

### Multi-profile config

Optional `~/.config/llmquota/config.json`:

```json
{
  "includeClaudeDefault": true,
  "includeNeedLogin": false,
  "claudeProfiles": ["personal", "work"]
}
```

- Default: show `~/.claude` plus silo profiles that already have credentials (and the silo default even if empty).
- Set `includeNeedLogin: true` to list every silo shell waiting on `silo auth login`.
- `claudeProfiles` allowlists silo names when set.

## Privacy / OSS stance

Currently a **private** repo while the collectors stabilize. MIT-licensed and structured to go public without a rewrite: no secrets in tree, documented undocumented APIs, fail-soft providers.

## Referrals / affiliate codes

```bash
llmquota refs              # list codes + links
llmquota copy claude       # copy to clipboard (pbcopy on macOS)
```

- **Claude** — auto-detected from `~/.claude.json` guest passes (`/passes`) when eligible
- **Cursor / Codex / Grok** — set in `~/.config/llmquota/referrals.json` (see `examples/referrals.json`)

TUI: click / double-click / wheel / hover — or focus with `1`–`9`, then `c` / `↵` to copy.

## Optional Claude Code statusline

```bash
# ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/llmquota/examples/statusline.sh"
  }
}
```

## Related tools

SessionWatcher (menubar), aistat, aiquota, tokmon — peers, not dependencies.
