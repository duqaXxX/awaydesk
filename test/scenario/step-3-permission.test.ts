/**
 * Step 3 of the scenario the memory chat carries: the agent asks permission, the owner approves
 * and the tool runs; then one the owner denies, and the agent is told. The plain agent has one
 * permission mode, so every call it marks asks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { named } from "../../src/core/texts.ts";
import { call, say } from "../support/plain-agent.ts";
import { NAMES, World } from "./world.ts";

test("the owner approves a permission, the tool runs and the request's message is gone", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(
    say("Removing."),
    call("Shell", { command: "rm x" }, { permission: true, output: "removed" }),
    say("Gone."),
  );
  const thread = await world.open("remove x");
  const asked = await world.request("permission", thread);

  // The request is a message of the thread with a control; the call waits, and the reply is
  // not ended.
  assert.equal(asked.title, "Shell: rm x");
  assert.deepEqual(asked.request, {
    type: "permission",
    callId: asked.request.type === "permission" ? asked.request.callId : "",
    toolName: "Shell",
    input: { command: "rm x" },
    title: null,
    description: null,
  });
  const messages = world.chat.messages(world.channel, thread);
  assert.deepEqual(
    messages.map((m) => [m.kind, m.text, m.pressable, m.unfinished]),
    [
      ["message", "remove x", false, false],
      ["notice", "Model: default · Effort: full · Bypass: off", false, false],
      ["request", "Shell: rm x", true, false],
      ["reply", "Removing.\n[in_progress] Shell: rm x", false, true],
    ],
  );

  assert.equal(
    await world.owner.answers(asked.requestId, { type: "permission", allow: true }),
    true,
  );
  await world.ended(thread);

  assert.deepEqual(world.chat.requests(), []);
  assert.deepEqual(world.shown(thread), [
    "remove x",
    "Model: default · Effort: full · Bypass: off",
    `Removing.\n[complete] Shell: rm x\nGone.\nfull · ${world.folder}`,
  ]);
  assert.deepEqual(
    world.plain.sessions[1]?.answers.map((a) => a.answer),
    [{ allow: true }],
  );
  await world.finish();
});

test("the owner denies a permission, the call ends denied and the agent is told", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Hello."));
  world.script(
    call("Shell", { command: "rm y" }, { permission: true, output: "removed" }),
    say("Kept."),
  );
  const thread = await world.open("first");
  await world.ended(thread);
  const again = world.owner.says(world.channel, "and y", { thread });
  const asked = await world.request("permission", thread);
  assert.equal(asked.title, "Shell: rm y");
  assert.equal(
    await world.owner.answers(asked.requestId, { type: "permission", allow: false }),
    true,
  );
  await again;
  await world.ended(thread, 2);

  assert.deepEqual(world.chat.requests(), []);
  assert.equal(world.shown(thread)[4], `[error] Shell: rm y\nKept.\nfull · ${world.folder}`);
  // The agent was told, in the daemon's own words.
  const told = named(texts.DENY_MESSAGE, NAMES);
  assert.equal(told, "The owner denied this from Memory chat.");
  assert.deepEqual(
    world.plain.sessions[1]?.answers.map((a) => a.answer),
    [{ allow: false, message: told }],
  );
  await world.finish();
});
