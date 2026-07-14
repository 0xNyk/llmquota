import {
  busFileSize,
  busIsLive,
  busLiveOff,
  busLiveOn,
  busMessageForMe,
  busPollGrowth,
  busPull,
  busRead,
  busResolveIdentity,
  busSend,
  formatBusLine,
  formatBusReadable,
} from "./bus.js";
import { home } from "./util.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log(`ok    ${msg}`);
}

const token = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sent = busSend({ text: token, to: "all", from: "test" });
assert(sent.text === token, "busSend returns message");
assert(sent.to === "all", "default to all");

const msgs = busRead(50);
assert(msgs.some((m) => m.text === token), "busRead finds sent line");
assert(formatBusLine(sent).includes(token), "formatBusLine includes text");
assert(formatBusReadable(msgs).includes(token), "formatBusReadable includes text");

{
  const historical = `historical-${token}`;
  busSend({ text: historical, to: "all", from: "peer" });
  busLiveOn(12345);
  assert(busIsLive(), "busLiveOn → LIVE");
  const id = `pull-${Date.now()}`;
  busSend({ text: `unread-${token}`, to: "all", from: "peer" });
  const first = busPull({ from: id });
  assert(
    first.messages.some((m) => m.text === `unread-${token}`),
    "first busPull returns messages since LIVE",
  );
  assert(
    !first.messages.some((m) => m.text === historical),
    "first busPull skips history from before LIVE",
  );
  assert(first.live === true, "busPull sees LIVE");
  assert(first.me === id || first.me.includes("pull"), "busPull reports me");
  const second = busPull({ from: id });
  assert(
    !second.messages.some((m) => m.text === `unread-${token}`),
    "busPull advances cursor",
  );
  busLiveOff();
  assert(!busIsLive(), "busLiveOff clears LIVE");
}

{
  const id = `cold-pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const historical = `cold-history-${token}`;
  busSend({ text: historical, to: "all", from: "peer" });
  const first = busPull({ from: id });
  assert(first.messages.length === 0, "first busPull outside LIVE seeds to EOF");

  const fresh = `cold-fresh-${token}`;
  busSend({ text: fresh, to: "all", from: "peer" });
  const second = busPull({ from: id });
  assert(
    second.messages.some((m) => m.text === fresh),
    "seeded busPull returns subsequent traffic",
  );
}

{
  assert(busMessageForMe({ ts: "", from: "a", to: "all", text: "x" }, "claude/work"), "all hits");
  assert(
    busMessageForMe({ ts: "", from: "a", to: "claude", text: "x" }, "claude/work"),
    "group claude hits claude/work",
  );
  assert(
    busMessageForMe({ ts: "", from: "a", to: "claude/work", text: "x" }, "claude/work"),
    "exact session hit",
  );
  assert(
    !busMessageForMe({ ts: "", from: "a", to: "claude/personal", text: "x" }, "claude/work"),
    "other session miss",
  );
  assert(busResolveIdentity("Claude/Personal") === "claude/personal", "normalize id");
  const dir = "/tmp/llmquota-bus-dir-a";
  assert(
    busMessageForMe(
      { ts: "", from: "codex", to: "here", text: "x", cwd: dir, repo: dir },
      "claude/work",
      { cwd: dir, repo: dir },
    ),
    "here hits same cwd",
  );
  assert(
    !busMessageForMe(
      { ts: "", from: "codex", to: "here", text: "x", cwd: dir, repo: dir },
      "claude/work",
      { cwd: "/tmp/other", repo: "/tmp/other" },
    ),
    "here misses other cwd",
  );
}

{
  const before = busFileSize();
  busSend({ text: `grow-${token}`, to: "all", from: "test" });
  const growth = busPollGrowth(before);
  assert(growth.newMessages.some((m) => m.text === `grow-${token}`), "busPollGrowth");
}

console.log("\nall bus tests passed");
console.log(`(ring file under ${home(".local", "share", "llmquota", "bus")})`);
