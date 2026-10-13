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
import { CHANNEL, THREAD } from "../../support/fake-slack.ts";
import { harnessFor, sdkMessages } from "../../support/sessions.ts";
import { isReport, logged, splitBackground } from "./helpers.ts";

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
  const report = texts.findIndex(isReport);
  assert.ok(report > 1, texts.join("\n---\n"));
  assert.ok(!isReport(texts[0] ?? ""), "the first reply holds the report");
  // The first reply ended by edit: every message the thread holds was posted by the other two
  // replies, none for the first's ending.
  assert.equal(h.slack.callsTo("chat.postMessage").length, 0);
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
  assert.ok(texts.findIndex(isReport) > 1, texts.join("\n---\n"));
  assert.ok(!isReport(texts[0] ?? ""), "the first reply holds the report");
});

test("a command typed under the waiting reply sends the report to a reply at the bottom (R1)", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  // The `!status` of the owner is a message in the thread, below the waiting reply, which opens
  // no reply of its own. The gap leaves it a ts between the reply and what comes next.
  h.slack.tsStep = 1000;
  h.chat.ownerPosted(CHANNEL, THREAD, "1790000000.000500");
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

test("an overtaken reply whose task ends with no turn is logged, and posts nothing", async (t) => {
  const lines = logged(t, "info");
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first, answer] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("and now?")).done.wait();
  const before = h.slack.callsTo("chat.postMessage").length;
  h.clients[0]?.inject(notice);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  assert.equal(lines.filter((line) => line.startsWith(ENDED)).length, 1, lines.join("\n"));
  assert.equal(h.slack.callsTo("chat.postMessage").length, before);
  assert.ok(!h.replies().some(isReport));
});
