/**
 * Step 1 of the scenario the memory chat carries: a message opens a thread, the setup is asked
 * and answered, and the prompt is sent. The real daemon runs with the plain agent and the memory
 * chat selected by name in its `.env` (`world.ts`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { fill } from "../../src/core/texts.ts";
import { say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

test("a message in a bound channel opens a thread and asks the setup this agent allows", async (t) => {
  const world = World.make(t);
  await world.start();
  const sending = world.owner.says(world.channel, "start the work");
  const asked = await world.request("setup");

  // The plain agent lists no model, offers its two effort levels and has no bypass to offer.
  assert.deepEqual(asked.request, {
    type: "setup",
    requestId: asked.requestId,
    models: [],
    efforts: ["brief", "full"],
    bypassOffered: false,
    selection: { model: "default", effort: "default", bypass: false },
  });
  assert.equal(asked.title, texts.SETUP_FALLBACK);

  // The thread is the owner's message and the request; the channel shows the message alone; the
  // prompt waits for the owner.
  const thread = asked.ref.thread;
  assert.deepEqual(world.kinds(thread), [
    ["message", "start the work"],
    ["request", texts.SETUP_FALLBACK],
  ]);
  assert.deepEqual(world.chat.texts(world.channel), ["start the work"]);
  assert.deepEqual(world.prompts(), []);

  await world.owner.answers(asked.requestId, {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  });
  await sending;
  await world.finish();
});

test("the owner's answer starts the session at that effort and the setup becomes its summary line", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Hello there."));
  const sending = world.owner.says(world.channel, "start the work");
  const asked = await world.request("setup");
  const thread = asked.ref.thread;

  await world.owner.answers(asked.requestId, {
    type: "setup",
    selection: { model: "default", effort: "full", bypass: false },
  });
  await sending;
  await world.until(() => world.chat.messages(world.channel, thread).length === 3, "the reply");

  // The agent was started again at the chosen effort, since it cannot change one on a live
  // session, and the prompt went to that session, once, as the owner wrote it.
  assert.deepEqual(
    world.plain.starts.map((start) => [start.effort, start.resume]),
    [
      [null, null],
      ["full", null],
    ],
  );
  assert.deepEqual(world.prompts(), ["start the work"]);
  assert.deepEqual(
    world.plain.sessions.map((session) => session.prompts.length),
    [0, 1],
  );

  // The request is no longer one: its message says what was set.
  assert.deepEqual(world.chat.requests(), []);
  const summary = fill(texts.SETUP_SUMMARY, { model: "default", effort: "full", bypass: "off" });
  assert.equal(summary, "Model: default · Effort: full · Bypass: off");
  assert.deepEqual(world.kinds(thread).slice(0, 2), [
    ["message", "start the work"],
    ["notice", summary],
  ]);
  await world.finish();
});

test("an answer left at the default, or naming an effort the agent lacks, starts the session at its own", async (t) => {
  for (const effort of ["default", "high"]) {
    const world = World.make(t);
    await world.start();
    const sending = world.owner.says(world.channel, "start the work");
    const asked = await world.request("setup");
    await world.owner.answers(asked.requestId, {
      type: "setup",
      selection: { model: "default", effort, bypass: false },
    });
    await sending;
    await world.until(() => world.prompts().length === 1, "the prompt");

    assert.deepEqual(
      world.plain.starts.map((start) => start.effort),
      [null],
    );
    const summary = fill(texts.SETUP_SUMMARY, {
      model: "default",
      effort: texts.SETUP_EFFORT_DEFAULT,
      bypass: "off",
    });
    assert.deepEqual(world.shown(asked.ref.thread).slice(0, 2), ["start the work", summary]);
    await world.finish();
  }
});
