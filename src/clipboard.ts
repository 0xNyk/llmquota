import { spawnSync } from "node:child_process";
import { platform } from "node:os";

/** Copy text to the system clipboard. Returns true on success. */
export function copyToClipboard(text: string): boolean {
  const data = text.trim();
  if (!data) return false;
  const os = platform();
  try {
    if (os === "darwin") {
      const r = spawnSync("pbcopy", [], { input: data, encoding: "utf8" });
      return r.status === 0;
    }
    if (os === "linux") {
      // Wayland then X11
      let r = spawnSync("wl-copy", [], { input: data, encoding: "utf8" });
      if (r.status === 0) return true;
      r = spawnSync("xclip", ["-selection", "clipboard"], {
        input: data,
        encoding: "utf8",
      });
      if (r.status === 0) return true;
      r = spawnSync("xsel", ["--clipboard", "--input"], {
        input: data,
        encoding: "utf8",
      });
      return r.status === 0;
    }
    if (os === "win32") {
      const r = spawnSync("clip", [], { input: data, encoding: "utf8", shell: true });
      return r.status === 0;
    }
  } catch {
    return false;
  }
  return false;
}
