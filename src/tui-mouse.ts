/**
 * SGR mouse parse + hit-testing (testable without a TTY).
 */

export const ESC = "\x1b";

export type HitAction =
  | { kind: "focus"; index: number }
  | { kind: "copy"; index: number }
  | { kind: "dormant" }
  | { kind: "refresh" }
  | { kind: "quit" }
  | { kind: "help-close" };

export interface HitRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  action: HitAction;
}

export interface MouseEvent {
  button: number;
  x: number; // 0-based
  y: number;
  press: boolean;
}

export function hitAt(hits: HitRegion[], x: number, y: number): HitRegion | null {
  let best: HitRegion | null = null;
  for (const h of hits) {
    if (x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1) best = h;
  }
  return best;
}

export function hitKey(action: HitAction): string {
  if (action.kind === "focus" || action.kind === "copy") return `${action.kind}:${action.index}`;
  return action.kind;
}

/** Parse SGR mouse + leftover keys from a stdin buffer. */
export function drainInput(buf: string): { events: MouseEvent[]; keys: string[]; rest: string } {
  const events: MouseEvent[] = [];
  const keys: string[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === ESC && buf[i + 1] === "[" && buf[i + 2] === "<") {
      const endM = buf.indexOf("M", i + 3);
      const endm = buf.indexOf("m", i + 3);
      let end = -1;
      let press = true;
      if (endM >= 0 && (endm < 0 || endM < endm)) {
        end = endM;
        press = true;
      } else if (endm >= 0) {
        end = endm;
        press = false;
      }
      if (end < 0) break; // incomplete
      const body = buf.slice(i + 3, end);
      const parts = body.split(";");
      if (parts.length >= 3) {
        const button = Number(parts[0]);
        const col = Number(parts[1]);
        const row = Number(parts[2]);
        if (Number.isFinite(button) && Number.isFinite(col) && Number.isFinite(row)) {
          events.push({ button, x: col - 1, y: row - 1, press });
        }
      }
      i = end + 1;
      continue;
    }
    // CSI arrow keys etc.
    if (buf[i] === ESC && buf[i + 1] === "[") {
      let j = i + 2;
      while (j < buf.length && /[0-9;]/.test(buf[j]!)) j++;
      if (j < buf.length && /[A-Za-z~]/.test(buf[j]!)) {
        keys.push(buf.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (j >= buf.length) break; // incomplete CSI
    }
    if (buf[i] === ESC && i === buf.length - 1) break; // lone ESC, wait
    keys.push(buf[i]!);
    i++;
  }
  return { events, keys, rest: buf.slice(i) };
}

/** True when SGR button code is a motion/hover report. */
export function isMotionButton(button: number): boolean {
  return (button & 32) !== 0 || button === 35;
}

export function isWheelUp(button: number): boolean {
  return button === 64;
}

export function isWheelDown(button: number): boolean {
  return button === 65;
}
