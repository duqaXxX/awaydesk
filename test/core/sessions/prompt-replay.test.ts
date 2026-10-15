/**
 * A prompt Claude Code takes into a running turn, known from the replay of the prompt (issue
 * #150), replayed from recordings made on 2026-10-06 with claude-agent-sdk 0.2.163 and its
 * bundled CLI 2.1.286, with `--replay-user-messages` (`prompt-replay-<scene>`).
 *
 * Measured there: Claude Code re-emits each prompt as a `user` record carrying the uuid the
 * caller sent. A prompt that gets a turn of its own is replayed after that turn's `init` and
 * before its first stream event; a prompt taken into a running turn is replayed inside that
 * turn, before its one result, which has an injected origin and none follows for the prompt.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { PromptContent } from "../../../src/agent/seam.ts";
import { TurnRenderer } from "../../../src/core/reply/renderer.ts";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import { cancellable } from "../../../src/core/sessions/tasks.ts";
import { type Turn, takenNote } from "../../../src/core/sessions/turn.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { CHANNEL, THREAD } from "../../support/fake-slack.ts";
import { NAMES } from "../../support/names.ts";
import {
  END_OF_STREAM,
  type Harness,
  harnessFor,
  type Item,
  isResult,
  isSystem,
  recordOf,
  sdkMessages,
} from "../../support/sessions.ts";
import {
  acknowledged,
  assertNothingRuns,
  assertStopHasNothingToStop,
  commandRuns,
  inside,
  isReplay,
  isTaskRecord,
  isTopLevelCall,
  logged,
  play,
  said,
  send,
  toolUseOf,
  withResult,
  workerHolds,
} from "./helpers.ts";

const PROMPT = "Reply with the single word PINEAPPLE.";

/**
 * A recording cut at the owner's first result, the report turn's start, its first call and its
 * result (`reported`), and the result of the prompt's own turn.
 */
interface Scene {
  readonly owner: Item[];
  readonly notice: Item[];
  /** The report turn up to and including its first tool call. */
  readonly head: Item[];
  /** From there to the report turn's one result. */
  readonly rest: Item[];
  /** The turn Claude Code starts for the prompt, when it is not taken in. */
  readonly own: Item[];
  /** Null: the report turn makes no call (`at-init`). */
  readonly callId: string | null;
}

function scene(name: string): Scene {
  const m = sdkMessages(`prompt-replay-${name}`);
  const results = m.flatMap((item, index) => (isResult(item) ? [index] : []));
  const [first, second, third] = results as [number, number, number];
  const notified = m.findIndex((item) => isSystem(item, "task_notification"));
  const report = m.findIndex((item, index) => index >= notified && isSystem(item, "init"));
  assert.ok(notified !== -1 && report !== -1);
  let call = second - 1;
  for (let index = report; index < second; index += 1) {
    if (isTopLevelCall(m[index])) {
      call = index;
      break;
    }
  }
  return {
    owner: m.slice(0, first + 1),
    notice: m.slice(first + 1, report),
    head: m.slice(report, call + 1),
    rest: m.slice(call + 1, second + 1),
    own: m.slice(second + 1, third + 1),
    callId: toolUseOf(m[call]),
  };
}

/** The owner's first prompt, which starts a background command and ends. */
async function firstTurn(
  h: Harness,
  session: ThreadSession,
  r: { readonly owner: Item[] },
): Promise<void> {
  const turn = await send(h, session, "start a background command");
  play(h, r.owner);
  await turn.done.wait();
}

/**
 * The state the live hang had: a report turn runs a command while the session holds no
 * expectation of one (it is settled), so the owner's prompt is sent into it at once. The
 * notification records reach the session once the turn runs (a notification during a turn
 * reaches no `notified`), as the continued agent's did; they are the recording's own, only
 * their place differs.
 */
