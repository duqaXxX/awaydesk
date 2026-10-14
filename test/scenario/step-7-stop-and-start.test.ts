/**
 * Step 7 of the scenario the memory chat carries: the daemon is stopped with a turn running (the
 * signal that does not wait for turns), then started again over the same config folder, the same
 * chat and the same agent store. The thread shows what the stop left, says what was not sent, and
 * a new message in it resumes the session.
 */
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { fill } from "../../src/core/texts.ts";
import { call, hold, say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

const STOPPED_REPLY = fill(texts.ENDED, { reason: texts.ENDED_SHUTDOWN });

test("a stop with a turn running ends the reply where it stood and says what was not sent", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Working"), hold());
  const thread = await world.open("first");
  await world.until(() => world.shown(thread).length === 3, "the reply under way");
  await world.owner.says(world.channel, "queued one", { thread });
  await world.owner.says(world.channel, "queued two", { thread });
  await world.settle();
  assert.equal(world.shown(thread).at(2), "Working");

  assert.equal(await world.stop("SIGINT"), 0);

  // What the stop left: the reply ended where it stood, with the line that says so, and under it
  // the count of the messages that were queued, each by its start, then the footer: a stop is an
  // end, and the footer says what could be read of the session.
  const footer = `full · ${realpathSync(world.folder)}`;
  const left = [
    "first",
    "Model: default · Effort: full · Bypass: off",
    [
      "Working",
      "",
      STOPPED_REPLY,
      "",
      `${fill(texts.NOT_SENT_MANY, { count: 2, because: texts.BECAUSE_SHUTDOWN })}\n- "queued one"\n- "queued two"\n${footer}`,
    ].join("\n"),
    "queued one",
    "queued two",
  ];
  assert.equal(
    fill(texts.NOT_SENT_MANY, { count: 2, because: texts.BECAUSE_SHUTDOWN }),
    "2 messages were not sent because awaydesk stopped: send them again.",
  );
  assert.deepEqual(world.shown(thread), left);
  assert.equal(world.chat.messages(world.channel, thread)[2]?.unfinished, false);
  assert.deepEqual(world.prompts(), ["first"]);

  // The same chat and the same store, a new daemon: the thread is as the stop left it, and the
  // channel has nothing the stop did not write.
  await world.start();
  assert.deepEqual(world.shown(thread), left);
  assert.deepEqual(world.chat.texts(world.channel), ["first"]);
  assert.deepEqual(world.chat.requests(), []);
  // The file the first run wrote belongs to the two modules that run again.
  const stored = JSON.parse(readFileSync(world.state, "utf8")) as Record<string, unknown>;
  assert.deepEqual([stored.version, stored.agent, stored.chat], [3, "plain", "memory"]);
  await world.finish();
});

test("a request that was waiting is gone after the stop and after the start", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(
    say("Removing."),
    call("Shell", { command: "rm x" }, { permission: true }),
    say("Gone."),
  );
  const thread = await world.open("remove x");
  await world.request("permission", thread);

  await world.stop("SIGINT");
  const left = [
    "remove x",
    "Model: default · Effort: full · Bypass: off",
    `Removing.\n[complete] Shell: rm x\n${STOPPED_REPLY}\nfull · ${realpathSync(world.folder)}`,
  ];
  assert.deepEqual(world.chat.requests(), []);
  assert.deepEqual(world.shown(thread), left);

  await world.start();
  assert.deepEqual(world.chat.requests(), []);
  assert.deepEqual(world.shown(thread), left);
  // Nothing of the old turn is asked again: the new agent started no session.
  assert.deepEqual(world.plain.sessions, []);
  await world.finish();
});

test("a new message in the thread after a restart resumes the session", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Working"), hold());
  const thread = await world.open("first");
  await world.until(() => world.shown(thread).length === 3, "the reply under way");
  const id = world.plain.sessions.at(-1)?.id as string;
  await world.stop("SIGINT");
  await world.start();

  // No setup is asked again for a thread that has a session; the new agent resumes it, at the
  // effort the owner chose for it.
  world.script(say("Back again."));
  await world.owner.says(world.channel, "carry on", { thread });
  await world.ended(thread, 2);
  assert.deepEqual(
    world.plain.starts.map((start) => [start.resume, start.effort]),
    [[id, "full"]],
  );
  assert.deepEqual(world.prompts(), ["first", "carry on"]);
  assert.deepEqual(
    world.plain.sessions.map((session) => session.prompts.length),
    [1],
  );
  assert.equal(world.shown(thread).at(-1), `Back again.\nfull · ${world.folder}`);
  assert.deepEqual(world.chat.requests(), []);
  await world.finish();
});
