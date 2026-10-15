/**
 * Every kind of background work in one form (issue #311), replayed from `background-forms`:
 * recorded on 2026-10-15 with `@anthropic-ai/claude-agent-sdk` 0.3.300 and Claude Code 2.1.300,
 * in one session started with the daemon's options (Claude Code's system prompt, fork mode, the
 * owner's setting sources, `replay-user-messages`) and Haiku 5.5, then scrubbed.
 *
 * The recording: one message starts a Monitor that prints two lines, a command in the background
 * and an agent in the background. The Monitor's first line comes while that turn still runs:
 * Claude Code folds it in, and replays the prompt that carries it. The second line wakes Claude
 * Code once the turn has ended, and it stops the Monitor with TaskStop in that turn; the command
 * ends and gets a turn; the agent ends and gets a turn. Claude Code opens each of those three
 * turns by itself: no `user` record comes before any of them, and only its result's `origin`
 * (`task-notification`) says who opened it. What woke the first one, the Monitor's line, is in
 * no record the SDK yields.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessFor, type Item, isResult, recordOf, sdkMessages } from "../../support/sessions.ts";

const NAME = "background-forms";
const LAUNCHED =
  "**3 background tasks launched**\n├ ticks\n├ Sleep 12 seconds then print done\n└ Run sleep 20 and reply ok";
const STARTED =
  'The Monitor reported "tick one"; I\'m waiting for "tick two" before stopping it with TaskStop.';
const MONITOR_SAID =
  'I was told the Monitor printed "tick two", so I stopped it with TaskStop and it is now shut down.';
const SHELL_ENDED =
  '✓ Background command "Sleep 12 seconds then print done" completed (exit code 0)';
const SHELL_SAID =
  "I was told the background `sleep 12; echo done` command finished with exit code 0.";
const AGENT_ENDED = '✓ Agent "Run sleep 20 and reply ok" finished';
const AGENT_SAID = 'I was told the subagent that ran `sleep 20` finished and replied "ok".';

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
  // The one user record of a task's notification is the line folded into the owner's turn: none
  // comes after it, so nothing in the stream says what woke a turn Claude Code opened itself.
  const first = records.findIndex((record) => record?.type === "result");
  const woken = records.flatMap((record, index) =>
    record?.type === "user" &&
    (record.origin as { kind?: string } | undefined)?.kind === "task-notification"
      ? [index]
      : [],
  );
  assert.equal(woken.length, 1);
  assert.ok((woken[0] ?? Infinity) < first);
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
    `${LAUNCHED}\n\n${STARTED}`,
    // The Monitor's line is in no record: the turn it opens has no line to say what woke it,
    // and its stop is the end line of any task in the background.
    `✓ ticks\n\n${MONITOR_SAID}`,
    `${SHELL_ENDED}\n\n${SHELL_SAID}`,
    `${AGENT_ENDED} · 23s\n\n${AGENT_SAID}`,
  ]);
  // The form adds no message: one reply for the owner's turn and one for each turn Claude Code
  // opened by itself, as before.
  assert.equal(h.slack.callsTo("chat.startStream").length, 4);
  assert.equal(h.slack.callsTo("chat.postMessage").length, 0);
});

test("a turn Claude Code opens by itself with no end to report opens with its text alone", async (t) => {
  const [turn, after] = cut();
  // The command's end taken out: the turn that reports it is one nothing seen opened, as for a
  // Monitor's line that does not stop the Monitor (the owner's test on Slack, 2026-10-15).
  const shellId = turn
    .map(recordOf)
    .find(
      (record) =>
        record?.subtype === "task_started" &&
        record.task_type === "local_bash" &&
        record.description !== "ticks",
    )?.task_id;
  assert.ok(typeof shellId === "string");
  const unended = after.filter((item) => {
    const record = recordOf(item);
    const subtype = record?.type === "system" ? record.subtype : null;
    return !(
      (subtype === "task_notification" || subtype === "task_updated") &&
      record?.task_id === shellId
    );
  });
  const h = harnessFor(t)({ turns: [turn] });
  await (await h.session().submit("start the three")).done.wait();
  h.clients[0]?.inject(unended);
  await h.until(() => h.bodies().join("\n").includes(AGENT_SAID));
  for (let passes = 0; passes < 10; passes += 1) await h.sleep(0.5);
  assert.equal(h.bodies()[2], SHELL_SAID);
});