async function promptDuringTheReportTurn(
  h: Harness,
  session: ThreadSession,
  r: Scene,
): Promise<Turn> {
  await firstTurn(h, session, r);
  h.clients[0]?.inject(r.head);
  assert.ok(r.callId !== null);
  await commandRuns(h, session, r.callId);
  h.clients[0]?.inject(r.notice);
  await h.until(() => inside(session).tasks.size === 0);
  const prompt = await send(h, session, PROMPT);
  const active = inside(session).active;
  assert.ok(active !== null && active.turn === null);
  return prompt;
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

test("a prompt taken into a report turn is released when that turn ends", async (t) => {
  const r = scene("during-tool");
  const h = harnessFor(t)({});
  const session = h.session();
  const prompt = await promptDuringTheReportTurn(h, session, r);
  play(h, r.rest); // the replay is in it, with the command's result; one result ends both
  await prompt.done.wait();
  await h.until(() => inside(session).active === null);
  assertNothingRuns(h, session);
  assert.ok(said(h).includes(texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)));
  assert.ok(!said(h).includes("PINEAPPLE")); // the replay is an acknowledgement, never text
  // the owner's first reply, the report's
  assert.equal(h.slack.callsTo("chat.startStream").length, 2);
  await assertStopHasNothingToStop(h, session);
});

test("a prompt sent just before a report turn starts is released with it", async (t) => {
  // The prompt is sent when the report turn's first record arrives, so `startTurn` makes it the
  // turn's owner; the recording's own records then show Claude Code took it in.
  const r = scene("during-tool");
  const h = harnessFor(t)({});
  const session = h.session();
  await firstTurn(h, session, r);
  const prompt = await send(h, session, PROMPT);
  play(h, [...r.notice, ...r.head, ...r.rest]);
  await prompt.done.wait();
  await h.until(() => inside(session).active === null);
  assertNothingRuns(h, session);
  assert.ok(said(h).includes(texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)));
  // the prompt's reply holds the report
  assert.equal(h.slack.callsTo("chat.startStream").length, 2);
  await assertStopHasNothingToStop(h, session);
});

for (const name of ["at-init", "after-tools"]) {
  test(`a prompt not taken in gets its own turn and reply [${name}]`, async (t) => {
    // `at-init`: the prompt reached Claude Code at the report turn's `init`. `after-tools`: the
    // report turn had no tool result left and was writing its text. Both report turns end with
    // their own result and Claude Code then starts a turn for the prompt. The daemon holds the
    // prompt until the report turn ends, so it sends it after that result and the replay comes
    // with no turn running: nothing is released early and no note says the prompt was taken.
    const r = scene(name);
    const h = harnessFor(t)({});
    const session = h.session();
    await firstTurn(h, session, r);
    play(h, r.notice);
    await h.until(() => !inside(session).settled.isSet);
    h.clients[0]?.inject([...r.head, ...r.rest.slice(0, -1)]);
    await h.until(() => inside(session).active !== null);
    const prompt = await session.submit(PROMPT);
    await workerHolds(h, session, prompt);
    assert.equal(h.clients[0]?.sent.length, 1);
    h.clients[0]?.inject(r.rest.slice(-1));
    await h.until(() => h.clients[0]?.sent.length === 2);
    assert.ok(!prompt.done.isSet);
    play(h, r.own);
    await prompt.done.wait();
    await h.until(() => inside(session).active === null);
    assertNothingRuns(h, session);
    assert.ok(!said(h).includes(texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)));
    assert.ok(said(h).includes("PINEAPPLE")); // the answer, not the replay of the question
    assert.equal(h.slack.callsTo("chat.startStream").length, 2);
    await assertStopHasNothingToStop(h, session);
  });
}

/**
 * The report turn has ended with no replay of the prompt in it: the prompt is still owed a
 * turn, which Claude Code starts and replays it at (`at-init`, `after-tools`).
 */
async function ownTurnFollows(
  h: Harness,
  session: ThreadSession,
  r: Scene,
  prompt: Turn,
): Promise<void> {
  await h.until(() => inside(session).active === null);
  assert.ok(!prompt.done.isSet);
  // held across the report's result
  assert.ok(inside(session).sent.length === 1 && inside(session).sent[0] === prompt);
  play(h, r.own);
  await prompt.done.wait();
  await h.until(() => inside(session).active === null);
  assertNothingRuns(h, session);
  assert.ok(!said(h).includes(texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)));
  assert.ok(said(h).includes("PINEAPPLE"));
  // The first reply (which the report also renders into), and the prompt's own.
  assert.equal(h.slack.callsTo("chat.startStream").length, 3);
  await assertStopHasNothingToStop(h, session);
}

