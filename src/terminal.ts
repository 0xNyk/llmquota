/**
 * Terminal / mux capability probe for doctor + TUI mouse decisions.
 */

export interface TerminalProbe {
  term: string;
  colorterm: string | null;
  tty: boolean;
  stdinTty: boolean;
  tmux: boolean;
  zellij: boolean;
  ssh: boolean;
  /** Guessed emulator from env (best-effort). */
  emulator: string;
  /** Whether we expect SGR mouse to work if the emulator allows it. */
  mouseLikely: boolean;
  /** User/env asked to disable mouse. */
  mouseDisabledByEnv: boolean;
  tips: string[];
}

function detectEmulator(): string {
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM;
  if (process.env.WT_SESSION) return "Windows Terminal";
  if (process.env.KITTY_WINDOW_ID) return "kitty";
  if (process.env.WEZTERM_EXECUTABLE || process.env.WEZTERM_PANE) return "WezTerm";
  if (process.env.GHOSTTY_RESOURCES_DIR || process.env.GHOSTTY_SHELL_INTEGRATION_NO_CURSOR) {
    return "ghostty";
  }
  if (process.env.ALACRITTY_LOG || process.env.ALACRITTY_SOCKET) return "Alacritty";
  if (process.env.TERM?.includes("ghostty")) return "ghostty";
  if (process.env.TERM?.includes("kitty")) return "kitty";
  return process.env.TERM || "unknown";
}

/** True when LLMQUOTA_NO_MOUSE / NO_MOUSE is set to a truthy value. */
export function envDisablesMouse(): boolean {
  const v = (process.env.LLMQUOTA_NO_MOUSE || process.env.NO_MOUSE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function probeTerminal(): TerminalProbe {
  const term = process.env.TERM || "";
  const colorterm = process.env.COLORTERM || null;
  const tty = Boolean(process.stdout.isTTY);
  const stdinTty = Boolean(process.stdin.isTTY);
  const tmux = Boolean(process.env.TMUX);
  const zellij = Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME);
  const ssh = Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
  const emulator = detectEmulator();
  const mouseDisabledByEnv = envDisablesMouse();

  const knownGood = /iTerm|ghostty|kitty|WezTerm|Alacritty|Windows Terminal|vscode|cursor|Warp/i.test(
    emulator,
  );
  const appleTerm = /Apple_Terminal|Terminal\.app/i.test(emulator) || emulator === "Apple_Terminal";
  const mouseLikely =
    tty &&
    stdinTty &&
    !mouseDisabledByEnv &&
    (knownGood || appleTerm || (!tmux && !zellij && term.includes("xterm")));

  const tips: string[] = [];
  if (mouseDisabledByEnv) {
    tips.push("Mouse disabled via LLMQUOTA_NO_MOUSE (or NO_MOUSE). Unset to re-enable.");
  }
  if (appleTerm) {
    tips.push("Apple Terminal: View → Allow Mouse Reporting (⌘R) for clicks/hover.");
  }
  if (tmux) {
    tips.push(
      "tmux: set -g mouse on · set -g allow-passthrough on · or run with --no-mouse if clicks fight the mux.",
    );
  }
  if (zellij) {
    tips.push("zellij: mouse_mode can conflict — use llmquota --no-mouse if you see garbage like [<0;12;5M.");
  }
  if (ssh && !tmux) {
    tips.push("SSH: mouse usually works if the local emulator supports SGR; truecolor needs COLORTERM=truecolor.");
  }
  if (!colorterm && tty) {
    tips.push("COLORTERM unset — export COLORTERM=truecolor for 24-bit color (Ghostty/iTerm/Kitty).");
  }
  if (!tty || !stdinTty) {
    tips.push("Not a TTY — interactive arena requires stdin+stdout TTY (use llmquota --once for text).");
  }

  return {
    term: term || "(unset)",
    colorterm,
    tty,
    stdinTty,
    tmux,
    zellij,
    ssh,
    emulator,
    mouseLikely,
    mouseDisabledByEnv,
    tips,
  };
}

export function formatTerminalProbe(p: TerminalProbe): string[] {
  const lines: string[] = [];
  lines.push(
    `term=${p.term}  emulator=${p.emulator}  COLORTERM=${p.colorterm || "—"}`,
  );
  lines.push(
    `tty_out=${p.tty}  tty_in=${p.stdinTty}  tmux=${p.tmux}  zellij=${p.zellij}  ssh=${p.ssh}`,
  );
  lines.push(
    `mouse_likely=${p.mouseLikely}  mouse_disabled_by_env=${p.mouseDisabledByEnv}`,
  );
  for (const t of p.tips) lines.push(`  · ${t}`);
  return lines;
}
