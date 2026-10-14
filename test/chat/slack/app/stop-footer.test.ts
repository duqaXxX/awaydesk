/**
 * `!stop` typed in a thread, through the word's flow (`talk.tell` with `stays`): the footer is on
 * the reply the stop ended, and the line that says the stop is a post below it with none (the
 * footer goes on the app's last reply, never on a notice of the daemon's own).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STREAM_SECONDS } from "../../../../src/chat/slack/reply/sinks.ts";
import { STOP_TAIL_WAIT } from "../../../../src/core/sessions/constants.ts";
import * as texts from "../../../../src/core/texts.ts";
import { THREAD } from "../../../support/fake-slack.ts";
import { isResult, isSystem, recordOf, sdkMessages } from "../../../support/sessions.ts";
import { message, reply, type World, worldOf } from "../../../support/slack-app.ts";

/** Whether a message of the thread shows a footer, by its ts. */
function hasFooter(world: World, ts: string): boolean {
  return world.slack.messages.get(ts)?.blocks.some((block) => block.type === "divider") ?? false;
}

/** The ts of the post that says the stop. */
function noticeOf(world: World): string {
  const call = world.slack
    .callsTo("chat.postMessage")
    .find((post) => (post as { text?: string }).text === texts.STOPPED_THREAD);
  assert.ok(call !== undefined, "the stop was said");
  const ts = world.slack.postedTs.at(world.slack.callsTo("chat.postMessage").indexOf(call));
  assert.ok(ts !== undefined);
  return ts;
}

test("a stop during a turn leaves the footer on the reply it ended, the notice below with none", async (t) => {
  const world = worldOf(t);
  await world.dispatch(message("hello", { ts: THREAD }));
  const client = world.clients[0];
  assert.ok(client !== undefined);
  const items = sdkMessages("interrupt");
  const result = items.findIndex(isResult);
  client.answer(items.slice(0, result));
  await world.until(() => world.slack.streamTs.length > 0);
  await world.dispatch(reply("!stop", THREAD));
  client.inject(items.slice(result));
  await world.clock.advance(STOP_TAIL_WAIT);
  await world.until(() => world.slack.callsTo("chat.postMessage").length > 0);
  const [stream] = world.slack.streamTs;
  assert.ok(stream !== undefined);
  await world.until(() => hasFooter(world, stream));
  assert.equal(hasFooter(world, stream), true, "the footer is on the reply");
  const notice = noticeOf(world);
  assert.equal(hasFooter(world, notice), false, "and not on the notice");
  assert.ok(Number(notice) > Number(stream), "the notice is below the reply");
});

test("a stop of a background subagent puts the footer on its reply, the notice below with none", async (t) => {
  const world = worldOf(t);
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  await world.dispatch(message("launch it", { ts: THREAD }));
  const client = world.clients[0];
  assert.ok(client !== undefined);
  client.answer(items.slice(0, first + 1));
  await world.until(() => world.slack.callsTo("chat.stopStream").length > 0);
  const [stream] = world.slack.streamTs;
  assert.ok(stream !== undefined);
  assert.equal(hasFooter(world, stream), false, "the subagent runs: no footer");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => world.slack.callsTo("chat.postMessage").length > 0);
  assert.equal(client.stoppedTasks.length, 1);
  // The notification SDK documents for `stopTask`: status `stopped`.
  const end = items.findIndex(
    (item, index) =>
      index > first &&
      isSystem(item, "task_notification") &&
      recordOf(item)?.task_id === client.stoppedTasks[0],
  );
  const record = recordOf(items[end]) ?? {};
  client.inject([{ record: { ...record, status: "stopped" } }]);
  await world.until(() => hasFooter(world, stream));
  const notice = noticeOf(world);
  assert.equal(hasFooter(world, notice), false);
  assert.ok(Number(notice) > Number(stream));
});

test("a stop of a reply past 280 seconds draws the footer on it, above the notice", async (t) => {
  // The stream stopped at 280 s and nothing follows the last call: the reply's closing message
  // waits for the footer, and the stop's notice comes first. Nothing is posted below the notice.
  const world = worldOf(t);
  world.slack.tsStep = 10; // room for the owner's `!stop` between the app's messages, in order
  await world.dispatch(message("hello", { ts: THREAD }));
  const client = world.clients[0];
  assert.ok(client !== undefined);
  const items = sdkMessages("interrupt");
  const result = items.findIndex(isResult);
  client.answer(items.slice(0, result));
  await world.until(() => world.slack.streamTs.length > 0);
  await world.slackClock.advance(STREAM_SECONDS + 1);
  await world.until(() => world.slack.callsTo("chat.stopStream").length > 0);
  const below = world.slack.createdTs.at(-1) ?? "";
  await world.dispatch(reply("!stop", THREAD, { ts: `${below.slice(0, -1)}5` }));
  client.inject(items.slice(result));
  // The stop waits for the reply's end, as when its end lands in time.
  await world.until(() =>
    world.slack.callsTo("chat.postMessage").some((post) => post.text === texts.STOPPED_THREAD),
  );
  const [stream] = world.slack.streamTs;
  assert.ok(stream !== undefined);
  await world.until(() => hasFooter(world, stream));
  const notice = noticeOf(world);
  assert.equal(hasFooter(world, notice), false, "not on the notice");
  const after = world.slack.createdTs.filter((ts) => Number(ts) > Number(notice));
  assert.deepEqual(after, [], "nothing is posted below the notice");
});
