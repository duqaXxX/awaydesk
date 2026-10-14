/**
 * The status line under a thread (issues #83, #295 and #301): `Working…` while a prompt of the
 * owner's is owed its answer and while the agent says it works, `Compacting conversation…` while
 * any turn compacts, nothing otherwise. The line never counts what still runs (the list does).
 * Replayed over the real Slack provider on the fake Slack; the lines are the loading messages of
 * `assistant.threads.setStatus`, `""` where it was cleared. `session-state-shell` and
 * `session-state-agent` carry what Claude Code says of its own state; `tools`, `background`,
 * `subagent-handback`, `prompt-replay-before-notification` and `auto-compact-report-turn` were recorded before the
 * daemon asked for it, and stand for an agent that says nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVE } from "../../../src/core/requests.ts";
import { INJECTED_TURN_WAIT } from "../../../src/core/sessions/constants.ts";
import { CHANNEL, THREAD } from "../../support/fake-slack.ts";
import {
  canUseToolCall,
  END_OF_STREAM,
  harnessFor,
  type Item,
  isResult,
  isSystem,
  recordOf,
  sdkMessages,
  splitTurns,
} from "../../support/sessions.ts";
import {
  inside,
  isTaskRecord,
  pending,
  play,
  send,
  splitBackground,
  statusLines,
} from "./helpers.ts";

const WORKING = "Working…";
const COMPACTING = "Compacting conversation…";

/** The calls from the first `Working…` to the clear: nothing in between may blink. */
function assertSteady(lines: readonly string[]): void {
  const from = lines.indexOf(WORKING);
  assert.ok(from !== -1, "Working was shown");
  const to = lines.lastIndexOf("");
  assert.ok(to > from, "and then cleared");
  assert.ok(
    lines.slice(from, to).every((line) => line === WORKING),
    `the line blinked: ${JSON.stringify(lines)}`,
  );
}

function at<T>(list: readonly T[], index: number): T {
  const found = list.at(index);
  if (found === undefined) throw new Error(`nothing at ${index}`);
  return found;
}

test("an owner turn shows Working from the prompt to the end of its reply", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  assert.equal(statusLines(h)[0], WORKING);
  assertSteady(statusLines(h));
});

// The turn has started and left `sent`: only the active turn tells that its prompt is owed, and
// the line is worked out again when the answer to the approval comes in.
test("an owner turn says Working again after an approval, until its reply has ended", async (t) => {
  const messages = sdkMessages("tools");
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[...messages.slice(0, 21), ask, ...messages.slice(21)]] });
  const turn = await h.session().submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  await h.until(() => statusLines(h).at(-1) === "");
  const waiting = statusLines(h).length;
  const [approvalId] = pending(h.approvals);
  assert.ok(approvalId !== undefined);
  assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
  await turn.done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  assertSteady(statusLines(h).slice(waiting - 1));
});

test("a task that outlives its turn leaves the line empty, with no count", async (t) => {
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  await h.sleep(0.05);
  assert.ok(session.runningKinds !== "", "the task still runs");
  assert.equal(statusLines(h).at(-1), "");
  assert.ok(statusLines(h).every((line) => line === WORKING || line === ""));
});

test("an owner prompt sent while a background task runs shows Working", async (t) => {
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  const before = statusLines(h).length;
  const turn = await session.submit("list the files");
  await h.until(() => statusLines(h).slice(before).includes(WORKING));
  await turn.done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  assert.ok(session.runningKinds !== "", "the task still runs when the answer is in");
  assertSteady(statusLines(h).slice(before));
});

// Case 8 of #295: the turns of this recording that report a subagent and a command are the
// agent's own, with no prompt behind them. It was recorded before the daemon asked Claude Code
// for its state, so it stands for an agent that says nothing of it.
test("a report turn of a hand-back changes nothing when the agent says no state", async (t) => {
  const items = sdkMessages("subagent-handback");
  const results = items.flatMap((item, index) => (isResult(item) ? [index] : []));
  const [first, , third] = results as [number, number, number, number];
  const reportStarts = items.findIndex((item, index) => index > first && isSystem(item, "init"));
  const h = harnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("start both")).done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  await h.sleep(0.05);
  const before = statusLines(h);
  h.clients[0]?.inject(items.slice(first + 1, third + 1));
  await h.until(() => inside(session).reportDue === false && inside(session).active === null);
  await h.sleep(0.5);
  assert.ok(reportStarts > first);
  assert.deepEqual(
    statusLines(h)
      .slice(before.length)
      .filter((line) => line !== ""),
    [],
    "no line but a clear came with the report turns",
  );
  assert.equal(statusLines(h).at(-1), "");
});

/** Where the agent says `state` for the `nth` time in a recording. */
function stateAt(items: readonly Item[], state: string, nth: number): number {
  const found = items.flatMap((item, index) =>
    isSystem(item, "session_state_changed") && recordOf(item)?.state === state ? [index] : [],
  );
  return at(found, nth);
}