for (const name of ["at-init", "after-tools"]) {
  test(`a prompt sent into a report turn but not taken in keeps its place [${name}]`, async (t) => {
    const r = scene(name);
    const h = harnessFor(t)({});
    const session = h.session();
    let prompt: Turn;
    if (r.callId === null) {
      // `at-init` makes no call: the prompt goes in once the turn runs
      await firstTurn(h, session, r);
      h.clients[0]?.inject(r.head);
      await h.until(() => inside(session).active !== null);
      h.clients[0]?.inject(r.notice);
      await h.until(() => inside(session).tasks.size === 0);
      prompt = await send(h, session, PROMPT);
    } else {
      prompt = await promptDuringTheReportTurn(h, session, r);
    }
    play(h, r.rest); // the report's one result, no replay in it
    await ownTurnFollows(h, session, r, prompt);
  });
}

for (const name of ["at-init", "after-tools"]) {
  test(`a prompt given to a report turn that did not take it is put back [${name}]`, async (t) => {
    // `startTurn` makes the prompt the report turn's owner; with no replay in the turn the
    // result's origin sends it back to wait for its own turn.
    const r = scene(name);
    const h = harnessFor(t)({});
    const session = h.session();
    await firstTurn(h, session, r);
    const prompt = await send(h, session, PROMPT);
    play(h, [...r.notice, ...r.head, ...r.rest]);
    await h.until(() => inside(session).active === null && inside(session).sent.includes(prompt));
    await ownTurnFollows(h, session, r, prompt);
  });
}

test("stop after a prompt was taken in releases it once", async (t) => {
  // Assembled from two recordings, not recorded as one: `during-tool` up to the replay, then
  // the interrupted ending of `stop-queued`. What Claude Code does with a prompt it took in
  // when an interrupt arrives is not measured; this pins what the daemon does if the result is
  // the interrupted one with an injected origin.
  const r = scene("during-tool");
  // the result of the cut command, the note, the result
  const ending = scene("stop-queued").rest.slice(-3);
  assert.ok(isResult(ending.at(-1)));
  assert.equal(recordOf(ending.at(-1))?.terminal_reason, "aborted_tools");
  const h = harnessFor(t)({});
  const session = h.session();
  const prompt = await promptDuringTheReportTurn(h, session, r);
  const replayed = r.rest.findIndex(isReplay);
  assert.notEqual(replayed, -1);
  play(h, r.rest.slice(0, replayed + 1));
  await h.until(() => (inside(session).active?.taken.length ?? 0) > 0);
  assert.equal(await session.stop(), true);
  h.clients[0]?.inject(ending);
  await prompt.done.wait();
  await h.until(() => inside(session).active === null);
  assertNothingRuns(h, session);
  assert.equal(count(said(h), texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)), 1);
  await assertStopHasNothingToStop(h, session);
});

test("stop during a report turn with a prompt queued leaves nothing behind", async (t) => {
  // `stop-queued`: `interrupt()` ends the report turn with `error_during_execution`, and the
  // prompt queued behind it runs as a turn of its own with a result of its own.
  const r = scene("stop-queued");
  const h = harnessFor(t)({});
  const session = h.session();
  const prompt = await promptDuringTheReportTurn(h, session, r);
  assert.equal(await session.stop(), true);
  assert.equal(h.clients[0]?.interrupts, 1);
  play(h, r.rest); // no replay in it: the prompt was queued, not taken in
  await h.until(() => inside(session).active === null);
  assert.ok(!prompt.done.isSet);
  play(h, r.own);
  await prompt.done.wait();
  await h.until(() => inside(session).active === null);
  assertNothingRuns(h, session);
  assert.ok(!said(h).includes(texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)));
  await assertStopHasNothingToStop(h, session);
});

test("a replay naming no sent prompt acknowledges nothing", async (t) => {
  // A resumed session, or anything else the daemon did not send: its uuid is nobody's.
  const r = scene("during-tool");
  const h = harnessFor(t)({});
  const session = h.session();
  const prompt = await promptDuringTheReportTurn(h, session, r);
  h.clients[0]?.inject(acknowledged(r.rest, "00000000-0000-4000-8000-000000000000"));
  await h.until(() => inside(session).active === null);
  assert.ok(!prompt.done.isSet);
  assert.ok(inside(session).sent.length === 1 && inside(session).sent[0] === prompt);
  assert.ok(!said(h).includes(texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)));
  play(h, r.own);
  await prompt.done.wait();
  assertNothingRuns(h, session);
});

