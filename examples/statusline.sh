#!/usr/bin/env bash
# Optional Claude Code statusLine command — shows llmquota pick + compact scores.
# In ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "/path/to/llmquota/examples/statusline.sh" }
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${LLLMQUOTA_BIN:-$ROOT/llmquota}"
if [[ ! -x "$BIN" ]]; then
  BIN="$(command -v llmquota || true)"
fi
if [[ -z "$BIN" ]]; then
  echo "llmquota?"
  exit 0
fi

json="$("$BIN" --json 2>/dev/null || true)"
if [[ -z "$json" ]]; then
  echo "llmquota err"
  exit 0
fi

# Prefer jq if present; else python
if command -v jq >/dev/null 2>&1; then
  pick="$(echo "$json" | jq -r '.pick.line // empty')"
  compact="$(echo "$json" | jq -r '
    .providers
    | map(select(.installed))
    | map(
        .id[0:1]
        + (if .score == null then "?" else ((.score|floor)|tostring) end)
      )
    | join(" ")
  ')"
else
  pick="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("pick",{}).get("line",""))' <<<"$json")"
  compact="$(python3 -c '
import json,sys
d=json.load(sys.stdin)
parts=[]
for p in d.get("providers",[]):
  if not p.get("installed"): continue
  s=p.get("score")
  parts.append(p["id"][0]+("?" if s is None else str(int(s))))
print(" ".join(parts))
' <<<"$json")"
fi

# statusline is width-sensitive — keep short
echo "${compact} · ${pick#→ }"
