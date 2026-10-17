/**
 * Two daemons on one chat app: an `.env` copied for a new instance with the old tokens left in it,
 * or with one of the two replaced. Socket Mode would send each event to one of the two
 * connections, so the second daemon refuses before it opens its connection, whatever its
 * configuration folder, when it shares any of the keys the chat reports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatIdentityTaken, singleInstance } from "../../src/core/lock.ts";
import { run } from "../../src/daemon.ts";
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
  const second = World.make(t, {
    home: first.home,
    identities: ["memory:other", "memory:other-app"],
  });
  await second.start();
  await second.finish();
  await first.finish();
});

test("the same app token with another bot token is refused", async (t) => {
  const first = World.make(t, { identities: ["workspace:bot-a", "app-token:one"] });
  await first.start();
  const second = World.make(t, {
    home: first.home,
    identities: ["workspace:bot-b", "app-token:one"],
  });
  await assert.rejects(
    run(second.runOptions()),
    (error: unknown) =>
      error instanceof ChatIdentityTaken &&
      error.message.endsWith("give each instance its own app"),
  );
  assert.ok(!second.chatCalls.includes("start"), "the second daemon opened its connection");
  // The bot key it took before the app key was refused is free: a third daemon may use it.
  const third = World.make(t, {
    home: first.home,
    identities: ["workspace:bot-b", "app-token:two"],
  });
  await third.start();
  await third.finish();
  await first.finish();
});

test("the same bot token with another app token is refused", async (t) => {
  const first = World.make(t, { identities: ["workspace:bot-a", "app-token:one"] });
  await first.start();
  const second = World.make(t, {
    home: first.home,
    identities: ["workspace:bot-a", "app-token:two"],
  });
  await assert.rejects(run(second.runOptions()), ChatIdentityTaken);
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