test("a prompt taken in when the client ends is noted as not sent", async (t) => {
  const r = scene("during-tool");
  const h = harnessFor(t)({});
  const session = h.session();
  const prompt = await promptDuringTheReportTurn(h, session, r);
  play(h, r.rest.slice(0, -1)); // up to the replay, before the result
  await h.until(() => (inside(session).active?.taken.length ?? 0) > 0);
  h.clients[0]?.inject([END_OF_STREAM]);
  await prompt.done.wait();
  await h.until(() => !session.busy);
  assert.equal(inside(session).sent.length, 0);
  const note = texts.fill(texts.NOT_SENT_ONE, {
    count: 1,
    because: texts.named(texts.BECAUSE_STOPPED, NAMES),
  });
  assert.ok(said(h).includes(note));
});

// Issue #263: the result that releases the prompt arrived, and a close then cut the reply's
// close. The agent took the prompt, so the reply says so, as at a normal end.
test("a prompt taken into a turn whose end a close cut is said to be taken, not unsent", async (t) => {
  const r = scene("during-tool");
  const h = harnessFor(t)({});
  const session = h.session();
  const prompt = await promptDuringTheReportTurn(h, session, r);
  const client = h.clients[0];
  assert.ok(client !== undefined);
  let reading = false;
  let footerRead: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    footerRead = resolve;
  });
  const original = client.contextUsage.bind(client);
  client.contextUsage = async () => {
    reading = true;
    await held;
    return original();
  };
  play(h, r.rest); // the replay, then the one result
  await h.until(() => reading); // the reader is inside `finish`, waiting for the footer
  await session.close();
  footerRead();
  assert.ok(prompt.done.isSet);
  assert.equal(count(said(h), texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)), 1);
  assert.ok(!said(h).includes("was not sent"));
  assert.ok(!said(h).includes(texts.fill(texts.ENDED, { reason: texts.ENDED_SHUTDOWN })));
});

// Issue #263, from the review of its first commit: what else a close can cut in that window.

/**
 * Hold the close of the turn's reply, so the reader stays inside `finish` before the reply's end
 * is asked for: the footer is read only by an end that ends the session, and these ends do not.
 * The wait gives way to the reader's cancel, as the footer's read did.
 */
function holdFooter(t: TestContext): { reading: () => boolean; release: () => void } {
  let reading = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = TurnRenderer.prototype.close;
  t.mock.method(
    TurnRenderer.prototype,
    "close",
    async function (this: TurnRenderer, signal?: AbortSignal) {
      // only the turn's own close waits: the close's `abandon` closes the reply again
      if (!reading) {
        reading = true;
        await cancellable(held, signal);
      }
      return original.call(this, signal);
    },
  );
  return { reading: () => reading, release };
}

test("a close that cuts a turn's end while an earlier reply's command still runs keeps the status of a cut", async (t) => {
  const { c, h, session } = crossed(t);
  await firstTurn(h, session, c);
  assert.equal(session.runningKinds, "1 shell"); // the first turn left its command running
  const prompt = await send(h, session, PROMPT);
  const hold = holdFooter(t);
  play(h, c.own);
  await h.until(() => hold.reading());
  // The command belongs to the earlier reply, not to the turn being ended.
  assert.equal(inside(session).active?.renderer.runningTasks.length, 0);
  await session.close();
  hold.release();
  assert.ok(prompt.done.isSet);
  assert.equal(h.state.thread(CHANNEL, THREAD)?.ended, "error");
});

test("a prompt whose turn a report's result ended is said not to be sent when a close cuts that end", async (t) => {
  const { c, h, session } = crossed(t);
  await firstTurn(h, session, c);
  const prompt = await send(h, session, PROMPT);
  const hold = holdFooter(t);
  // The report turn with no notification before it: the turn's start takes the owner's prompt.
  h.clients[0]?.inject(c.report);
  await h.until(() => hold.reading());
  const active = inside(session).active;
  assert.ok(active !== null && active.turn === prompt);
  assert.equal(active.taken.length, 0);
  await session.close();
  hold.release();
  assert.ok(prompt.done.isSet);
  // The reply holds the report, not the prompt's answer: the note names the prompt, once.
  assert.equal(count(said(h), "was not sent"), 1);
  assert.equal(count(said(h), "PINEAPPLE"), 1);
  assert.equal(h.state.thread(CHANNEL, THREAD)?.ended, "error");
});

