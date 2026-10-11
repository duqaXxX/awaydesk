/**
 * Step 2 of the scenario the memory chat carries: the reply arrives as text and one tool line
 * and ends with a footer. The memory chat has no native streaming and no activity line, so the
 * core hands each text over whole, and the footer holds only what this agent and this chat can
 * show.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, fail, hold, say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

test("the reply is text, one tool line and a footer, and each text is handed over whole, once", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(
    say("Reading it."),
    call("Shell", { command: "ls" }, { output: "a.txt" }),
    say("Done."),
  );
  const thread = await world.open("list it");
  await world.ended(thread);

  // One message holds the whole reply; the footer is its last line, and the reply is ended.
  const reply = world.chat.messages(world.channel, thread)[2];
  assert.deepEqual([reply?.kind, reply?.author, reply?.unfinished], ["reply", "daemon", false]);
  assert.equal(reply?.text, `Reading it.\n[complete] Shell: ls\nDone.\nfull · ${world.folder}`);

  // The footer's fields: the effort the owner chose and the folder. This agent reports no model,
  // no tokens and no context, declares no usage limits and keeps no record of trust, so there
  // is no git state either.
  assert.deepEqual(reply?.text.split("\n").at(-1)?.split(" · "), ["full", world.folder]);

  // The chat streams nothing: each message of the agent reached the reply as one text, once.
  assert.deepEqual(world.handed, ["Reading it.", "Done."]);
  await world.finish();
});

test("the reply grows while the turn runs and ends when it does", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Working on it."), hold(), say("Finished."));
  const thread = await world.open("take your time");
  await world.until(() => world.shown(thread).length === 3, "the first part of the reply");

  const growing = world.chat.messages(world.channel, thread)[2];
  assert.deepEqual([growing?.text, growing?.unfinished], ["Working on it.", true]);

  world.plain.running[0]?.release();
  await world.ended(thread);
  assert.deepEqual(world.shown(thread).slice(2), [
    `Working on it.\n\nFinished.\nfull · ${world.folder}`,
  ]);
  // The paragraph break between two messages travels in the second text.
  assert.deepEqual(world.handed, ["Working on it.", "\n\nFinished."]);
  await world.finish();
});

test("a failed request of the agent is a reply that says so, with its footer", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(fail("The request failed."));
  const thread = await world.open("go");
  await world.ended(thread);
  assert.deepEqual(world.shown(thread).slice(2), [`The request failed.\nfull · ${world.folder}`]);
  await world.finish();
});
