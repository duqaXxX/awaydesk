/**
 * Every kind of background work in one form (issue #311), replayed from `background-forms`:
 * recorded on 2026-10-15 with `@anthropic-ai/claude-agent-sdk` 0.3.300 and Claude Code 2.1.300,
 * in one session started with the daemon's options (Claude Code's system prompt, fork mode, the
 * owner's setting sources) and Haiku 4.5, then scrubbed.
 *
 * The recording: one message starts a Monitor that prints two lines, a command in the background
 * and an agent in the background, and the turn ends. The Monitor's second line wakes Claude Code,
 * which stops the Monitor with TaskStop in that turn; the command ends and gets a turn; the agent
 * ends and gets a turn. Claude Code opens each of those three turns by itself: no `user` record
 * comes before any of them, and only its result's `origin` (`task-notification`) says who opened
 * it. What woke the first one, the Monitor's line, is in no record the SDK yields.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { harnessFor, type Item, isResult, recordOf, sdkMessages } from "../../support/sessions.ts";

const NAME = "background-forms";
const LAUNCHED =
  "**3 background tasks launched**\n├ ticks\n├ Background sleep and echo\n└ Run sleep command and report";
const MONITOR_SAID = "I was told tick two appeared.";
const SHELL_ENDED = '✓ Background command "Background sleep and echo" completed (exit code 0)';
const SHELL_SAID = "The background sleep and echo command completed.";
const AGENT_ENDED = '✓ Agent "Run sleep command and report" finished';
const AGENT_SAID = "The agent completed and returned ok.";

/** The owner's turn, then what follows it: the three turns Claude Code opens by itself. */
function cut(): [turn: Item[], after: Item[]] {
  const items = sdkMessages(NAME);
  const first = items.findIndex(isResult);
  return [items.slice(0, first + 1), items.slice(first + 1)];
}

test("the recording is the one the test expects", () => {
  const [turn, after] = cut();
  const records = [...turn, ...after].map(recordOf);
  const results = records.filter((record) => record?.type === "result");
  assert.deepEqual(
    results.map((record) => (record?.origin as { kind?: string } | undefined)?.kind ?? null),
    [null, "task-notification", "task-notification", "task-notification"],
  );
  // No user record comes from a task's notification: nothing in the stream says what woke a turn.
  const woken = records.filter(
    (record) =>
      record?.type === "user" &&
      (record.origin as { kind?: string } | undefined)?.kind === "task-notification",
  );
  assert.deepEqual(woken, []);
});

test("a Monitor, a command and an agent in the background read in one form", async (t) => {
  const [turn, after] = cut();
  const h = harnessFor(t)({ turns: [turn] });
  await (await h.session().submit("start the three")).done.wait();
  h.clients[0]?.inject(after);
  await h.until(() => h.bodies().join("\n").includes(AGENT_SAID));
  for (let passes = 0; passes < 10; passes += 1) await h.sleep(0.5);
  assert.deepEqual(h.bodies(), [
    // One launch line for the three, whatever their kind, under the run of the calls.
    `${LAUNCHED}\n\nstarted`,
    // The Monitor's line is in no record: the turn it opens has the notice, and its stop is the
    // end line of any task in the background.
    `${texts.BACKGROUND_NOTICE}\n\n✓ ticks\n\n${MONITOR_SAID}`,
    `${SHELL_ENDED}\n\n${SHELL_SAID}`,
    `${AGENT_ENDED} · 23s\n\n${AGENT_SAID}`,
  ]);
  // The form adds no message: one reply for the owner's turn and one for each turn Claude Code
  // opened by itself, as before.
  assert.equal(h.slack.callsTo("chat.startStream").length, 4);
  assert.equal(h.slack.callsTo("chat.postMessage").length, 0);
});
