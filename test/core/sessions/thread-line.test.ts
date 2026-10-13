/**
 * The status line under a thread (issues #83 and #295): `Working…` while a prompt of the owner's
 * is owed its answer, `Compacting conversation…` while any turn compacts, nothing otherwise. A
 * turn the agent starts on its own to report a task owes nobody an answer, and the line never
 * counts what still runs (the footer does). Replayed from `tools`, `background`,
 * `subagent-handback`, `prompt-replay-before-notification` and `auto-compact-report-turn`, over
 * the real Slack provider on the fake Slack; the lines are the loading messages of
 * `assistant.threads.setStatus`, `""` where it was cleared.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { INJECTED_TURN_WAIT } from "../../../src/core/sessions/constants.ts";
import {
  harnessFor,
  type Item,
  isResult,
  isSystem,
  recordOf,
  sdkMessages,
  splitTurns,
} from "../../support/sessions.ts";
import { inside, isTaskRecord, play, send, splitBackground, statusLines } from "./helpers.ts";

const WORKING = "Working…";
const COMPACTING = "Compacting conversation…";

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
  assert.ok(statusLines(h).every((line) => line === WORKING || line === ""));
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
  assert.ok(statusLines(h).every((line) => line === WORKING || line === ""));
});

// Case 8 of #295: the turns of this recording that report a subagent and a command are the
// agent's own, with no prompt behind them.
test("a report turn of a hand-back changes nothing", async (t) => {
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
