# Contributing

Thanks for interest. This repo is **private** while collectors stabilize; contributions are welcome from collaborators with access.

## Dev

```bash
pnpm install
./llmquota
./llmquota --json
./node_modules/.bin/tsc --noEmit
```

Node **22+** required (`node:sqlite`).

## Scope

- Read-only usage / install / auth status across Claude · Codex · Cursor · Grok
- Fun human roster + deadpan `--json`
- **Out of scope:** account switching, menubar apps, burning unused budget

## Provider changes

Vendor usage APIs are often undocumented. Prefer:

1. Fail soft (installed/auth known, meters optional)
2. Cache aggressive polls (especially Claude OAuth usage)
3. Document the endpoint in the PR description

## Going public later

When visibility flips to public: keep MIT, no secrets in fixtures, scrub any personal paths from docs.
