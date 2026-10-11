/**
 * The scenario's daemon over a config folder whose `state.json` cannot be written (read-only
 * here; a full disk throws the same way): the status write is best-effort, so a prompt still
 * reaches the agent and a stop still ends the run.
 */
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { test } from "node:test";
import { setWriter } from "../../src/log.ts";
import { hold, say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

const NEEDS_PERMISSIONS = { skip: process.platform === "win32" || process.getuid?.() === 0 };
const STATUS_LINE = "could not record the root's status in state.json";

/** Every line the daemon logs from now on. */
function logLines(t: Parameters<typeof World.make>[0]): string[] {
  const lines: string[] = [];
  const before = setWriter((line) => lines.push(line));
  t.after(() => void setWriter(before));
  return lines;
}

/** `work` with the config folder read-only, writable again once it returns. */
async function unwritable<T>(folder: string, work: () => Promise<T>): Promise<T> {
  chmodSync(folder, 0o500);
  try {
    return await work();
  } finally {
    chmodSync(folder, 0o700);
  }
}

test(
  "a reply in a rebuilt thread reaches the agent when the status write fails",
  NEEDS_PERMISSIONS,
  async (t) => {
    const world = World.make(t);
    await world.start();
    world.script(say("one"));
    const thread = await world.open("first");
    await world.ended(thread, 1);
    // A restart (an idle close does the same): the thread's session is rebuilt at its next message.
    await world.restart("SIGINT");
    const lines = logLines(t);

    world.script(say("two"));
    await unwritable(world.config, async () => {
      await world.owner.says(world.channel, "SECRET-SECOND-PROMPT", { thread });
      await world.until(() => world.prompts().length === 2, "the second prompt sent");
    });
    await world.ended(thread, 2);

    assert.deepEqual(world.prompts(), ["first", "SECRET-SECOND-PROMPT"]);
    const failed = lines.filter((line) => line.includes(STATUS_LINE));
    assert.ok(failed.length >= 1);
    assert.ok(failed.every((line) => line.endsWith("EACCES")));
    assert.ok(!lines.join("\n").includes("SECRET-SECOND-PROMPT"));
    // The owner is told nothing failed: the thread holds the two prompts, the setup's note and
    // the two replies, and no line of the daemon's own about a prompt that was not sent.
    assert.deepEqual(
      world.kinds(thread).map(([kind]) => kind),
      ["message", "notice", "reply", "message", "reply"],
    );
  },
);

test(
  "a stop with a turn running ends the run when the status write fails",
  NEEDS_PERMISSIONS,
  async (t) => {
    const world = World.make(t);
    await world.start();
    world.script(say("Working"), hold());
    const thread = await world.open("SECRET-FIRST-PROMPT");
    await world.until(() => world.shown(thread).length === 3, "the reply under way");
    const lines = logLines(t);

    assert.equal(await unwritable(world.config, () => world.stop("SIGINT")), 0);

    const failed = lines.filter((line) => line.includes(STATUS_LINE));
    assert.equal(failed.length, 1);
    assert.match(failed[0] ?? "", /EACCES$/);
    assert.ok(!lines.join("\n").includes("SECRET-FIRST-PROMPT"));
  },
);
