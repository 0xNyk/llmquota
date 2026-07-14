#!/usr/bin/env node
/**
 * Smoke tests for SGR mouse parse + hit map (no TTY required).
 */
import {
  drainInput,
  hitAt,
  hitKey,
  isMotionButton,
  isWheelDown,
  isWheelUp,
  type HitRegion,
} from "./tui-mouse.js";

let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failed++;
    process.stderr.write(`FAIL  ${msg}\n`);
  } else {
    process.stdout.write(`ok    ${msg}\n`);
  }
}

// Complete click press+release
{
  const { events, rest } = drainInput("\x1b[<0;10;5M\x1b[<0;10;5m");
  assert(events.length === 2, "parses press+release");
  assert(events[0]!.press && events[0]!.x === 9 && events[0]!.y === 4, "press coords 0-based");
  assert(!events[1]!.press, "release flag");
  assert(rest === "", "no leftover after complete seq");
}

// Incomplete sequence buffered
{
  const { events, rest } = drainInput("\x1b[<0;12;3");
  assert(events.length === 0, "incomplete SGR yields no events");
  assert(rest.startsWith("\x1b[<"), "incomplete kept in rest");
  const cont = drainInput(rest + "M");
  assert(cont.events.length === 1 && cont.events[0]!.press, "continuation completes press");
}

// Keys mixed with mouse
{
  const { events, keys } = drainInput("j\x1b[<0;1;1M\x1b[<0;1;1mk");
  assert(events.length === 2, "mouse amid keys");
  assert(keys.join("") === "jk", "keys preserved around mouse");
}

// Arrow key CSI
{
  const { keys, events } = drainInput("\x1b[B");
  assert(events.length === 0 && keys[0] === "\x1b[B", "arrow down as key");
}

// Motion / wheel helpers
assert(isMotionButton(32), "motion bit");
assert(isMotionButton(35), "motion 35");
assert(!isMotionButton(0), "left click not motion");
assert(isWheelUp(64) && isWheelDown(65), "wheel buttons");

// Hit map: last overlapping wins (copy over focus)
{
  const hits: HitRegion[] = [
    { x0: 0, y0: 0, x1: 20, y1: 10, action: { kind: "focus", index: 1 } },
    { x0: 0, y0: 2, x1: 20, y1: 3, action: { kind: "copy", index: 1 } },
  ];
  const h = hitAt(hits, 5, 2);
  assert(h?.action.kind === "copy", "copy region wins over card focus");
  assert(hitKey(h!.action) === "copy:1", "hitKey format");
  assert(hitAt(hits, 5, 5)?.action.kind === "focus", "body focuses");
  assert(hitAt(hits, 99, 99) === null, "miss returns null");
}

// Press+release same-target gate
{
  const press = { kind: "copy" as const, index: 0 };
  const release = { kind: "copy" as const, index: 0 };
  const dragAway = { kind: "focus" as const, index: 2 };
  assert(hitKey(press) === hitKey(release), "same target fires");
  assert(hitKey(press) !== hitKey(dragAway), "drag away cancels");
}

if (failed) {
  process.stderr.write(`\n${failed} smoke test(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall smoke tests passed\n");
