#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook — inject unread llmquota ring messages
# when the arena is LIVE. Installed by: llmquota bus arm
# Path must contain "llmquota-bus" for arm/disarm detection.
set -euo pipefail

LIVE="${HOME}/.local/share/llmquota/bus/LIVE"
if [[ ! -f "$LIVE" ]]; then
  exit 0
fi

BIN=""
if command -v llmquota >/dev/null 2>&1; then
  BIN="$(command -v llmquota)"
elif [[ -n "${LLMQUOTA_BIN:-}" && -x "${LLMQUOTA_BIN}" ]]; then
  BIN="$LLMQUOTA_BIN"
elif [[ -x "${HOME}/dev/llmquota/llmquota" ]]; then
  BIN="${HOME}/dev/llmquota/llmquota"
elif [[ -x "/path/to/llmquota/llmquota" ]]; then
  BIN="/path/to/llmquota/llmquota"
fi

if [[ -z "$BIN" ]]; then
  exit 0
fi

export LLMQUOTA_BUS_FROM="${LLMQUOTA_BUS_FROM:-claude}"
ctx="$("$BIN" bus hook-context 2>/dev/null || true)"
if [[ -z "${ctx// }" ]]; then
  exit 0
fi

# UserPromptSubmit: stdout is added to Claude's context
printf '%s\n' "$ctx"
exit 0
