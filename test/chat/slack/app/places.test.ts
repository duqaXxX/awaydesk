/**
 * The listener tells the thread's places of every message the owner wrote in it, also one the
 * prompt filter drops: a `/me` line still sits below the replies above it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL, STRANGER, THREAD } from "../../../support/fake-slack.ts";
import { inAThread, reply, worldOf } from "../../../support/slack-app.ts";

const ack = async (): Promise<void> => {};

test("an owner message the prompt filter drops still sits below the reply above it", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const open = world.chat.thread({ channel: CHANNEL, thread: THREAD }).openReply(() => {});
  await open.text("an answer");
  await open.settle();
  assert.equal(open.last, true);
  const body = reply("waves", THREAD, { subtype: "me_message", ts: "1790900000.000001" });
  await world.app.processEvent({ body, ack });
  assert.equal(open.last, false);
});

test("a message of somebody else takes no place", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const open = world.chat.thread({ channel: CHANNEL, thread: THREAD }).openReply(() => {});
  await open.text("an answer");
  await open.settle();
  const body = reply("hello", THREAD, { user: STRANGER, ts: "1790900000.000001" });
  await world.app.processEvent({ body, ack });
  assert.equal(open.last, true);
});