test("a close that lands in the reply's last write says once that the prompt was taken", async (t) => {
  const r = scene("during-tool");
  const h = harnessFor(t)({});
  const session = h.session();
  const prompt = await promptDuringTheReportTurn(h, session, r);
  play(h, r.rest.slice(0, -1)); // up to the replay, before the result
  await h.until(() => (inside(session).active?.taken.length ?? 0) > 0);
  await h.sleep(0.3);
  h.slack.gate = new AsyncEvent();
  h.slack.gateMethod = "chat.startStream";
  // The result: the footer is read at once, `finish` writes the note, and the reply's last write
  // is held at the gate.
  const result = r.rest.at(-1);
  assert.ok(result !== undefined);
  h.clients[0]?.inject([result]);
  await h.slack.gated.wait();
  const closing = session.close();
  await h.until(() => session.closed);
  h.slack.gate.set();
  await closing;
  assert.ok(prompt.done.isSet);
  assert.ok(!said(h).includes("was not sent"));
  assert.equal(count(said(h), texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES)), 1);
});

test("the note counts the prompts taken in", () => {
  // The worker sends one prompt at a time, so a turn takes in one today; the note reads `taken`.
  assert.equal(takenNote(1, NAMES), texts.named(texts.TAKEN_INTO_REPLY_ONE, NAMES));
  assert.equal(
    takenNote(2, NAMES),
    "Claude Code took 2 messages into this reply: " +
      "send them again if they are not answered here.",
  );
});

test("every prompt goes out with a uuid of the daemons own", async (t) => {
  const h = harnessFor(t)({ turns: [[], [], []] });
  const session = h.session();
  const blocks: PromptContent = [{ type: "text", text: "look at this" }];
  for (const prompt of ["first", "/usage", blocks]) {
    const turn = await send(h, session, prompt);
    turn.done.set();
  }
  const client = h.clients[0];
  assert.ok(client !== undefined);
  // The SDK's side of the client (the `replay-user-messages` argument, the `user` type and the
  // null parent of each message sent) is the back end's to test: here, what the core hands the
  // seam.
  assert.deepEqual(
    client.sent.map((prompt) => prompt.content),
    ["first", "/usage", blocks],
  );
  const uuids = client.sent.map((prompt) => prompt.id);
  assert.ok(uuids.every((uuid) => typeof uuid === "string" && uuid !== ""));
  assert.equal(new Set(uuids).size, 3);
  // a string prompt keeps its string content
  assert.deepEqual(client.queries.slice(0, 2), ["first", "/usage"]);
});

// --- Whose turn starts, known from the replay (issue #205) ---------------------------------------
// `prompt-replay-before-notification`: recorded on 2026-10-09 with claude-agent-sdk 0.2.164 and
// its bundled CLI 2.1.292. The prompt is sent just before a background command's notification:
// its turn opens with `init`, the notification, the replay and then its words; the turn that
// reports the command follows on its own, with no replay before its words.

