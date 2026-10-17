/**
 * Two daemons on one chat identity: an `.env` copied for a new instance with the old tokens left
 * in it. Socket Mode would send each event to one of the two connections, so the second daemon
 * refuses before it opens its connection, whatever its configuration folder.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatIdentityTaken, singleInstance } from "../../src/core/lock.ts";
import { run } from "../../src/main.ts";
import { World } from "./world.ts";

test("a second daemon on the same chat identity refuses before it connects", async (t) => {
  const first = World.make(t);
  await first.start();
  // Its own configuration folder, so the instance lock lets it in; the chat's identity is the same.
  const second = World.make(t, { home: first.home });

  await assert.rejects(
    run(second.runOptions()),
    (error: unknown) =>
      error instanceof ChatIdentityTaken &&
      error.message.endsWith("give each instance its own app"),
  );
  assert.ok(!second.chatCalls.includes("start"), "the second daemon opened its connection");
  // What it built is let go of, and its instance lock is free.
  assert.deepEqual(second.chatCalls, ["stop", "close"]);
  assert.ok(second.entry.built.every((agent) => agent.closed));
  await (await singleInstance(second.config)).release();
  // The first is untouched.
  assert.deepEqual(first.chatCalls, ["start"]);
  await first.finish();
});

test("another identity runs beside it", async (t) => {
  const first = World.make(t);
  await first.start();
  const second = World.make(t, { home: first.home, identity: "memory:other" });
  await second.start();
  await second.finish();
  await first.finish();
});

test("the identity is free once its daemon has stopped", async (t) => {
  const first = World.make(t);
  await first.start();
  const second = World.make(t, { home: first.home });
  await assert.rejects(run(second.runOptions()), ChatIdentityTaken);
  await first.stop();
  await second.start();
  await second.finish();
  await first.finish();
});
