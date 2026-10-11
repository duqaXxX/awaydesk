/**
 * `!status`, typed in the channel: its folder, then one line per live session. And the
 * thread's own `!status`, which is the session's.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ago } from "../../../src/core/flows/status.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { call, hold, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld, PLAIN_NAMES, WithBypass } from "./messages-world.ts";

const header = (directory: string): string => fill(texts.STATUS_CHANNEL_HEADER, { directory });
const linkTo = (thread: string): string =>
  fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: thread });

for (const [seconds, shown] of [
  [5, "just now"],
  [59, "just now"],
  [60, "1m ago"],
  [3_599, "59m ago"],
  [3_600, "1h ago"],
  [86_399, "23h ago"],
  [86_400, "1d ago"],
  [30 * 86_400, "30d ago"],
  [-30, "just now"],
] as const) {
  test(`how long ago reads in one unit [${seconds}-${shown}]`, () => {
    assert.equal(ago(seconds), shown);
  });
}

test("a channel bound to no folder says where sessions start", async (t) => {
  const world = await MessagesWorld.make(t);
  const free = world.chat.openChannel("free");
  await world.send({
    ref: { channel: free, thread: "root-1" },
    id: "root-1",
    topLevel: true,
    text: "!status",
  });
  assert.deepEqual(world.chat.texts(free), [
    fill(named(texts.UNBOUND, PLAIN_NAMES), { root: world.folder }),
  ]);
});

test("a channel with no live session says so after its folder", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!status");
  assert.equal(
    world.inChannel().at(-1),
    [header(world.folder), texts.STATUS_CHANNEL_EMPTY].join("\n"),
  );
});

test("an idle session is named by its title and the time of its last message", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("Fix the footer");
  const [stored] = (world.agent as PlainAgent).store.list(world.folder);
  assert.ok(stored);
  world.now = stored.lastModified / 1000 + 7_200;
  await world.says("!status");
  const row = fill(texts.STATUS_CHANNEL_ROW, {
    link: linkTo(ref.thread),
    activity: `${texts.STATUS_CHANNEL_IDLE}${fill(texts.STATUS_CHANNEL_SINCE, { ago: "2h ago" })}`,
  });
  assert.equal(world.inChannel().at(-1), [header(world.folder), row].join("\n"));
});

test("a busy session and one that waits for the owner are told apart", async (t) => {
  const world = await MessagesWorld.make(t);
  const busy = await world.opened("one");
  const waiting = await world.opened("two");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", busy.thread);
  (world.agent as PlainAgent).next(call("Bash", { command: "ls" }, { permission: true }));
  // Beside a busy session of the folder, the owner is asked first.
  const sending = world.says("run it", waiting.thread);
  const asked = await world.asked("hold", waiting);
  await world.chat.as(OWNER).answers(asked.requestId, { type: "hold", send: true });
  await sending;
  await world.asked("permission", waiting);
  await world.says("!status");
  const lines = world.inChannel().at(-1)?.split("\n") ?? [];
  assert.equal(lines[0], header(world.folder));
  const rows = lines.slice(1).toSorted();
  assert.deepEqual(
    rows,
    [
      fill(texts.STATUS_CHANNEL_ROW, {
        link: linkTo(busy.thread),
        activity: texts.STATUS_CHANNEL_BUSY,
      }),
      fill(texts.STATUS_CHANNEL_ROW, {
        link: linkTo(waiting.thread),
        activity: texts.STATUS_CHANNEL_WAITING,
      }),
    ].toSorted(),
  );
});

test("a row says bypass, and the folder of a thread the channel left behind", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = await world.opened("one");
  await world.says("!bypass on", ref.thread);
  const docs = join(world.folder, "docs");
  mkdirSync(docs);
  world.state.bind(world.channel, docs);
  await world.says("!status");
  const lines = world.inChannel().at(-1)?.split("\n") ?? [];
  assert.equal(lines[0], header(docs));
  const idle = `${texts.STATUS_CHANNEL_IDLE}${fill(texts.STATUS_CHANNEL_SINCE, { ago: "just now" })}`;
  assert.equal(
    lines[1],
    fill(texts.STATUS_CHANNEL_ROW, { link: linkTo(ref.thread), activity: idle }) +
      texts.STATUS_CHANNEL_BYPASS +
      fill(texts.STATUS_CHANNEL_FOLDER, { directory: world.folder }),
  );
});

test("a title the agent cannot list leaves the row with no time", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  t.mock.method(world.sessions, "sessionsIn", async () => {
    throw new Error("unreadable");
  });
  await world.says("!status");
  assert.equal(
    world.inChannel().at(-1),
    [
      header(world.folder),
      fill(texts.STATUS_CHANNEL_ROW, {
        link: linkTo(ref.thread),
        activity: texts.STATUS_CHANNEL_IDLE,
      }),
    ].join("\n"),
  );
});

test("a stop that waits for a thread is named in a notice of its own", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  const cut = new AbortController();
  const drain = world.sessions.drain(cut.signal);
  await world.settle();
  await world.says("!status");
  const notice = world.inChannel().at(-1) ?? "";
  assert.ok(notice.startsWith(texts.RESTART_WAITS_HEADER), notice);
  assert.ok(notice.includes(linkTo(ref.thread)));
  assert.ok(notice.includes(texts.RESTART_HOLD_TURN));
  cut.abort();
  await drain;
});

test("!status in a thread is the session's own, for the owner alone", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  await world.says("!status", ref.thread);
  assert.equal(world.shown(ref).at(-1), await session.status());
});
