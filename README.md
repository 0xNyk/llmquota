# llmquota

Fun terminal **roster** for Claude Code · Codex · Cursor · Grok · **Hermes (Nous Portal)** rate limits — who's installed, what's left on the plan, and when you can fight again.

```bash
pnpm install
pnpm build            # once (or after pulling src changes)
./llmquota              # live TUI arena (default)
./llmquota --once       # classic one-shot text
./llmquota who          # one-liner pick
./llmquota doctor       # PATH + auth
./llmquota --json       # scripts / statuslines
```

Requires **Node 22+** (uses built-in `node:sqlite` for Cursor).

TUI keys: **`1–9` / `tab` / `j` `k`** focus · **`c`** copy ref · **`h`** sidelined · **`r`** refresh · **`q`** quit (auto-refresh ~45s).

If `pnpm install` asks about build scripts, allow **esbuild** (needed by the optional `tsx` dev runner). The project already has `pnpm-workspace.yaml` → `allowBuilds.esbuild: true`.

```bash
# optional: put on PATH
ln -sfn "$(pwd)/llmquota" ~/.local/bin/llmquota
```

## What you get

- Installed? · auth? · plan? · % used · cooldown / reset
- `who` → which CLI has the most headroom right now
- `doctor` → PATH collision when both Grok and Cursor ship `agent`

## Sources

| Provider | How |
|---|---|
| Claude | `~/.claude` + each [silo](https://github.com/0xNyk/silo) profile under `~/.silo/profiles/*` → refresh via `platform.claude.com` → OAuth usage (cached ~90s). Keychain only for the default slot. |
| Codex | `~/.codex/auth.json` → ChatGPT WHAM usage |
| Cursor | Cursor `state.vscdb` token → dashboard period usage |
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

TUI: focus with `1`–`4`, then `c` to copy that provider’s referral link.

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
