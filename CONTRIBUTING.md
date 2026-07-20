# Contributing

Thanks for the interest. Issues and PRs are welcome. Collectors depend on undocumented vendor endpoints, so real-world breakage reports are especially useful.

## Dev

```bash
pnpm install
pnpm build            # compile to dist/
./llmquota            # run the arena
./llmquota --json     # scriptable output
pnpm test             # tsc + the whole suite
```

Node **22+** required (`node:sqlite`).

## Scope

- Read-only usage / install / auth status across Claude · Codex · Cursor · Grok · Hermes
- Fun human roster + deadpan `--json`
- **Out of scope:** account switching, menubar apps, burning unused budget

## Provider changes

Vendor usage APIs are often undocumented. Prefer:

1. Fail soft (installed/auth known, meters optional)
2. Cache aggressive polls (especially Claude OAuth usage)
3. Document the endpoint in the PR description

## Security and fixtures

Use synthetic identities and platform-neutral temporary paths in tests. Never commit credentials,
real account output, personal home paths, or private project names. Report suspected vulnerabilities
through a private GitHub security advisory, as described in [SECURITY.md](SECURITY.md).
