/**
 * Where a background task's report renders (issue #295): into the reply that started the task
 * only while that reply is the last thing in the thread, otherwise in a reply of its own at the
 * bottom. Each test replays a recording over the real Slack provider on the fake Slack, and
 * reads the thread back in the order its messages sit in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STREAM_SECONDS } from "../../../src/chat/slack/reply/sinks.ts";
import { INJECTED_TURN_WAIT } from "../../../src/core/sessions/constants.ts";
import { harnessFor, isSystem, sdkMessages } from "../../support/sessions.ts";
import { inside, isReport, logged, splitBackground } from "./helpers.ts";

const ENDED = "a reply ended with no report under it";

/** An owner prompt answered while the background command runs: a plain recorded turn. */
const answer = sdkMessages("foreground");

test("a report goes below the reply the owner's later prompt got, not into the first (case 3)", async (t) => {
  // Before the report moved to the bottom, it rendered into the first reply, above the second
  // answer, where the owner no longer looks.
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first, answer] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("and now?")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.replies().some(isReport));
  await h.idle();
  const texts = h.replies();
  // The second reply rests for the command, so the report renders into it, below the first.
  assert.equal(texts.findIndex(isReport), 1, texts.join("\n---\n"));
  assert.ok(!isReport(texts[0] ?? ""), "the first reply holds the report");
  // The first reply ended by edit; the one post is the second reply's ending, below its report.
  assert.equal(h.slack.callsTo("chat.postMessage").length, 1);
});

test("the same past the stream's own deadline", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first, answer] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("and now?")).done.wait();
  await h.slackClock.advance(STREAM_SECONDS + 1);
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.replies().some(isReport));
  await h.idle();
  const texts = h.replies();
  assert.equal(texts.findIndex(isReport), 1, texts.join("\n---\n"));
  assert.ok(!isReport(texts[0] ?? ""), "the first reply holds the report");
  assert.equal(h.slack.callsTo("chat.postMessage").length, 1);
});

test("a command typed under the waiting reply sends the report to a reply at the bottom (R1)", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  // The `!status` of the owner is a message in the thread, below the waiting reply, which opens
  // no reply of its own (the harness tells the provider of it, as the listener does).
  await session.status();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.replies().some(isReport));
  await h.idle();
  const texts = h.replies();
  assert.equal(texts.findIndex(isReport), texts.length - 1, texts.join("\n---\n"));
  assert.ok(texts.length >= 2 && !isReport(texts[0] ?? ""));
});

test("nothing below the waiting reply: the report renders in it", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => isReport(h.bodies()[0] ?? ""));
  await h.idle();
  assert.ok(isReport(h.bodies()[0] ?? ""));
  assert.equal(h.bodies().filter(isReport).length, 1);
});

test("an overtaken reply whose task ends with no turn is logged, and says the end where it is", async (t) => {
  const lines = logged(t, "info");
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first, answer] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("and now?")).done.wait();
  const before = h.slack.createdTs.length;
  h.clients[0]?.inject(notice);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  assert.equal(lines.filter((line) => line.startsWith(ENDED)).length, 1, lines.join("\n"));
  // No message of any kind: a stream start or a post would be a new message. The command has
  // no card to complete, so its end line is written into the thread's last reply, which rests
  // for it, by edit (the update debounces: `until` gives it the room to land).
  assert.equal(h.slack.createdTs.length, before);
  await h.until(() => h.replies().some(isReport));
  assert.deepEqual(h.replies().map(isReport), [false, true]);
});

test("the same when the notification never comes (the unreported timer)", async (t) => {
  const lines = logged(t, "info");
  const [first, notice] = splitBackground();
  // The recording without its `task_notification`: Claude Code can suppress it.
  const ended = notice.filter((item) => !isSystem(item, "task_notification"));
  assert.ok(ended.length > 0 && ended.length < notice.length);
  const h = harnessFor(t)({ turns: [first, answer] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("and now?")).done.wait();
  const before = h.slack.createdTs.length;
  h.clients[0]?.inject(ended);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  assert.equal(lines.filter((line) => line.startsWith(ENDED)).length, 1, lines.join("\n"));
  assert.equal(h.slack.createdTs.length, before);
});

test("a reply with a command of the owner's below it ends where it is when the notification never comes", async (t) => {
  const lines = logged(t, "info");
  const [first, notice] = splitBackground();
  const ended = notice.filter((item) => !isSystem(item, "task_notification"));
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => h.slack.callsTo("chat.stopStream").length > 0); // the rest's stop landed
  await session.status(); // a message of the owner's below the waiting reply, no reply of its own
  const before = h.slack.createdTs.length;
  const posts = h.slack.callsTo("chat.postMessage").length;
  h.clients[0]?.inject(ended);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  assert.equal(lines.filter((line) => line.startsWith(ENDED)).length, 1, lines.join("\n"));
  assert.equal(h.slack.createdTs.length, before, "no new message: it ended in place");
  assert.equal(h.slack.callsTo("chat.postMessage").length, posts);
  assert.ok(!h.replies().some(isReport));
});

test("two sweeps that wake together log one overtaken reply once", async (t) => {
  const lines = logged(t, "info");
  const [first, notice] = splitBackground();
  const ended = notice.filter((item) => !isSystem(item, "task_notification"));
  const h = harnessFor(t)({ turns: [first, answer] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("and now?")).done.wait();
  const [renderer] = [...inside(session).taskReplies.values()];
  assert.ok(renderer !== undefined);
  // `closeOut` sets its flag only after an await: hold it there so that the second sweep reads
  // the reply as still open, as a second timer waking in the same advance would.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(renderer, "closeOut", async () => {
    await gate;
    return true;
  });
  h.clients[0]?.inject(ended);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  const second = inside(session).sweepClosedOut(undefined, { unreported: true });
  await h.idle();
  release();
  await second;
  await h.idle();
  assert.equal(lines.filter((line) => line.startsWith(ENDED)).length, 1, lines.join("\n"));
});
