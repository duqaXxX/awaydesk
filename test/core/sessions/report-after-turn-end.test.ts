/**
 * A background subagent that ends while a turn runs (issue #317). Claude Code either folds its
 * notification into that turn, and replays the envelope as a user record that names the run, or
 * opens a turn of its own once the turn has ended, with no such record. Recorded on 2026-10-15
 * with `@anthropic-ai/claude-agent-sdk` 0.3.300 and Claude Code 2.1.300, Haiku 5.5, the daemon's
 * options (`replay-user-messages` included), then scrubbed:
 *
 * - `task-end-in-turn-folded`: the subagent ends during a foreground command, the envelope is
 *   replayed (with its `runId`) before the turn's result, and no turn follows.
 * - `task-end-in-turn-unfolded`: the subagent ends while the final answer is written; the turn's
 *   result has no origin, no envelope is replayed, and a turn opened from idle (origin
 *   `task-notification`, the same `runId`) reports it.
 *
 * One footer per stretch between two owner messages, under the last reply (#290, #298).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { INJECTED_TURN_WAIT } from "../../../src/core/sessions/constants.ts";
import {
  type Harness,
  harnessFor,
  isResult,
  recordOf,
  sdkMessages,
} from "../../support/sessions.ts";

/** Whether each message of the thread, in the order they were made, shows a footer now. */
function footers(h: Harness): boolean[] {
  return h.slack.createdTs.map(
    (ts) => h.slack.messages.get(ts)?.blocks.some((block) => block.type === "divider") ?? false,
  );
}

/** The owner's turn, then what follows it. */
function cut(name: string) {
  const items = sdkMessages(name);
  const first = items.findIndex(isResult);
  return { turn: items.slice(0, first + 1), after: items.slice(first + 1) };
}

/** The footer is on the thread's last message and on no other. */
function assertOneAtTheEnd(h: Harness): void {
  const shown = footers(h);
  assert.deepEqual(
    shown,
    shown.map((_, index) => index === shown.length - 1),
    `one footer, under the last message: ${JSON.stringify(shown)}`,
  );
}

/** No message shows a footer. */
function assertNone(h: Harness, why: string): void {
  assert.ok(
    footers(h).every((shown) => !shown),
    why,
  );
}

async function settled(h: Harness): Promise<void> {
  await h.idle();
  await h.sleep(3);
}

test("the unfolded recording is the one the tests expect", () => {
  const { turn, after } = cut("task-end-in-turn-unfolded");
  const users = [...turn, ...after].flatMap((item) =>
    "record" in item && item.record.type === "user" && item.record.origin !== undefined
      ? [item.record]
      : [],
  );
  assert.deepEqual(users, [], "no envelope is replayed, in the turn or after it");
  const ended = turn.some(
    (item) => "record" in item && item.record.subtype === "task_notification",
  );
  assert.ok(ended, "the task ends inside the owner's turn");
});

test("a task that ends in a turn and is reported in a turn after it: one reply, one footer", async (t) => {
  const { turn, after } = cut("task-end-in-turn-unfolded");
  const h = harnessFor(t)({ turns: [turn] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assertNone(h, "the reply rests with no footer: a report is due");
  h.clients[0]?.inject(after);
  await h.until(() => session.idle);
  await settled(h);
  assert.equal(h.slack.callsTo("chat.startStream").length, 1, "the report renders into the reply");
  assertOneAtTheEnd(h);
});

test("a notification folded into the turn keeps the reply closing with its footer", async (t) => {
  const { turn, after } = cut("task-end-in-turn-folded");
  const h = harnessFor(t)({ turns: [[...turn, ...after]] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assertOneAtTheEnd(h);
  assert.equal(h.slack.callsTo("chat.startStream").length, 1);
});

test("an agent that does not say what it folds keeps the footer at the turn's end", async (t) => {
  const { turn } = cut("task-end-in-turn-unfolded");
  const h = harnessFor(t)({ turns: [turn] });
  h.backend.capabilities = { ...h.backend.capabilities, foldedNotifications: false };
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assertOneAtTheEnd(h);
});

test("no report turn comes: the wait ends and the reply closes with its footer", async (t) => {
  const { turn } = cut("task-end-in-turn-unfolded");
  const h = harnessFor(t)({ turns: [turn] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assertNone(h, "the reply rests with no footer: a report is due");
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a task that ends unfolded inside the owner's next turn leaves one footer, under its report", async (t) => {
  // The recording cut at the main thread's last message before the agent ends: the first turn
  // launches the agent and ends (its result reused), and the owner's next turn is that message,
  // during which the agent ends with no replay.
  const { turn, after } = cut("task-end-in-turn-unfolded");
  const end = turn.findIndex((item) => recordOf(item)?.subtype === "task_updated");
  const start = turn.findLastIndex((item, index) => {
    const record = recordOf(item);
    const event = record?.event as { type?: string } | undefined;
    return (
      index < end &&
      record?.type === "stream_event" &&
      record.parent_tool_use_id === null &&
      event?.type === "message_start"
    );
  });
  const result = turn.at(-1);
  assert.ok(start > 0 && result !== undefined);
  const h = harnessFor(t)({ turns: [[...turn.slice(0, start), result], turn.slice(start)] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  await (await session.submit("something else")).done.wait();
  await settled(h);
  h.clients[0]?.inject(after);
  await h.until(() => session.idle);
  await settled(h);
  // The stretch after the owner's second message: one footer, under its last message.
  const second = footers(h).slice(1);
  assert.deepEqual(
    second,
    second.map((_, index) => index === second.length - 1),
    `one footer after the second prompt: ${JSON.stringify(footers(h))}`,
  );
  // The first reply rests for the agent, whose reply is no longer last, so the report renders
  // into the second reply, which rests too, and opens none of its own.
  assert.equal(h.slack.callsTo("chat.startStream").length, 2);
});