interface Crossing {
  /** The first prompt's turn, which starts the background command. */
  readonly owner: Item[];
  /** The task records that end the command, as they come with no turn running. */
  readonly notice: Item[];
  /** The crossing prompt's turn, replay included, without the task records. */
  readonly own: Item[];
  /** The turn Claude Code starts to report the command. */
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

function misrouted(warnings: readonly string[]): string[] {
  return warnings.filter((line) => line.includes(" went to a"));
}

/** Which reply holds `word`: its place among the replies that say something. */
function replyWith(h: Harness, word: string): number {
  const places = h.bodies().flatMap((body, index) => (body.includes(word) ? [index] : []));
  assert.equal(places.length, 1);
  return places[0] as number;
}

function crossed(t: TestContext): {
  c: Crossing;
  h: Harness;
  session: ThreadSession;
  warnings: string[];
} {
  const warnings = logged(t, "warning");
  const h = harnessFor(t)({});
  return { c: crossing(), h, session: h.session(), warnings };
}

test("the recorded crossing gives the prompt and the report a reply each", async (t) => {
  const { c, h, session, warnings } = crossed(t);
  await firstTurn(h, session, c);
  const prompt = await send(h, session, PROMPT);
  // as recorded: init, the notification, the replay
  play(h, [...c.own.slice(0, 1), ...c.notice, ...c.own.slice(1)]);
  await prompt.done.wait();
  h.clients[0]?.inject(c.report);
  await h.until(
    () => said(h).includes("REPORTED") && session.idle && inside(session).settled.isSet,
  );
  assert.deepEqual(misrouted(warnings), []);
  assert.notEqual(replyWith(h, "PINEAPPLE"), replyWith(h, "REPORTED"));
});

test("a prompt s turn that comes while a report is awaited goes to its own reply", async (t) => {
  // A report turn is awaited and a prompt is sent all the same (the session holds a prompt
  // while it awaits one, so only a notification read between that check and the send gets
  // here; the state is set by hand, as the tests of `settle` do). Claude Code runs the prompt
  // first, and its replay says so before its first word.
  const { c, h, session, warnings } = crossed(t);
  await firstTurn(h, session, c);
  const prompt = await send(h, session, PROMPT);
  h.clients[0]?.inject(c.notice);
  await h.sleep(0.05);
  inside(session).expectInjectedTurn();
  play(h, c.own);
  await prompt.done.wait();
  assert.deepEqual(misrouted(warnings), []);
  assert.ok(h.bodies().at(-1)?.includes("PINEAPPLE") && !h.bodies().at(-1)?.includes("STARTED"));
  // The report is awaited again, and lands apart from the prompt's answer.
  assert.ok(inside(session).injectedExpected && !inside(session).settled.isSet);
  h.clients[0]?.inject(c.report);
  await h.until(
    () => said(h).includes("REPORTED") && session.idle && inside(session).settled.isSet,
  );
  assert.deepEqual(misrouted(warnings), []);
  assert.notEqual(replyWith(h, "PINEAPPLE"), replyWith(h, "REPORTED"));
});

test("a report turn that starts while a prompt waits does not take its reply", async (t) => {
  // The prompt is already sent when the command ends, so no report turn is awaited, and the
  // report turn starts first all the same, with words and no replay. The records are the
  // recording's; this order of the two turns is composed here, not recorded: it is the one the
  // daemon logged as `a background reply ... went to an owner reply`.
  const { c, h, session, warnings } = crossed(t);
  await firstTurn(h, session, c);
  const prompt = await send(h, session, PROMPT);
  h.clients[0]?.inject(c.notice);
  await h.sleep(0.05);
  assert.ok(!inside(session).injectedExpected);
  h.clients[0]?.inject(c.report);
  await h.until(() => inside(session).active === null && said(h).includes("REPORTED"));
  assert.ok(!prompt.done.isSet);
  play(h, c.own);
  await prompt.done.wait();
  await h.until(() => session.idle && inside(session).settled.isSet);
  assert.deepEqual(misrouted(warnings), []);
  assert.notEqual(replyWith(h, "PINEAPPLE"), replyWith(h, "REPORTED"));
});

// The effort level is read from the output of the command that sets it (`setsEffort`), and the
// result says whose turn it was: the guess made at the turn's start can be wrong.

test("a report turn is not read as the output of an effort command that waits", async (t) => {
  // A command has no replay, so the report turn that starts while it waits is guessed to be its
  // own. The report's text is the model's.
  const { c, h, session } = crossed(t);
  await firstTurn(h, session, c);
  await send(h, session, "/effort high");
  h.clients[0]?.inject(c.notice);
  await h.sleep(0.05);
  h.clients[0]?.inject(withResult(c.report, "Set effort level to low (this session only): Quick"));
  await h.until(() => inside(session).active === null && inside(session).settled.isSet);
  assert.equal(inside(session).effort, null);
});

test("an effort command s output is read in a turn guessed to be a report", async (t) => {
  // The command is sent, and a report turn is awaited when its turn starts (the state is set
  // here, not recorded): the turn is guessed to be the report, the result says the owner started
  // it, and the command is the prompt that waited.
  const h = harnessFor(t)({});
  const session = h.session();
  const command = await send(h, session, "/effort high");
  inside(session).injectedExpected = true;
  const output = "Set effort level to high (this session only): Comprehensive";
  h.clients[0]?.inject(withResult(sdkMessages("usage"), output));
  await command.done.wait();
  assert.equal(inside(session).effort, "high");
});

test("a turn with no replay and no notification waiting is the prompt s", async (t) => {
  // No recording shows a prompt's turn without its replay; if one comes (a turn that fails
  // before its first word was never recorded), it keeps the prompt's reply as long as Claude
  // Code has nothing to report.
  const { c, h, session, warnings } = crossed(t);
  await firstTurn(h, session, c);
  const prompt = await send(h, session, PROMPT);
  h.clients[0]?.inject(c.own.filter((item) => !isReplay(item)));
  await prompt.done.wait();
  assert.deepEqual(misrouted(warnings), []);
  assert.deepEqual(h.bodies(), [
    "**Bash**(Sleep for 20 seconds in background)\n⎿ Running in background\n\nSTARTED",
    "PINEAPPLE",
  ]);
});
