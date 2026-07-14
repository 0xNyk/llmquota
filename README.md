# llmquota

Fun terminal **roster** for Claude Code · Codex · Cursor · Grok rate limits — who's installed, what's left on the plan, and when you can fight again.

```bash
pnpm install
pnpm build            # once (or after pulling src changes)
./llmquota              # roster
./llmquota who          # one-liner pick
./llmquota doctor       # PATH + auth
./llmquota --json       # scripts / statuslines
```

Requires **Node 22+** (uses built-in `node:sqlite` for Cursor).

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
| Claude | Keychain / `.credentials.json` → Anthropic OAuth usage (cached ~90s) |
| Codex | `~/.codex/auth.json` → ChatGPT WHAM usage |
| Cursor | Cursor `state.vscdb` token → dashboard period usage |
| Grok | `~/.grok/auth.json` JWT + API probe (SuperGrok weekly pool not on a stable public endpoint yet) |

**Read-only.** No account switching.

## Privacy / OSS stance

Currently a **private** repo while the collectors stabilize. MIT-licensed and structured to go public without a rewrite: no secrets in tree, documented undocumented APIs, fail-soft providers.

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
