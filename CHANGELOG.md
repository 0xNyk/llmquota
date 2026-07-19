# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-19

First public release.

### Providers
- Live quota, auth, and active-model detection for **Claude Code**, **Codex**,
  **Cursor**, **Grok** (SuperGrok), and **Hermes** (Nous Portal).
- Fail-soft collectors: a provider that can't be read is marked unknown, never
  guessed. Undocumented vendor endpoints are cached to avoid hammering.
- `scan` detects every known LLM CLI on the machine; metered ones get live
  cards, the rest appear as sidelined fighters.

### Arena (TUI)
- Full-viewport, btop-style roster with quota bars, pace warnings, sparklines,
  and live countdowns to the real reset.
- Mouse + keyboard interaction, OSC-8 referral links, `--no-mouse` for
  tmux/zellij, and `--anon` screenshot-safe mode.
- `--once` one-shot text and `--json` for scripts and statuslines.

### Cross-CLI ring bus
- Optional shared JSONL mailbox (`~/.local/share/llmquota/bus/`) for
  coordinating multiple open coding CLIs — no daemon, no TTY injection.
- `bus arm` wires per-CLI hooks/rules so already-running and new sessions can
  send, pull, and see same-directory / same-repo peers.
- Advisory work claims (`bus work`) and repo-scoped handoffs (`bus handoff` /
  `bus resume`) for rate-limit takeover between sessions.

### Verbs
- `who`, `hop`, `usage`, `open`, `refs`, `copy`, `statusline`, `doctor`.

[0.1.0]: https://github.com/0xNyk/llmquota/releases/tag/v0.1.0