// Issue #301, recorded 2026-10-14: a background command ends, and Claude Code says it is running
// again 0.07 seconds after the notification, about a second before the report turn's first
// event. Until then the thread looked as it does once everything has ended.
test("a report turn shows Working from the task's end, before its first event", async (t) => {
  const items = sdkMessages("session-state-shell");
  const rests = stateAt(items, "idle", 0);
  const resumes = stateAt(items, "running", 1);
  const h = harnessFor(t)({ turns: [items.slice(0, rests + 1)] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  await h.sleep(0.05);
  assert.ok(session.runningKinds !== "", "the command still runs");
  assert.equal(statusLines(h).at(-1), "", "the agent rests while its command runs");
  const before = statusLines(h).length;
  h.clients[0]?.inject(items.slice(rests + 1, resumes + 1));
  await h.until(() => statusLines(h).at(-1) === WORKING);
  assert.equal(inside(session).active, null, "no turn has started yet");
  h.clients[0]?.inject(items.slice(resumes + 1));
  await h.until(() => statusLines(h).at(-1) === "");
  await h.idle();
  assertSteady(statusLines(h).slice(before));
  assert.equal(statusLines(h).at(-1), "");
});

// Claude Code says `idle` once for a subagent left in the background: after its report, with
// none at the end of the turn that launched it (recorded 2026-10-14).
test("a subagent left in the background keeps Working until its report has ended", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = harnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await h.sleep(0.05);
  assert.ok(session.runningKinds !== "", "the subagent still runs");
  assert.equal(statusLines(h).at(-1), WORKING);
  h.clients[0]?.inject(items.slice(first + 1));
  await h.until(() => statusLines(h).at(-1) === "");
  await h.idle();
  const lines = statusLines(h);
  assert.equal(lines.indexOf(""), lines.length - 1, "cleared once, at the end");
  assertSteady(lines);
});

// No recording holds what Claude Code says after a task is stopped with no turn running: the
// owner's stop does not wait for it.
test("a stop of a subagent left in the background clears the line at once", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = harnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await h.sleep(0.05);
  assert.equal(statusLines(h).at(-1), WORKING);
  assert.equal(await session.stop(), true);
  assert.equal(h.clients[0]?.stoppedTasks.length, 1);
  await h.until(() => statusLines(h).at(-1) === "");
  await h.sleep(0.05);
  assert.equal(statusLines(h).at(-1), "");
});

// A lost process never says that it rests.
test("a process lost while the agent says it works clears the line", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = harnessFor(t)({ turns: [items.slice(0, first + 1)] });
  await (await h.session().submit("launch it")).done.wait();
  await h.sleep(0.05);
  assert.equal(statusLines(h).at(-1), WORKING);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => statusLines(h).at(-1) === "");
  await h.sleep(0.05);
  assert.equal(statusLines(h).at(-1), "");
});

// `prompt-replay-before-notification`: the prompt is sent just before a background command ends.
interface Crossing {
  readonly owner: Item[];
  readonly notice: Item[];
  readonly own: Item[];
  readonly report: Item[];
}

function crossing(): Crossing {
  const m = sdkMessages("prompt-replay-before-notification");
  const ends = m.flatMap((item, index) => (isResult(item) ? [index] : []));
  const [first, second, third] = ends as [number, number, number];
  const middle = m.slice(first + 1, second + 1);
  return {
    owner: m.slice(0, first + 1),
    notice: middle.filter(isTaskRecord),
    own: middle.filter((item) => !isTaskRecord(item)),
    report: m.slice(second + 1, third + 1),
  };
}

// The sequence of Task 3: a reply waits on a task, the notification arrives, the owner's
// message is submitted, the report turn starts first (it opens its own reply below the
// owner's message) and the prompt's turn follows. The order of the two turns is composed from the
// recording's records, as in `prompt-replay.test.ts` ("a report turn that starts while a prompt
// waits"); the recording holds the other order.
test("a prompt that crosses a notification keeps Working until its reply has ended", async (t) => {
  const c = crossing();
  const h = harnessFor(t)({});
  const session = h.session();
  const opening = await send(h, session, "start a background command");
  play(h, c.owner);
  await opening.done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  const from = statusLines(h).length;
  const prompt = await send(h, session, "Reply with the single word PINEAPPLE.");
  await h.until(() => statusLines(h).at(-1) === WORKING);
  h.clients[0]?.inject(c.notice);
  await h.sleep(0.05);
  h.clients[0]?.inject(c.report);
  await h.until(
    () => inside(session).active === null && h.replies().join("\n").includes("REPORTED"),
  );
  await h.sleep(0.05);
  assert.ok(!prompt.done.isSet, "the prompt still waits for its turn");
  assert.equal(statusLines(h).at(-1), WORKING, "the report turn ended and the prompt is owed");
  play(h, c.own);
  await prompt.done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  const shown = statusLines(h).slice(from);
  assert.equal(shown.indexOf(""), shown.length - 1, "cleared once, at the end");
  assert.ok(shown.every((line) => line === WORKING || line === ""));
});

test("a report turn that compacts shows the compacting text, not Working", async (t) => {
  const [first, report] = splitTurns(sdkMessages("auto-compact-report-turn")) as [Item[], Item[]];
  const compacting = report.findIndex(
    (item) => isSystem(item, "status") && recordOf(item)?.status === "compacting",
  );
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  const before = statusLines(h).length;
  h.clients[0]?.inject(report.slice(0, compacting + 1));
  await h.until(() => statusLines(h).at(-1) === COMPACTING);
  await h.clock.advance(INJECTED_TURN_WAIT * 6);
  assert.equal(statusLines(h).at(-1), COMPACTING);
  h.clients[0]?.inject(report.slice(compacting + 1));
  await h.until(() => h.slack.callsTo("chat.stopStream").length > 0);
  await h.until(() => statusLines(h).at(-1) === "");
  assert.ok(!statusLines(h).slice(before).includes(WORKING), "a report turn is not Working");
  assert.ok(at(statusLines(h).slice(before), 0) === COMPACTING);
});
