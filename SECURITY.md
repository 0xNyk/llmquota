# Security

`llmquota` is **read-only**. It reads local CLI credential stores and calls provider usage endpoints. It does **not** refresh, rewrite, or rotate accounts.

## Reporting

Open a private security advisory on the GitHub repo, or contact the maintainer via GitHub.

## Expectations

- Do not paste access tokens into issues or logs.
- `--json` may include account emails returned by providers; treat output as sensitive on shared screens.
- Undocumented vendor endpoints can change; treat collectors as best-effort.
