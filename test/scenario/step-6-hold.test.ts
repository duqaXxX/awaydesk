/**
 * Step 6 of the scenario the memory chat carries: a second thread in the same folder while the
 * first one works. The hold is asked in the second thread, after its setup; "send" releases the
 * prompt, "don't send" tells the owner it was not sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { fill } from "../../src/core/texts.ts";
import { hold, say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

const SETUP = {
  type: "setup",
  selection: { model: "default", effort: "brief", bypass: false },
} as const;

/**
 * The owner writes a second message in the channel while the first thread works, answers its
 * setup and is put the hold. Resolves with the new thread, the hold's request and the message
 * that waits for the answer.
 */
async function secondWhileFirstWorks(world: World) {
  world.script(say("Working"), hold());
  const first = await world.open("first");
  await world.until(() => world.shown(first).length === 3, "the first reply under way");
  const before = new Set(world.chat.requests().map((r) => r.requestId));
  const sending = world.owner.says(world.channel, "second");
  const setup = await world.request("setup", undefined, before);
  await world.owner.answers(setup.requestId, SETUP);
  const asked = await world.request("hold", setup.ref.thread);
  return { first, second: setup.ref.thread, asked, sending };
}

test("a second thread in a busy folder is asked before it sends, and 'send' releases the prompt", async (t) => {
  const world = World.make(t);
  await world.start();
  const { first, second, asked, sending } = await secondWhileFirstWorks(world);

  // The question names the thread at work; nothing went to the agent for the second thread.
  const link = fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: first });
  assert.deepEqual(asked.request, {
    type: "hold",
    requestId: asked.requestId,
    other: { channel: world.channel, thread: first },
    link,
  });
  assert.equal(asked.title, fill(texts.HOLD_QUESTION, { link }));
  assert.deepEqual(world.prompts(), ["first"]);
  assert.deepEqual(world.kinds(second).slice(-1), [["request", asked.title]]);

  world.script(say("Second reply."));
  assert.equal(await world.owner.answers(asked.requestId, { type: "hold", send: true }), true);
  await sending;
  await world.until(
    () =>
      world.chat.messages(world.channel, second).some((m) => m.kind === "reply" && !m.unfinished),
    "the second reply",
  );
  assert.deepEqual(world.prompts(), ["first", "second"]);
  assert.deepEqual(world.chat.requests(), []);
  assert.deepEqual(world.shown(second), [
    "second",
    "Model: default · Effort: brief · Bypass: off",
    `Second reply.\nbrief · ${world.folder}`,
  ]);
  // The first thread is untouched: its turn still runs, in a session of its own.
  assert.equal(world.plain.running.length, 2);
  assert.equal(world.chat.messages(world.channel, first)[2]?.unfinished, true);
  await world.finish();
});

test("'don't send' tells the owner the message was not sent, and nothing reaches the agent", async (t) => {
  const world = World.make(t);
  await world.start();
  const { second, asked, sending } = await secondWhileFirstWorks(world);

  assert.equal(await world.owner.answers(asked.requestId, { type: "hold", send: false }), true);
  await sending;
  await world.settle();
  assert.deepEqual(world.prompts(), ["first"]);
  assert.deepEqual(world.chat.requests(), []);
  assert.deepEqual(world.kinds(second), [
    ["message", "second"],
    ["notice", "Model: default · Effort: brief · Bypass: off"],
    ["notice", texts.NOT_SENT],
  ]);
  assert.equal(texts.NOT_SENT, "Not sent.");
  await world.finish();
});

test("a folder where nothing works is not held", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("One."));
  world.script(say("Two."));
  const first = await world.open("first");
  await world.ended(first);
  const second = await world.open("second", "brief");
  await world.ended(second);
  assert.deepEqual(world.prompts(), ["first", "second"]);
  assert.deepEqual(world.chat.requests(), []);
  await world.finish();
});
