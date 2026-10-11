/**
 * Invariant 1 at the lists: a pick from somebody else never reaches the core, so a list they
 * press changes nothing and is left as it was.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER, SOMEONE } from "../../support/memory-chat.ts";
import { ListsWorld } from "./lists-world.ts";

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";

test("a pick of a folder by somebody else never reaches the core", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.list(world.channel);
  const [list] = world.chat.lists();
  assert.equal(await world.chat.as(SOMEONE).picks(list?.message ?? "", world.app), false);
  assert.deepEqual(world.picked, []);
  assert.equal(world.state.channel(world.channel), null);
  assert.equal(world.chat.lists().length, 1);
  assert.equal(await world.chat.as(OWNER).picks(list?.message ?? "", world.app), true);
  assert.equal(world.picked.length, 1);
});

test("a pick of a session by somebody else never reaches the core", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  world.remember(world.app, SESSION, "Fix it", 1);
  await world.flows.resume.word(await world.word(), "");
  const [list] = world.chat.lists();
  assert.equal(await world.chat.as(SOMEONE).picks(list?.message ?? "", SESSION), false);
  assert.deepEqual(world.picked, []);
  assert.equal(world.state.channel(world.channel)?.threads.size, 0);
  assert.equal(world.chat.lists().length, 1);
});
