/**
 * Step 9 of the scenario the memory chat carries: the agent's process dies with a permission
 * request waiting for the owner. The plain agent's `kill` is the process ending with no word
 * from the core.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { call, say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

interface Stored {
  channels: Record<string, { threads: Record<string, { requests: string[] }> }>;
}

test("a process lost while a request waits takes the request with it", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(
    say("Removing."),
    call("Shell", { command: "rm x" }, { permission: true }),
    say("Gone."),
  );
  const thread = await world.open("remove x");
  const asked = await world.request("permission", thread);
  const requests = (): string[] | undefined =>
    (JSON.parse(readFileSync(world.state, "utf8")) as Stored).channels[world.channel]?.threads[
      thread
    ]?.requests;
  assert.equal(requests()?.length, 1);

  world.plain.sessions.at(-1)?.kill();
  await world.until(() => world.chat.requests().length === 0, "the request withdrawn");

  assert.deepEqual(requests(), []);
  assert.deepEqual(world.plain.running, []);
  // The owner's late answer finds no control to press, and nothing reaches the agent.
  await assert.rejects(world.owner.answers(asked.requestId, { type: "permission", allow: true }));
  await world.settle();
  assert.deepEqual(world.prompts(), ["remove x"]);
  await world.finish();
});
