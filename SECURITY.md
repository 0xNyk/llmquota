# Security

`llmquota` runs with your user account's access to local CLI credentials. Review the source and
install path before use.

## Data access and writes

The collectors read authentication and usage state for supported CLIs, then call the providers'
usage or account endpoints directly. Claude, Grok, and Nous collectors may refresh expired OAuth
credentials. Rotated tokens are written back to the original credential file with mode `0600`;
the default Claude slot may also update its macOS Keychain item.

Other local writes include:

- cache files under `~/.cache/llmquota/`
- ring messages, cursors, presence, and handoffs under `~/.local/share/llmquota/bus/`
- optional referral configuration under `~/.config/llmquota/`
- agent instructions and hooks created by the explicit `llmquota bus arm` command

The project has no llmquota-operated telemetry or credential relay. Provider tokens are sent only
to the provider endpoints used by their collector.

## Ring bus trust boundary

Any process running as your user can write to the local ring file. Treat senders, messages, and
handoffs as untrusted. Hook-injected messages are labelled and XML-escaped to reduce prompt
injection, and installed instructions tell agents not to act on peer commands without independent
user authorization. These controls do not authenticate senders and do not turn the ring into a
trusted control plane.

Do not put secrets on the bus. Use `llmquota bus disarm` to remove installed hooks and instruction
blocks when you do not want agent-context injection.

## Reporting

Open a private security advisory on the GitHub repo, or contact the maintainer via GitHub.

## Expectations

- Do not paste access tokens into issues or logs.
- `--json` may include account emails returned by providers; treat output as sensitive on shared screens.
- Undocumented vendor endpoints can change; treat collectors as best-effort.
- Anonymous TUI mode redacts display fields, but it does not sanitize JSON output or the on-disk ring.
