# Releasing

Checklist for cutting a release. Owner-only steps are marked **(owner)**.

## 1. Pre-flight (must be green)

```bash
pnpm install
pnpm test          # tsc + full suite; must exit 0
pnpm -s build      # clean tsc, no errors
```

Leak / identifier gate (no secrets, no personal paths, no private names):

```bash
bash /path/to/agent-security/scripts/scan-repo.sh --all --gitleaks
gitleaks git --redact --config .gitleaks.toml
```

Synthetic fixtures use temporary paths and reserved example identities. Any unexplained finding
blocks the release.

## 2. Version + changelog

- Bump `version` in `package.json` (SemVer).
- Add a dated section to `CHANGELOG.md` matching that version.
- Keep `description`, `keywords`, `repository`, `homepage`, and `bugs` accurate.

## 3. Confirm public release (owner)

- **(owner)** Confirm the complete reachable history was scanned after any rewrite.
- **(owner)** Flip the GitHub repo to public only after reviewing the final tree, commit metadata,
  branch protection, secret scanning, and private vulnerability reporting.

## 4. Tag

```bash
git tag -s v0.1.0 -m "llmquota 0.1.0"    # signed tag
git push origin v0.1.0
```

## 5. npm publish (optional distribution)

The primary install path is git clone + `pnpm build` (see README). The package
is *also* publish-safe if you want it on npm:

- `bin` → `./llmquota` (bash launcher that runs `dist/index.js`).
- `files` allowlist ships `dist/`, the launcher, `examples/`, and docs, and
  **excludes** `src/` and compiled `*.test.js` (verify with `npm pack --dry-run`).
- `prepublishOnly` runs `pnpm test`, so a broken or untested build can't ship.

```bash
npm pack --dry-run      # sanity-check tarball contents (~80 files, dist only)
pnpm publish            # runs prepublishOnly (pnpm test) first
```

> Note: consumers installing from npm get the compiled `dist/`; `tsx` is a
> devDependency and is not needed at runtime. Requires Node 22+ (`node:sqlite`).
