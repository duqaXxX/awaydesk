/**
 * The sessions as a whole: what a thread's session does from a prompt to its reply, what ends
 * it, and what the manager does across threads.
 *
 * The scripted agent stands at the agent seam (`test/support/sessions.ts`). A test of what the
 * back end does with a start (the SDK's own options, the `--chrome` argument) is the agent
 * module's, and is not here.
 */
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type TestContext, test } from "node:test";
import { agentInfo } from "../../../src/agent/claude/info.ts";
import { questionResult } from "../../../src/agent/claude/requests.ts";
import { ResumeRefused } from "../../../src/agent/seam.ts";
import type { Reply } from "../../../src/chat/seam.ts";
import { Status, ThreadStatus } from "../../../src/chat/slack/reply/status.ts";
import { resolvePath } from "../../../src/core/paths.ts";
import type { TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { APPROVE, type Outcome } from "../../../src/core/requests.ts";
import {
  ASKED_LIMIT,
  DRAIN_POLL_SECONDS,
  IDLE_CLOSE_SECONDS,
  INJECTED_TURN_WAIT,
  STOP_TAIL_WAIT,
} from "../../../src/core/sessions/constants.ts";
import {
  checkDirectory,
  resolveDirectory,
  shellQuote,
  terminalLine,
} from "../../../src/core/sessions/directory.ts";
import { DirectoryMissing, SessionClosed } from "../../../src/core/sessions/errors.ts";
import { SessionManager } from "../../../src/core/sessions/manager.ts";
import { ThreadSession } from "../../../src/core/sessions/session.ts";
import { asked, Turn } from "../../../src/core/sessions/turn.ts";
import { StateStore } from "../../../src/core/state.ts";
import * as texts from "../../../src/core/texts.ts";
import { setLevel, setWriter } from "../../../src/log.ts";
import {
  AsyncEvent,
  CHANNEL,
  FakeSlack,
  networkDown,
  OTHER_THREAD,
  rejected,
  THREAD,
} from "../../support/fake-slack.ts";
import { type JsonObject, sdkJson } from "../../support/fixtures.ts";
import { NAMES } from "../../support/names.ts";
import {
  canUseToolCall,
  END_OF_STREAM,
  type FakeAgentSession,
  type Harness,
  harnessFor,
  hookRun,
  type Item,
  isRecord,
  isResult,
  isSystem,
  recordOf,
  sdkMessages,
  splitTurns,
  WRITES,
} from "../../support/sessions.ts";
import {
  expectedTurns,
  footerWrites,
  inside,
  isReport,
  isToolResult,
  logged,
  nestedBackgroundEndingMidTurn,
  nestedBackgroundRunning,
  pending,
  renamedBackground,
  repoUnder,
  splitAtTaskStart,
  splitBackground,
  splitNestedBackground,
  splitNestedCommand,
  startedOf,
  statusLines,
  stoppedEnd,
  systemRecord,
  taskCards,
  toolUseOf,
  withResult,
  withTaskStatus,
} from "./helpers.ts";

// Windows is not a supported host: a mode, a symbolic link and a git layout are read by POSIX rules.
const POSIX_ONLY = { skip: process.platform === "win32" };

const NESTED = texts.NESTED;

function at<T>(list: readonly T[], index: number): T {
  const found = list.at(index);
  if (found === undefined) throw new Error(`nothing at ${index}`);
  return found;
}

function thread(h: Harness, threadTs: string = THREAD) {
  const stored = h.state.thread(CHANNEL, threadTs);
  assert.ok(stored !== null);
  return stored;
}

/** An object a record holds under `key`; empty when the item is no record or holds none. */
function part(item: Item | undefined, key: string): JsonObject {
  const value = recordOf(item)?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function blocksOf(args: JsonObject | undefined): JsonObject[] {
  return (args?.blocks ?? []) as JsonObject[];
}

/** Resolve the one request that waits, as the owner's click would. */
function resolve(h: Harness, outcome: Outcome): void {
  const approvalId = at(pending(h.approvals), 0);
  assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, outcome), null);
}

/** The recorded question the SDK asked permission for (`ask-can-use-tool.json`). */
function recordedQuestion(): { toolName: string; input: JsonObject; questions: JsonObject[] } {
  const recorded = sdkJson("ask-can-use-tool") as JsonObject;
  const input = recorded.input as JsonObject;
  return {
    toolName: String(recorded.tool_name),
    input,
    questions: input.questions as JsonObject[],
  };
}

/** Each question answered with its first option. */
function firstOptions(questions: readonly JsonObject[]): Record<string, string> {
  return Object.fromEntries(
    questions.map((q) => [String(q.question), String(at(q.options as JsonObject[], 0).label)]),
  );
}

/** What connect raises for a session id Claude Code no longer has. */
function gone(): Error {
  return new ResumeRefused();
}

test("a turn replies in the thread and records the session", async (t) => {
  const turnMessages = sdkMessages("tools");
  const h = harnessFor(t)({ turns: [turnMessages] });
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  assert.deepEqual(h.clients[0]?.queries, ["list the files"]);
  assert.ok(h.slack.callsTo("chat.postMessage").every((args) => args.thread_ts === THREAD));
  const result = turnMessages.at(-1);
  assert.ok(isResult(result));
  assert.equal(thread(h).sessionId, recordOf(result)?.session_id);
  const [stop, ...more] = h.slack.callsTo("chat.stopStream");
  assert.equal(more.length, 0);
  assert.ok(!blocksOf(stop).some((block) => block.type === "divider")); // the end carries none
  await h.idle();
  // The session has ended: the footer closes the reply, by an edit.
  assert.equal(blocksOf(h.slack.callsTo("chat.update").at(-1)).at(-1)?.type, "context");
});

test("the client is launched as the design says", async (t) => {
  // What the core asks of the seam. What the back end makes of it for the SDK (partial
  // messages, the extra arguments, the permission callback, the CLI's path) is the agent
  // module's to test.
  const h = harnessFor(t)({});
  await h.session().ensureConnected();
  assert.deepEqual(h.clients[0]?.options, {
    folder: h.tmpPath,
    resume: null,
    settingsSources: ["user", "project", "local"],
    model: null,
    effort: null,
  });
});

test("clear records the new session id", async (t) => {
  const [first, second] = splitTurns(sdkMessages("clear")) as [Item[], Item[]];
  const h = harnessFor(t)({ turns: [first, second] });
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  await (await session.submit("/clear")).done.wait();
  assert.ok(isResult(second.at(-1)));
  assert.equal(thread(h).sessionId, recordOf(second.at(-1))?.session_id);
});

test("a thread is live exactly when get would give it a session", async (t) => {
  const h = harnessFor(t)();
  assert.equal(h.manager.live(CHANNEL, THREAD), false, "no entry in state.json");
  h.session();
  assert.equal(h.manager.live(CHANNEL, THREAD), true);
  assert.notEqual(h.manager.get(CHANNEL, THREAD), null);
  assert.ok(await h.manager.release(CHANNEL, THREAD));
  assert.equal(h.manager.live(CHANNEL, THREAD), false, "a released thread is held");
  h.manager.free(CHANNEL, THREAD);
  assert.equal(h.manager.live(CHANNEL, THREAD), true);
});

test("a gone session is removed and says so", async (t) => {
  // A stored session id that fails to resume no longer falls back to a fresh session.
  const h = harnessFor(t)({ startError: gone() });
  h.session(); // opens the thread
  h.state.setSession(CHANNEL, THREAD, "gone");
  const turn = await h.session().submit("hello");
  await turn.done.wait();
  assert.deepEqual(
    h.clients.map((client) => client.options.resume),
    ["gone"],
  );
  assert.deepEqual(h.bodies(), [texts.named(texts.SESSION_GONE, NAMES)]);
  assert.equal(h.state.thread(CHANNEL, THREAD), null);
  assert.equal(h.manager.get(CHANNEL, THREAD), null);
  assert.equal(h.slack.pushes(), 1); // the reply's stream stops once
});

test("a gone session fails a queued turn and leaks no process", async (t) => {
  // Regression: the worker used to take the next queued turn after SessionGone and start a
  // second, unrecorded Claude Code session for it instead of refusing.
  const h = harnessFor(t)({ startError: gone() });
  const session = h.session(); // opens the thread
  h.state.setSession(CHANNEL, THREAD, "gone");
  const first = await session.submit("hello");
  const second = await session.submit("again");
  await Promise.all([first.done.wait(), second.done.wait()]);
  // Only the one failed attempt: no second client started for the queued turn.
  assert.deepEqual(
    h.clients.map((client) => client.options.resume),
    ["gone"],
  );
  assert.deepEqual(h.bodies(), [
    texts.named(texts.SESSION_GONE, NAMES),
    texts.named(texts.SESSION_GONE, NAMES),
  ]);
  // The worker must not be left spinning on an empty queue nobody will ever fill again: the
  // task says whether it has ended.
  await h.idle();
  assert.equal(inside(session).worker?.done, true);
  assert.equal(inside(session).idleExpiry, null);
  await h.manager.closeAll();
  assert.ok(h.clients.every((client) => !client.connected));
});

/** Hold each `submit` where its reply is made, one gate per call. */
function gatedSinks(t: TestContext, gates: readonly AsyncEvent[]): { entered: number } {
  const state = { entered: 0 };
  const prototype = ThreadSession.prototype as unknown as { sink(): Reply | Promise<Reply> };
  const real = prototype.sink;
  t.mock.method(prototype, "sink", async function (this: ThreadSession) {
    const reply = await real.call(this);
    const gate = at(gates, state.entered);
    state.entered += 1;
    await gate.wait();
    return reply;
  });
  return state;
}

test("a turn that races sessiongone while its sink is made gets session gone", async (t) => {
  // `ensureConnected` finds the stored session gone, closes the session and drains the queue
  // (empty at that point). The second turn is queued only after that: nothing will ever take
  // it from an ended worker, so it must be resolved right there, as gone too.
  const h = harnessFor(t)({ startError: gone() });
  const session = h.session();
  h.state.setSession(CHANNEL, THREAD, "gone");
  const gates = [new AsyncEvent(), new AsyncEvent()];
  const sinks = gatedSinks(t, gates);
  const firstTask = session.submit("hello");
  await h.until(() => sinks.entered === 1); // "hello" is paused while its sink is made
  const secondTask = session.submit("again");
  await h.until(() => sinks.entered === 2); // "again" is paused there too
  at(gates, 0).set(); // let "hello" queue itself and start its worker
  const firstTurn = await firstTask;
  await firstTurn.done.wait();
  assert.ok(session.closed); // the SessionGone branch has already closed and drained the queue
  at(gates, 1).set(); // only now does "again" reach the point where it would enqueue itself
  const secondTurn = await secondTask;
  await secondTurn.done.wait();
  assert.deepEqual(h.bodies(), [
    texts.named(texts.SESSION_GONE, NAMES),
    texts.named(texts.SESSION_GONE, NAMES),
  ]);
  await h.idle();
  assert.equal(inside(session).worker?.done, true);
  await h.manager.closeAll();
});

test("a turn that races a plain close while its sink is made gets session closed", async (t) => {
  // Whatever closed the session while the sink was made, it must not always be answered as
  // SessionGone: a plain close (an idle close, a restart) leaves the thread's own entry in
  // state.json, unlike SessionGone's close, and that is the only thing telling the two apart
  // once the session is closed either way.
  const h = harnessFor(t)({});
  const session = h.session();
  const gate = new AsyncEvent();
  const sinks = gatedSinks(t, [gate]);
  const submitTask = session.submit("hello");
  await h.until(() => sinks.entered === 1); // paused while its sink is made
  await session.close(); // a plain close: the thread's entry stays in state.json
  assert.notEqual(h.state.thread(CHANNEL, THREAD), null);
  gate.set();
  const turn = await submitTask;
  await turn.done.wait();
  assert.deepEqual(h.bodies(), [texts.SESSION_CLOSED]);
});

test("a direct sessiongone call leaves no idle timer task", async (t) => {
  // `!status` (or `!bypass`) can hit SessionGone with no worker ever created: the idle-close
  // timer armed when the session was handed out must not be left running past the close.
  const h = harnessFor(t)({ startError: gone() });
  const session = h.session(); // touched on hand-out: its idle-close timer is armed already
  h.state.setSession(CHANNEL, THREAD, "gone");
  await session.status();
  assert.ok(session.closed);
  await h.idle();
  assert.equal(inside(session).idleExpiry, null);
  assert.equal(inside(session).worker, null);
});

test("a direct gone call rescues the worker s taken turn", async (t) => {
  // A direct call (`!status`) found the session gone while the worker, having taken a turn,
  // waited on the same connect lock: cancelling the worker (to end it) lost that turn:
  // cancelled in its wait, it never reached its own catch, so the taken turn was never failed
  // and the reply stayed "writing" forever.
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ startError: gone(), startGate: gate });
  const session = h.session();
  h.state.setSession(CHANNEL, THREAD, "gone");
  const statusTask = session.status(); // holds the connect lock, gated
  await h.until(() => h.clients.length === 1);
  const turn = await session.submit("hello");
  await h.until(() => inside(session).taken !== null); // the worker took it, now waits on the lock
  gate.set();
  await statusTask;
  assert.ok(session.closed);
  await turn.done.wait(); // must not hang
  assert.deepEqual(h.bodies(), [texts.named(texts.SESSION_GONE, NAMES)]);
});

test("a restart rebuilds a stored thread with its bypass", async (t) => {
  const h = harnessFor(t)({}, {});
  const session = h.session();
  await session.setBypass(true);
  assert.deepEqual(h.clients[0]?.modes, ["bypassPermissions"]);
  assert.ok(session.bypass);
  const path = join(h.tmpPath, "state.json");
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(stored.channels[CHANNEL].threads[THREAD].bypass);
  // A new daemon: state.json read again, a new manager, a new Claude Code process.
  const reloaded = { ...h.deps, state: new StateStore(path) };
  const restarted = new SessionManager(reloaded).get(CHANNEL, THREAD);
  assert.ok(restarted?.bypass);
  await restarted.ensureConnected();
  assert.deepEqual(h.clients[1]?.modes, ["bypassPermissions"]);
  await restarted.setBypass(false);
  assert.equal(h.clients[1]?.modes.at(-1), "default");
  assert.ok(!new StateStore(path).thread(CHANNEL, THREAD)?.bypass);
  await restarted.close();
});

test("queue waits while approval pending", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")], sdkMessages("tools")] });
  const session = h.session();
  const first = await session.submit("first");
  const second = await session.submit("second");
  await h.until(() => h.slack.callsTo("chat.postMessage").some((args) => "blocks" in args));
  await h.sleep(0.05);
  assert.deepEqual(h.clients[0]?.queries, ["first"]);
  assert.ok(session.busy);
  resolve(h, APPROVE);
  await second.done.wait();
  assert.ok(first.done.isSet);
  assert.deepEqual(h.clients[0]?.queries, ["first", "second"]);
  assert.deepEqual(h.clients[0]?.permissionResults[0], { allow: true });
});

test("restart hold says what a stop waits for in the thread", async (t) => {
  const h = harnessFor(t)({
    turns: [[canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("interrupt")]],
  });
  const session = h.session();
  assert.equal(session.restartHold, ""); // nothing runs: the thread holds no stop
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  assert.equal(session.restartHold, texts.RESTART_HOLD_OWNER);
  assert.deepEqual(h.manager.restartHolds(), []); // no stop under way
  await session.stop();
  await turn.done.wait();
  assert.equal(session.restartHold, "");
});

test("stop landed gives up when the stopped turn never ends", async (t) => {
  const h = harnessFor(t)({ turns: [[canUseToolCall("Bash", { command: "rm -rf build" })]] });
  const session = h.session();
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  assert.equal(await session.stop(), true);
  // The sessions' clock crosses STOP_TAIL_WAIT.
  let landed = false;
  const waiting = session.stopLanded().then(() => {
    landed = true;
  });
  await h.clock.advance(STOP_TAIL_WAIT - 1);
  assert.equal(landed, false);
  await h.clock.advance(1);
  await waiting;
  assert.ok(!turn.done.isSet); // it did not end: the wait is bounded
});

test("stop denies pending and interrupts", async (t) => {
  const h = harnessFor(t)({
    turns: [[canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("interrupt")]],
  });
  const session = h.session();
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  assert.equal(await session.stop(), true);
  // The answer to the stop waits for the reply it cut short: it sits under its footer.
  await session.stopLanded();
  assert.ok(turn.done.isSet);
  assert.equal(h.clients[0]?.interrupts, 1);
  const denied = at(h.clients[0]?.permissionResults ?? [], 0);
  assert.ok("allow" in denied && !denied.allow);
  assert.equal(h.slack.callsTo("chat.delete").length, 1);
  // Crash repair (issue #19): `deleteRequest` clears the state entry too.
  assert.deepEqual(thread(h).requests, []);
  assert.equal(await session.stop(), false);
});

test("ask user question returns answers", async (t) => {
  const recorded = recordedQuestion();
  const call = canUseToolCall(recorded.toolName, recorded.input);
  const h = harnessFor(t)({ turns: [[call, ...sdkMessages("tools")]] });
  const turn = await h.session().submit("ask me");
  await h.until(() => pending(h.approvals).length > 0);
  const answers = firstOptions(recorded.questions);
  resolve(h, { kind: "answer", answers });
  await turn.done.wait();
  const result = at(h.clients[0]?.permissionResults ?? [], 0);
  assert.ok("answered" in result && result.answered);
  assert.deepEqual(result.answers, answers);
  // As the back end hands it to the SDK: allowed, with the questions as asked and the answers.
  assert.deepEqual(questionResult(result, recorded.input), {
    behavior: "allow",
    updatedInput: { questions: recorded.questions, answers },
  });
});

/**
 * The recorded turn of an answered question (ask-answered.jsonl, CLI 2.1.286), with the
 * permission request where the CLI makes it: after the call, before its result. With it, the
 * call's id, which the request carries (measured), and the call's input.
 */
function answeredTurn(): [batch: Item[], callId: string, input: JsonObject] {
  const messages = sdkMessages("ask-answered");
  const calling = messages.find((item) => toolUseOf(item) !== null);
  const callId = toolUseOf(calling);
  assert.ok(callId !== null);
  const content = part(calling, "message").content as JsonObject[];
  const call = at(
    content.filter((block) => block.type === "tool_use"),
    0,
  );
  const where = messages.findIndex((item) => isRecord(item, "user"));
  const ask = canUseToolCall(String(call.name), call.input as JsonObject, callId);
  return [
    [...messages.slice(0, where), ask, ...messages.slice(where)],
    callId,
    call.input as JsonObject,
  ];
}

test("an answered question stays in the reply and its request goes", async (t) => {
  // Issue #82: the answers show under the call's line, where the question was asked, so what
  // Claude does next shows below them; the request message has done its job.
  const [batch, , askedInput] = answeredTurn();
  const questions = askedInput.questions as JsonObject[];
  const h = harnessFor(t)({ turns: [batch] });
  const turn = await h.session().submit("ask me");
  await h.until(() => pending(h.approvals).length > 0);
  const requestTs = at(h.slack.postedTs, -1);
  assert.deepEqual(thread(h).requests, [requestTs]);
  resolve(h, { kind: "answer", answers: firstOptions(questions) });
  await turn.done.wait();
  assert.deepEqual(
    h.slack.callsTo("chat.delete").map((args) => args.ts),
    [requestTs],
  );
  assert.ok(h.slack.callsTo("chat.update").every((args) => args.ts !== requestTs));
  assert.deepEqual(thread(h).requests, []);
  const cards = h.slack.messageCards().flat();
  const [card, ...more] = cards.filter((c) => c.title === texts.named(texts.ANSWERED, NAMES));
  assert.equal(more.length, 0);
  assert.equal(card?.status, "complete");
  const shown = h.slack.apiCalls
    .flatMap((call) => (call.args.chunks ?? []) as JsonObject[])
    .filter((chunk) => chunk.type === "blocks")
    .flatMap((chunk) => chunk.blocks as JsonObject[])
    .filter((block) => block.type === "context")
    .map((block) => String(at(block.elements as JsonObject[], 0).text));
  const first = at(questions, 0);
  const label = at(first.options as JsonObject[], 0).label;
  assert.ok(shown[0]?.includes(`· ${first.question} → ${label}`));
});

test("answers the reply cannot show stay in the request", async (t) => {
  // A question whose call the reply holds no line for (asked inside a subagent, say): the
  // request is rewritten into the record, with no buttons, as the terminal keeps it.
  const recorded = recordedQuestion();
  const call = canUseToolCall(recorded.toolName, recorded.input, "toolu_unseen");
  const h = harnessFor(t)({ turns: [[call, ...sdkMessages("tools")]] });
  const turn = await h.session().submit("ask me");
  await h.until(() => pending(h.approvals).length > 0);
  const requestTs = at(h.slack.postedTs, -1);
  resolve(h, { kind: "answer", answers: firstOptions(recorded.questions) });
  await turn.done.wait();
  assert.deepEqual(h.slack.callsTo("chat.delete"), []);
  const [update, ...more] = h.slack.callsTo("chat.update").filter((args) => args.ts === requestTs);
  assert.equal(more.length, 0);
  const text = String(at(at(blocksOf(update), 0).elements as JsonObject[], 0).text);
  const first = at(recorded.questions, 0);
  assert.ok(
    text.startsWith(`${texts.named(texts.ANSWERED, NAMES)}\n${NESTED}· ${first.question} → `),
  );
  assert.deepEqual(
    blocksOf(update).map((block) => block.type),
    ["context"],
  );
  assert.deepEqual(thread(h).requests, []);
});

test("a record slack refuses removes the request", async (t) => {
  const recorded = recordedQuestion();
  const call = canUseToolCall(recorded.toolName, recorded.input, "toolu_unseen");
  const h = harnessFor(t)({ turns: [[call, ...sdkMessages("tools")]] });
  const turn = await h.session().submit("ask me");
  await h.until(() => pending(h.approvals).length > 0);
  const requestTs = at(h.slack.postedTs, -1);
  h.slack.responses["chat.update"] = { ok: false, error: "msg_too_long" };
  resolve(h, { kind: "answer", answers: firstOptions(recorded.questions) });
  await h.until(() => h.slack.callsTo("chat.delete").length > 0);
  // Its buttons would no longer work: the request goes.
  assert.deepEqual(
    h.slack.callsTo("chat.delete").map((args) => args.ts),
    [requestTs],
  );
  delete h.slack.responses["chat.update"];
  await turn.done.wait();
});

test("the status field tracks working then clears once done", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  const turn = await session.submit("list the files");
  assert.equal(thread(h).status, "working");
  await turn.done.wait();
  await h.until(() => thread(h).status === null);
});

test("the ended field keeps the roots final reaction until work starts again", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools"), sdkMessages("tools")] });
  const session = h.session();
  const turn = await session.submit("list the files");
  assert.equal(thread(h).ended, null);
  await turn.done.wait();
  await h.until(() => thread(h).ended === "done");
  await session.submit("and again");
  const stored = thread(h);
  assert.deepEqual([stored.status, stored.ended], ["working", null]);
});

test("a close that cuts a turn short keeps x as the ended reaction", async (t) => {
  const ask = canUseToolCall("Bash", { command: "rm -rf build" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const session = h.session();
  await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  await session.close();
  const stored = thread(h);
  assert.deepEqual([stored.status, stored.ended], [null, "error"]);
});

test("close leaves every repair field cleared", async (t) => {
  const ask = canUseToolCall("Bash", { command: "rm -rf build" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const session = h.session();
  await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  const approvalId = at(pending(h.approvals), 0);
  const requestTs = h.approvals.get(approvalId)?.messageTs;
  await session.close();
  const stored = thread(h);
  assert.deepEqual(stored.openReplies, []);
  assert.deepEqual(stored.requests, []);
  assert.equal(stored.status, null);
  // Issue #19 fix round item 8: the pending approval's own message is actually deleted too.
  const deleted = h.slack.callsTo("chat.delete").map((args) => args.ts);
  assert.deepEqual(deleted, [requestTs]);
});

// Issue #240: the agent takes the denial of the request a close settles and can ask again at
// once, while the close still waits on the first handler. Nobody is left to answer that one.
test("a request that comes while the session closes is refused and never shown", async (t) => {
  const first = canUseToolCall("Bash", { command: "rm -rf build" });
  const second = canUseToolCall("Bash", { command: "rm -rf dist" });
  const h = harnessFor(t)({ turns: [[first, second, ...sdkMessages("tools")]] });
  const session = h.session();
  await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  await session.close();
  // Both requests reached the session and were answered: the second was not simply never sent.
  assert.equal(h.clients[0]?.permissionResults.length, 2);
  assert.deepEqual(pending(h.approvals), []);
  const shown = h.slack
    .callsTo("chat.postMessage")
    .filter((args) => JSON.stringify(args.blocks ?? []).includes('"actions"'));
  assert.equal(shown.length, 1);
  assert.equal(h.slack.callsTo("chat.delete").length, 1);
});

test("waiting for owner reflects an open approval", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const session = h.session();
  await session.submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  assert.equal(session.waitingForOwner, true);
  resolve(h, APPROVE);
  await h.until(() => session.waitingForOwner === false);
});

test("no reply ever carries a channel mention", async (t) => {
  // `<!channel>` was removed with the thread model: a full turn that ends with a closing
  // message, posts an approval request and a question request must never bring it back.
  const recorded = recordedQuestion();
  const ask = canUseToolCall("Bash", { command: "ls" });
  const question = canUseToolCall(recorded.toolName, recorded.input);
  const h = harnessFor(t)({ turns: [[ask, question, ...sdkMessages("tools")]] });
  const turn = await h.session().submit("do it");
  await h.until(() => pending(h.approvals).length > 0);
  const approvalId = at(pending(h.approvals), 0);
  resolve(h, APPROVE);
  await h.until(() => pending(h.approvals).some((id) => id !== approvalId));
  resolve(h, { kind: "answer", answers: firstOptions(recorded.questions) });
  await turn.done.wait();
  for (const call of h.slack.apiCalls) {
    assert.ok(!JSON.stringify(call.args).includes("<!channel>"));
  }
});

test("a turn with a task an approval and a question is one stream, two requests and the ending", async (t) => {
  // A turn that starts a background task, asks for an approval and a question, then the report
  // turn for that task, writes exactly the approval request, the question request, and one
  // stream for the reply, which stops once, when the turn ends with the task still running, and
  // the report's ending, posted when the task's report is in. Nothing else.
  const [first, notice, injected] = splitBackground();
  const recorded = recordedQuestion();
  const ask = canUseToolCall("Bash", { command: "ls" });
  const question = canUseToolCall(recorded.toolName, recorded.input);
  const h = harnessFor(t)({ turns: [[ask, question, ...first]] });
  const session = h.session();
  const turn = await session.submit("do it and start something");
  await h.until(() => pending(h.approvals).length > 0);
  const approvalId = at(pending(h.approvals), 0);
  resolve(h, APPROVE);
  await h.until(() => pending(h.approvals).some((id) => id !== approvalId));
  resolve(h, { kind: "answer", answers: firstOptions(recorded.questions) });
  await turn.done.wait();
  await h.until(() => h.slack.callsTo("chat.stopStream").length > 0);
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.slack.callsTo("chat.postMessage").length === 3);
  await h.sleep(0.05);
  const posts = h.slack.callsTo("chat.postMessage");
  // Exactly these, in this order, nothing else.
  assert.deepEqual(
    posts.slice(0, 2).map((post) => post.text),
    ["Bash: ls", "AskUserQuestion"],
  );
  assert.ok(h.slack.streamTs.length === 1 && h.slack.callsTo("chat.stopStream").length === 1);
  assert.equal(h.slack.pushes(), 4);
});

test("asked cuts a long prompt and names an image only prompt", () => {
  const longPrompt = "word ".repeat(30); // more characters than ASKED_LIMIT
  const cut = asked(longPrompt);
  assert.ok(Array.from(cut).length === ASKED_LIMIT && cut.endsWith("…"));
  const image = { type: "image", mediaType: "image/png", data: "x" } as const;
  assert.equal(asked([image]), texts.PROMPT_IMAGE);
  assert.equal(asked([{ type: "text", text: "look at this" }, image]), "look at this");
});

test("rate limit event invalidates usage", async (t) => {
  const events = sdkMessages("tools").filter((item) => isRecord(item, "rate_limit_event"));
  // the spec measured one RateLimitEvent on a client's first turn
  assert.ok(events.length > 0);
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("a")).done.wait();
  await h.until(() => h.usageFetches === 1);
  await h.usage.refreshIfStale();
  assert.equal(h.usageFetches, 1); // still fresh
  h.clients[0]?.inject([at(events, 0)]);
  await h.sleep(0.05);
  await h.usage.refreshIfStale();
  assert.equal(h.usageFetches, 2);
});

test("logs hold no message content", async (t) => {
  // A turn that asks for an approval, so that the session logs something to read.
  const ask = canUseToolCall("Bash", { command: "SECRET-COMMAND-CONTENT" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  // Every line the daemon logs, down to DEBUG: every module logs through `src/log.ts`.
  const lines: string[] = [];
  const writer = setWriter((line) => lines.push(line));
  setLevel("DEBUG");
  try {
    const turn = await h.session().submit("SECRET-PROMPT-CONTENT");
    await h.until(() => pending(h.approvals).length > 0);
    resolve(h, APPROVE);
    await turn.done.wait();
    await h.idle();
  } finally {
    setLevel("INFO");
    setWriter(writer);
  }
  assert.ok(lines.length > 0); // the log was read, not silent
  assert.ok(!lines.join("\n").includes("SECRET-PROMPT-CONTENT"));
  assert.ok(!lines.join("\n").includes("SECRET-COMMAND-CONTENT"));
});

test("an api error is logged by category and thread never by its text", async (t) => {
  const messages = sdkMessages("server-error");
  const [words, ...more] = messages.filter(isResult).map((item) => String(recordOf(item)?.result));
  assert.ok(more.length === 0 && words);
  const h = harnessFor(t)({ turns: [messages] });
  const logs = [...(["info", "warning", "error"] as const)].map((level) => logged(t, level));
  const session = h.session();
  const turn = await session.submit("hello");
  await turn.done.wait();
  const lines = logs.flat();
  const [line, ...others] = lines.filter((m) => m.includes("reported an error"));
  assert.equal(others.length, 0);
  assert.ok(line?.endsWith(`${session.channelId}/${session.threadId}: server_error`));
  assert.ok(!lines.some((m) => m.includes(words)));
});

test("bind is refused while a thread of the channel is busy", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const session = h.session();
  await session.submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  const other = join(h.tmpPath, "other");
  mkdirSync(other);
  assert.equal(await h.manager.bind(CHANNEL, other), false);
  assert.equal(h.state.channel(CHANNEL)?.directory, h.tmpPath);
  resolve(h, APPROVE);
  await h.until(() => session.idle);
});

test("bind accepted when every thread is idle keeps the old thread s folder", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  const other = join(h.tmpPath, "other");
  mkdirSync(other);
  assert.equal(await h.manager.bind(CHANNEL, other), true);
  assert.equal(h.state.channel(CHANNEL)?.directory, other);
  // The thread already open is untouched: same folder, same live session, no closing.
  assert.equal(thread(h).directory, h.tmpPath);
  assert.ok(session.directory === h.tmpPath && h.session() === session);
  assert.equal(h.clients[0]?.connected, true);
  // A thread opened after the bind gets the new folder.
  const fresh = h.manager.open(CHANNEL, OTHER_THREAD);
  assert.equal(fresh?.directory, other);
});

test("two threads of one channel are two sessions with separate clients", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] }, { turns: [sdkMessages("tools")] });
  const first = h.manager.open(CHANNEL, THREAD);
  const second = h.manager.open(CHANNEL, OTHER_THREAD);
  assert.ok(first !== null && second !== null && first !== second);
  assert.equal(h.manager.get(CHANNEL, THREAD), first); // the same live session, not rebuilt
  await (await first.submit("a")).done.wait();
  await (await second.submit("b")).done.wait();
  assert.equal(h.clients.length, 2);
  assert.deepEqual(h.clients[0]?.queries, ["a"]);
  assert.deepEqual(h.clients[1]?.queries, ["b"]);
  assert.deepEqual(new Set(h.manager.sessionsOf(CHANNEL)), new Set([first, second]));
  const starts = h.slack.callsTo("chat.startStream");
  assert.deepEqual(new Set(starts.map((p) => p.thread_ts)), new Set([THREAD, OTHER_THREAD]));
});

test("stop channel stops every busy session of the channel", async (t) => {
  const turn = [canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("interrupt")];
  const h = harnessFor(t)({ turns: [turn] }, { turns: [turn] });
  const first = h.manager.open(CHANNEL, THREAD);
  const second = h.manager.open(CHANNEL, OTHER_THREAD);
  assert.ok(first !== null && second !== null);
  const a = await first.submit("a");
  const b = await second.submit("b");
  await h.until(() => pending(h.approvals).length === 2);
  assert.equal(await h.manager.stopChannel(CHANNEL), true);
  await Promise.all([a.done.wait(), b.done.wait()]);
  assert.ok(h.clients[0]?.interrupts === 1 && h.clients[1]?.interrupts === 1);
  assert.equal(h.reactions(THREAD).at(-1), Status.DONE); // a stop is not an error
  assert.equal(h.reactions(OTHER_THREAD).at(-1), Status.DONE);
  assert.equal(await h.manager.stopChannel(CHANNEL), false);
});

test("resolve directory", POSIX_ONLY, (t) => {
  const tmpPath = realpathSync(mkdtempSync(join(tmpdir(), "awd-resolve-")));
  t.after(() => rmSync(tmpPath, { recursive: true, force: true }));
  const root = join(tmpPath, "root");
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "file.txt"), "x");
  mkdirSync(join(tmpPath, "outside"));
  symlinkSync(join(tmpPath, "outside"), join(root, "escape"));
  assert.equal(resolveDirectory(join(root, "app"), root), join(root, "app"));
  assert.equal(resolveDirectory(root, root), root);
  assert.equal(resolveDirectory(`${root}/app/../../outside`, root), null);
  assert.equal(resolveDirectory(join(root, "escape"), root), null);
  assert.equal(resolveDirectory(join(root, "file.txt"), root), null);
  assert.equal(resolveDirectory(join(root, "missing"), root), null);
});

test("resolve directory follows a link before the `..` after it", POSIX_ONLY, (t) => {
  // What Python's `(root / raw).resolve()` gives on this layout (run 2026-10-11): the disk goes
  // up from where a link leads, where `path.resolve` folds `link/..` away as text.
  const tmpPath = realpathSync(mkdtempSync(join(tmpdir(), "awd-resolve-")));
  t.after(() => rmSync(tmpPath, { recursive: true, force: true }));
  const root = join(tmpPath, "root");
  mkdirSync(join(root, "in", "deep"), { recursive: true });
  mkdirSync(join(root, "a"));
  mkdirSync(join(tmpPath, "elsewhere", "deep"), { recursive: true });
  symlinkSync(join("..", "in", "deep"), join(root, "a", "link"));
  symlinkSync(join("..", "elsewhere", "deep"), join(root, "out"));
  symlinkSync(join("a", "link"), join(root, "chain"));
  symlinkSync(join(root, "in"), join(root, "absolute"));
  symlinkSync("loop2", join(root, "loop1"));
  symlinkSync("loop1", join(root, "loop2"));
  assert.equal(resolveDirectory("a/link", root), join(root, "in", "deep"));
  assert.equal(resolveDirectory("a/link/..", root), join(root, "in"));
  assert.equal(resolveDirectory(`${root}/a/link/..`, root), join(root, "in"));
  assert.equal(resolveDirectory("chain/..", root), join(root, "in"));
  assert.equal(resolveDirectory("absolute/deep/../..", root), root);
  assert.equal(resolveDirectory("out/..", root), null); // `elsewhere`, outside the root
  assert.equal(resolveDirectory("a/link/../missing", root), null);
  // A name that is not there is kept and the walk goes on: the link after it is still followed.
  assert.equal(resolveDirectory("missing/../out", root), null);
  assert.equal(resolveDirectory("in/deep/../../out/..", root), null);
  assert.equal(resolveDirectory("missing/../a/link/..", root), join(root, "in"));
  assert.equal(resolveDirectory("a/missing/../link/..", root), join(root, "in"));
  // A path through a loop of links names nothing, as the kernel answers it. Python's
  // `resolve` kept the rest of such a path as written and unread: `loop1/../out` was the root's
  // `out`, which leads outside (run 2026-10-11).
  assert.equal(resolveDirectory("loop1", root), null);
  assert.equal(resolveDirectory("loop1/..", root), null);
  assert.equal(resolveDirectory("loop1/../out", root), null);
  assert.equal(resolveDirectory("loop1/../in", root), null);
});

// A report opens with Claude Code's notification summary (recorded: `Background command "..."
// completed (exit code 0)`, `Agent "..." finished`), never with a tool line.

test("a report opens with claude code s summary and takes the footer", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => isReport(h.bodies()[0] ?? ""));
  await h.sleep(0.05);
  const report = at(h.bodies(), 0); // appended to the one reply there is
  const summary = systemRecord(notice, "task_notification").summary;
  assert.ok(report.includes(`✓ ${summary}`)); // Claude Code's own words, as in the terminal
  // The task has now fully ended (report in, nothing else owed): the closing message that
  // waited for it posts at last, with its footer.
  const closing = at(h.slack.messageBlocks(), -1);
  assert.ok(closing.some((block) => block.type === "divider"));
});

test("a report turn s writes debounce like any other reply", async (t) => {
  // The reply it renders into has already finished its body, which used to make every
  // streamed delta flush its own `chat.update` instead of debouncing.
  const [first, notice, injected] = splitBackground();
  const deltas = injected.filter((item) => {
    const event = recordOf(item)?.event as JsonObject | undefined;
    const delta = event?.delta as JsonObject | undefined;
    return (
      isRecord(item, "stream_event") &&
      event?.type === "content_block_delta" &&
      delta?.type === "text_delta"
    );
  }).length;
  assert.ok(deltas > 3); // the recording should have enough deltas to prove debouncing
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const before = h.slack.callsTo("chat.update").length;
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => isReport(h.bodies()[0] ?? ""));
  await h.sleep(0.2);
  const updates = h.slack.callsTo("chat.update").length - before;
  assert.ok(updates <= 3, `${updates} chat.update calls for one report turn (no debounce)`);
});

test("an owner answer behind a wrong guess takes the footer once the report wait is over", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice); // the session now expects Claude Code's own turn
  await h.sleep(0.05);
  h.clients[0]?.inject(sdkMessages("tools")); // but the result says a person asked for it
  await h.until(() => h.slack.callsTo("chat.stopStream").length > 0);
  // the answer joins the reply that waited for the task, which ends: the report is still
  // expected, so the session has not ended and the stop carries no footer
  const stop = h.slack.callsTo("chat.stopStream").at(-1);
  assert.ok(!blocksOf(stop).some((block) => block.type === "divider"));
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => session.idle);
  await h.sleep(3);
  assert.deepEqual(footers(h), [false, true], "under the app's last message");
});

// A background agent's end, as the SDK delivered it (recorded 2026-09-24): its summary is the
// agent's result, not a status line.
function agentEnd(taskId: string, toolUseId: string): Item {
  return {
    record: {
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      tool_use_id: toolUseId,
      status: "completed",
      output_file: "/home/dev/tasks/out",
      summary: "| File | Lines |\n|---|---|\n| README.md | 3 |",
      usage: { total_tokens: 11181, tool_uses: 0, duration_ms: 10400 },
      session_id: "00000000-0000-0000-0000-000000000001",
      uuid: "00000000-0000-0000-0000-000000000002",
    },
  };
}

test("a background agent s end reads as in the terminal", async (t) => {
  const first = at(splitTurns(sdkMessages("subagent")), 0);
  const started = systemRecord(first, "task_started");
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  assert.ok(typeof started.tool_use_id === "string");
  h.clients[0]?.inject([
    agentEnd(String(started.task_id), started.tool_use_id),
    ...sdkMessages("tools"),
  ]);
  await h.until(() => isReport(h.bodies()[0] ?? ""));
  await h.sleep(0.05);
  // appended to the one reply there is, not a body of its own
  const line = at(h.bodies(), 0)
    .split("\n")
    .find((candidate) => candidate.startsWith('✓ Agent "'));
  assert.ok(line !== undefined);
  assert.ok(line.startsWith(`✓ Agent "${started.description}" finished · 10s`));
  assert.ok(!line.includes("README.md"));
});

test("the task record is bounded", async (t) => {
  const [first] = splitBackground();
  const renamed = first.map((item) => {
    const record = recordOf(item);
    return record !== null && isSystem(item, "task_started")
      ? { record: { ...record, task_id: "other" } }
      : item;
  });
  // One task is kept (`tasksKept: 1`).
  const h = harnessFor(t, { tasksKept: 1 })({ turns: [first, renamed] });
  const session = h.session();
  await (await session.submit("one")).done.wait();
  await (await session.submit("two")).done.wait();
  assert.deepEqual([...inside(session).tasks.keys()], ["other"]);
});

test("a report line never outlives its chance", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice); // and Claude Code starts no turn of its own
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.idle();
  assert.deepEqual(inside(session).ended, []);
});

test("the task bookkeeping goes with the process", async (t) => {
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  assert.ok(inside(session).tasks.size > 0);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  assert.ok(inside(session).tasks.size === 0 && inside(session).ended.length === 0);
});

function notNotification(item: Item): boolean {
  return !isSystem(item, "task_notification");
}

test("a suppressed notification s closing still posts eventually", async (t) => {
  // The CLI can suppress the notification altogether (SDK TaskUpdatedMessage docstring). Only
  // the terminal task_updated arrives; the closing message must still post once
  // INJECTED_TURN_WAIT passes, not wait on it forever.
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const a = inside(session).taskReplies.get("bny2rux7d");
  assert.ok(a !== undefined);
  h.clients[0]?.inject(notice.filter(notNotification));
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => a.closedOut, 1.0);
});

test("a report whose target already closed out gets its own reply", async (t) => {
  // A notification arriving later than INJECTED_TURN_WAIT lets `expireUnreported` close the
  // reply out first; the report turn the CLI starts once that late notification finally comes
  // must not render into that already-closed reply (an edit, which never notifies, with any
  // overflow posting below the closing it can no longer touch): it gets a fresh reply.
  const [first, notice, injected] = splitBackground();
  const ended = notice.filter(notNotification);
  const notification = notice.filter((item) => !notNotification(item));
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const a = inside(session).taskReplies.get("bny2rux7d");
  assert.ok(a !== undefined);
  h.clients[0]?.inject(ended);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  // closed out already, on the late-notification path
  await h.until(() => a.closedOut, 1.0);
  h.clients[0]?.inject([...notification, ...injected]);
  await h.until(() => h.replies().some(isReport));
  await h.sleep(0.05);
  assert.ok(!isReport(at(h.bodies(), 0))); // a's own body is untouched
  assert.ok(h.bodies().slice(1).some(isReport)); // the report got a reply of its own
});

/** Whether each message of the thread, in the order they were made, shows a footer now. */
function footers(h: Harness): boolean[] {
  return h.slack.createdTs.map(
    (ts) => h.slack.messages.get(ts)?.blocks.some((block) => block.type === "divider") ?? false,
  );
}

test("a report in a reply of its own gets the footer of its end and the reply above keeps its own", async (t) => {
  // The reply that started the task ended, with its footer, when the wait for the report ran
  // out: the session had ended. The report starts new work, and its reply ends with a footer too.
  const [first, notice, injected] = splitBackground();
  const ended = notice.filter(notNotification);
  const notification = notice.filter((item) => !notNotification(item));
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const a = inside(session).taskReplies.get("bny2rux7d");
  assert.ok(a !== undefined);
  h.clients[0]?.inject(ended);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => a.closedOut, 1.0);
  await h.idle();
  await h.sleep(3); // the footer is an edit, which waits its debounce
  assert.deepEqual(footers(h), [true]); // the session ended: the first reply has its footer
  const pushes = h.slack.pushes();
  h.clients[0]?.inject([...notification, ...injected]);
  await h.until(() => h.replies().some(isReport));
  await h.until(() => !session.busy);
  await h.idle();
  await h.sleep(3); // the edit waits its debounce, as every change to an ended reply does
  assert.deepEqual(footers(h), [true, true]);
  // The report's own end rang once; the footer of the first reply stayed where it was.
  assert.equal(h.slack.pushes(), pushes + 1);
});

test("each end of the whole session keeps its footer, whatever sits between the replies", async (t) => {
  // The reply above the report is here an owner's turn that did not start the task; the task's
  // own reply has the owner's prompt below it.
  const [first, notice, injected] = splitBackground();
  const ended = notice.filter(notNotification);
  const notification = notice.filter((item) => !notNotification(item));
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const a = inside(session).taskReplies.get("bny2rux7d");
  assert.ok(a !== undefined);
  h.clients[0]?.inject(ended);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => a.closedOut, 1.0);
  await (await session.submit("something else")).done.wait();
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(footers(h), [true, true]);
  h.clients[0]?.inject([...notification, ...injected]);
  await h.until(() => h.replies().some(isReport));
  await h.until(() => !session.busy);
  await h.idle();
  await h.sleep(3);
  // Each end of the session drew its footer where the app's last message was then.
  assert.deepEqual(footers(h), [true, true, true]);
});

test("a lost process ends the reply, then draws the footer by an edit written at once", async (t) => {
  // A lost process ends the replies first and draws the footer after, by an edit.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  await h.until(() => session.idle);
  await h.idle();
  assert.deepEqual(footers(h), [true]); // written at once, no debounce for a close to flush
  await session.close();
  assert.deepEqual(footers(h), [true]);
});

test("an owner's next prompt leaves the footer of the reply above it", async (t) => {
  const tools = sdkMessages("tools");
  const h = harnessFor(t)({ turns: [tools, tools] });
  const session = h.session();
  await (await session.submit("first")).done.wait();
  await h.idle(); // the session ends: the footer is drawn before the next prompt
  await (await session.submit("second")).done.wait();
  await h.idle();
  assert.deepEqual(footers(h), [true, true]);
});

test("the unreported expiry timer does not outlive close", async (t) => {
  // `expireUnreported`'s own task lives in a set of its own, which `close` must cancel along
  // with everything else, or it would try to post through a session that is already gone once
  // its wait finally elapses.
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice.filter(notNotification));
  await h.until(() => inside(session).unreported.size > 0);
  const timers = [...inside(session).expiring];
  assert.ok(timers.length > 0);
  await session.close(texts.ENDED_IDLE);
  assert.ok(timers.every((timer) => timer.done));
  assert.ok([...inside(session).expiring].every((timer) => timer.done));
});

test("closing a session does not cancel a pending usage refresh", async (t) => {
  // A usage refresh shares one probe, and its one client, across every session; a refresh cut
  // in the middle would leave that shared client answering the next lookup, of any session,
  // late. `close` cancels its own timers, never a refresh. The refresh is given no signal at
  // all, and the test reads that it is still under way.
  const h = harnessFor(t)({});
  const session = h.session();
  const started = new AsyncEvent();
  const release = new AsyncEvent();
  let finished = false;
  t.mock.method(h.usage, "refreshIfStale", async () => {
    started.set();
    await release.wait();
    finished = true;
  });
  inside(session).refreshUsage();
  await started.wait();
  await session.close(texts.ENDED_IDLE);
  assert.equal(finished, false);
  release.set(); // nothing else will, once the test is done with it
});

/** Hold the next `chat.stopStream` open: the end of a reply is where the expiry's work holds. */
function armGate(h: Harness): AsyncEvent {
  const gate = new AsyncEvent();
  h.slack.gate = gate;
  h.slack.gated.clear();
  return gate;
}

function openGate(h: Harness, gate: AsyncEvent): void {
  h.slack.gate = null;
  gate.set();
}

/**
 * The wait for a report turn runs out: the sessions' clock crosses INJECTED_TURN_WAIT once what
 * was injected has been read.
 */
async function reportTurnNeverCame(h: Harness): Promise<void> {
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
}

function taskReply(session: ThreadSession, taskId: string): TurnRenderer {
  const reply = inside(session).taskReplies.get(taskId);
  assert.ok(reply !== undefined);
  return reply;
}

test("a report turn starting over the expiry s write leaves the root on done", async (t) => {
  // The report turn starts after INJECTED_TURN_WAIT, while `expireInjectedTurn` already writes
  // the end of the reply that started the task: `startTurn` cancels that write, which must not
  // leave the reply's end unresolved (and ⏳ on the root for good).
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const a = taskReply(session, "bny2rux7d");
  const gate = armGate(h);
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait(); // the expiry's end is inside its write
  h.clients[0]?.inject(injected); // the report turn starts over that write
  await h.until(() => inside(session).active !== null, 1.0);
  openGate(h, gate);
  await h.until(() => h.reactions().at(-1) === Status.DONE && session.idle, 3.0);
  assert.equal(inside(session).unlanded.size, 0);
  assert.equal(await a.sink.waitLanded(), true);
});

test("two notifications a moment apart end both replies and show done", async (t) => {
  const [first, notice, injected] = splitBackground();
  const [firstB, noticeB] = renamedBackground();
  const h = harnessFor(t)({ turns: [first, firstB] });
  const session = h.session();
  await (await session.submit("start A")).done.wait();
  await (await session.submit("start B")).done.wait();
  const a = taskReply(session, "bny2rux7d");
  const b = taskReply(session, "bc41other");
  const gate = armGate(h);
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait(); // the expiry's end of A is in its write
  h.clients[0]?.inject([...noticeB, ...injected]); // the report turn starts over it
  await h.until(() => inside(session).active !== null, 1.0);
  openGate(h, gate);
  await h.until(() => a.closedOut && b.closedOut, 2.0);
  await h.until(() => h.reactions().at(-1) === Status.DONE && session.idle, 3.0);
  assert.ok(inside(session).unlanded.size === 0 && !inside(session).injectedExpected);
  assert.equal(await a.sink.waitLanded(), true);
  assert.equal(await b.sink.waitLanded(), true);
  assert.ok(![...h.slack.messages.values()].some((message) => message.streaming));
});

test("a report turn keeps the reply it renders into open while the expiry sweeps", async (t) => {
  // Guard against letting the expiry's work run beside a turn (`startTurn`'s cancel is the
  // exclusion). Replies A and B each hold a task. The first notification's wait passes and the
  // expiry's sweep stops on the end of that reply; the second notification arrives and the
  // report turn starts, rendering into the second reply. A sweep that resumed under the turn
  // would close that reply with its snapshot of the active turn (none). The sweep walks the
  // replies in the order their tasks started, which is the order the test needs (A first).
  const [first, notice, injected] = splitBackground();
  const [firstB, noticeB] = renamedBackground();
  const h = harnessFor(t)({ turns: [first, firstB] });
  const session = h.session();
  await (await session.submit("start A")).done.wait();
  await (await session.submit("start B")).done.wait();
  const target = taskReply(session, "bc41other"); // the second notified: the turn renders there
  const gate = armGate(h);
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait();
  h.clients[0]?.inject([...noticeB, ...injected.slice(0, 3)]); // the turn's first message starts it
  await h.until(() => inside(session).active !== null, 1.0);
  openGate(h, gate);
  await h.sleep(0.05); // whatever the sweep still does, it has done by now
  assert.ok(!target.closedOut);
  h.clients[0]?.inject(injected.slice(3));
  await h.until(() => target.closedOut, 3.0);
  await h.until(() => ![...h.slack.messages.values()].some((message) => message.streaming), 2.0);
  const shown = at(h.slack.messageBlocks(), -1); // the ending the report turn posted
  // the report turn's footer, not the first's
  assert.ok(String(at(at(shown, -1).elements as JsonObject[], 0).text).includes("49.2k"));
});

test("an owner prompt sent during the expiry s work runs after it", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const a = taskReply(session, "bny2rux7d");
  const gate = armGate(h);
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait(); // the expiry's end is inside its write
  const turn = await session.submit("and now?");
  await h.until(() => h.clients[0]?.queries.at(-1) === "and now?", 1.0);
  h.clients[0]?.answer(sdkMessages("tools")); // its turn starts over that write
  await h.until(() => inside(session).active !== null, 1.0);
  openGate(h, gate);
  await turn.done.wait();
  await h.until(() => h.reactions().at(-1) === Status.DONE && session.idle, 2.0);
  assert.equal(inside(session).unlanded.size, 0);
  assert.equal(await a.sink.waitLanded(), true);
});

test("a close during the expiry s work ends promptly and leaks no task", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const a = taskReply(session, "bny2rux7d");
  // `close` settles every reply, which waits for the write in flight. That write is held at a
  // gate and let go once the close has reached it, and no clock is read.
  const gate = armGate(h);
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.until(() => a.closedOut, 1.0); // the expiry is writing
  await h.slack.gated.wait();
  const working = inside(session).expiry;
  let closed = false;
  const closing = session.close().then(() => {
    closed = true;
  });
  await h.idle();
  assert.equal(closed, false); // the close waits for the write Slack still holds, and no longer
  openGate(h, gate);
  await closing;
  await h.sleep(0.2); // the write Slack still held answers, then nothing is left
  // The expiry task has ended and no other was made.
  assert.ok(working?.done && inside(session).expiry === working);
  assert.equal(await a.sink.waitLanded(), true);
});

/**
 * Two replies, each holding a background task, and the Slack gate armed on the first
 * notification's expiry (the end of a reply is where it holds). Returns the records of the
 * first notification, those of the second, the report turn, the second reply and the gate.
 */
async function twoRepliesWithAGate(
  h: Harness,
  session: ThreadSession,
): Promise<[Item[], Item[], Item[], TurnRenderer, AsyncEvent]> {
  const [, notice, injected] = splitBackground();
  const [, noticeB] = renamedBackground();
  await (await session.submit("start A")).done.wait();
  await (await session.submit("start B")).done.wait();
  const gate = armGate(h);
  return [notice, noticeB, injected, taskReply(session, "bc41other"), gate];
}

function twoBackgrounds(t: TestContext): [Harness, ThreadSession] {
  const [first] = splitBackground();
  const [firstB] = renamedBackground();
  const h = harnessFor(t)({ turns: [first, firstB] });
  return [h, h.session()];
}

test("a notification during the expiry s standalone write waits for its own turn", async (t) => {
  // The expiry posts a background update (a task of no tracked reply) and a second notification
  // arrives while that write is out. Its wait starts when the write ends, not never: the
  // session keeps reading as waiting for the report turn, and the owner's prompt stays behind
  // it.
  const [h, session] = twoBackgrounds(t);
  const [notice, noticeB, injected, b, gate] = await twoRepliesWithAGate(h, session);
  inside(session).taskReplies.delete("bny2rux7d"); // A's reply is gone: its records are held
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait(); // the expiry's standalone is in its write
  // The next wait outlives the test: the sessions' clock is not moved again.
  h.clients[0]?.inject(noticeB);
  await h.until(() => inside(session).injectedExpected);
  const working = inside(session).expiry;
  openGate(h, gate);
  await h.until(() => inside(session).expiry !== working); // the wait of the second notification
  assert.equal(h.slack.createdTs.length, 2); // the expiry wrote the held update into B, the last reply
  assert.equal(inside(session).expiry?.done, false);
  assert.ok(inside(session).injectedExpected && !inside(session).settled.isSet && !session.idle);
  await session.submit("and now?");
  await h.sleep(0.1);
  assert.deepEqual(h.clients[0]?.queries, ["start A", "start B"]); // held behind the report turn
  assert.ok(!h.reactions().slice(2).includes(Status.DONE));
  h.clients[0]?.inject(injected);
  await h.until(() => b.closedOut && inside(session).settled.isSet, 3.0);
  assert.ok(!inside(session).injectedExpected);
});

test("a notification during the expiry s sweep gets its wait started after it", async (t) => {
  // The sweep ends A's reply while the second notification arrives: with nothing armed for it
  // the session would read as waiting for ever, holding every prompt behind a turn that may
  // never come. Its own wait runs out, and the session reads idle again.
  const [h, session] = twoBackgrounds(t);
  const [notice, noticeB, , b, gate] = await twoRepliesWithAGate(h, session);
  const a = taskReply(session, "bny2rux7d");
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait(); // the sweep is in the end of A
  h.clients[0]?.inject(noticeB);
  await h.until(() => inside(session).injectedExpected);
  const working = inside(session).expiry;
  openGate(h, gate);
  await h.until(() => inside(session).expiry !== working);
  await reportTurnNeverCame(h); // the second notification's own wait runs out
  await h.until(() => a.closedOut && b.closedOut, 3.0);
  await h.until(() => h.reactions().at(-1) === Status.DONE && session.idle, 3.0);
  assert.ok(!inside(session).injectedExpected && inside(session).settled.isSet);
  assert.equal(inside(session).unlanded.size, 0);
});

test("a close while a notification waits after the expiry s work leaks no task", async (t) => {
  const [h, session] = twoBackgrounds(t);
  const [notice, noticeB, , , gate] = await twoRepliesWithAGate(h, session);
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait();
  h.clients[0]?.inject(noticeB);
  await h.until(() => inside(session).injectedExpected);
  const working = inside(session).expiry;
  openGate(h, gate);
  await h.until(() => inside(session).expiry !== working);
  const waiting = inside(session).expiry;
  assert.ok(waiting !== null && !waiting.done);
  await session.close();
  assert.ok(waiting.done);
  // No expiry task was made after this one.
  assert.equal(inside(session).expiry, waiting);
});

test("a close during the expiry s write with a notification pending arms no timer", async (t) => {
  // The expiry task `close` is cancelling must not arm the wait of the notification that came
  // during its write: `close` cancels twice, which is all that would catch such a timer.
  // A timer is a task the session keeps, and the one the session holds after the close is still
  // the one that was writing.
  const [h, session] = twoBackgrounds(t);
  const [notice, noticeB, , , gate] = await twoRepliesWithAGate(h, session);
  inside(session).taskReplies.delete("bny2rux7d"); // A's records are held: the expiry posts them
  h.clients[0]?.inject(notice);
  await reportTurnNeverCame(h);
  await h.slack.gated.wait(); // the standalone is in its write
  h.clients[0]?.inject(noticeB);
  await h.until(() => inside(session).injectedExpected);
  const writing = inside(session).expiry;
  const closing = session.close();
  await h.until(() => session.closed);
  openGate(h, gate);
  await closing;
  const calls = h.slack.apiCalls.length;
  await h.sleep(0.2);
  await h.clock.advance(INJECTED_TURN_WAIT);
  assert.ok(writing?.done && inside(session).expiry === writing); // the one that was writing, and no other
  assert.equal(h.slack.apiCalls.length, calls); // nothing writes to Slack after the close
});

test("a sweep that fails still arms the wait of a notification that came during it", async (t) => {
  const [h, session] = twoBackgrounds(t);
  const [notice, noticeB] = await twoRepliesWithAGate(h, session);
  h.slack.gate = null;
  let sweeps = 0;
  t.mock.method(inside(session), "sweepClosedOut", async (signal?: AbortSignal) => {
    // `expireUnreported` sweeps too: only the expiry's own sweep fails. The sweep is handed the
    // signal of the task that calls it.
    if (signal === undefined || signal !== inside(session).expiry?.signal) return;
    sweeps += 1;
    if (sweeps === 1) {
      h.clients[0]?.inject(noticeB); // a notification arrives during the sweep's writes
      await h.until(() => inside(session).injectedExpected);
      throw new Error("the sweep failed");
    }
  });
  h.clients[0]?.inject(notice);
  await h.idle();
  // The timer of the first notification, which does the sweep: read before its wait runs out,
  // since here the failed sweep is over by the time the clock has been moved.
  const working = inside(session).expiry;
  assert.ok(working !== null);
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => sweeps === 1);
  await h.until(() => inside(session).expiry !== working);
  assert.equal(inside(session).expiry?.done, false);
  assert.ok(inside(session).injectedExpected && !inside(session).settled.isSet);
});

test("owner query waits for an expected background turn", async (t) => {
  const [first, notice, injected] = splitBackground();
  assert.ok(notice.some((item) => isSystem(item, "task_notification")));
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice);
  await h.sleep(0.05);
  const second = await session.submit("next");
  await h.sleep(0.05);
  assert.deepEqual(h.clients[0]?.queries, ["start it"]);
  h.clients[0]?.inject(injected);
  await second.done.wait();
  assert.deepEqual(h.clients[0]?.queries, ["start it", "next"]);
  const background = h.bodies().map(isReport);
  // The owner's message sits below the reply that started the task, so the report opens a reply
  // of its own at the bottom and the answer to the message follows it.
  assert.deepEqual(background, [false, true, false]);
});

/** The title of the list of what still runs that a message shows, if any. */
function runningTitle(blocks: readonly JsonObject[]): string | null {
  const card = blocks.find((block) => block.block_id === "running-list");
  return card === undefined ? null : String(card.title);
}

function noStreamOpen(h: Harness): boolean {
  return ![...h.slack.messages.values()].some((message) => message.streaming);
}

test("the list follows the thread's last reply at rest", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  // The first reply waits for the task and rests: it holds the list, above its footer.
  await h.until(() => runningTitle(at(h.slack.messageBlocks(), 0)) === "1 shell still running");
  await (await session.submit("next")).done.wait();
  // The new, unrelated reply ended below it: the list moved to it, and the first shows none.
  assert.deepEqual(h.slack.callsTo("chat.delete"), []);
  await h.until(() => runningTitle(at(h.slack.messageBlocks(), -1)) === "1 shell still running");
  await h.until(() => runningTitle(at(h.slack.messageBlocks(), 0)) === null);
  h.clients[0]?.inject([...notice, ...injected]);
  // The first reply is no longer the last thing in the thread: the report opens a reply of its
  // own at the bottom (issue #295).
  await h.until(() => h.bodies().some(isReport));
  // the task has ended: no reply shows a list any more. The second reply already stopped, so
  // this update of it debounces like any other change to a finished reply: `until` gives it the
  // room to land.
  await h.until(() => h.slack.messageBlocks().every((blocks) => runningTitle(blocks) === null));
});

test("two prompts in a row: the last reply rests for the first command and takes its report", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  // The first reply's stream stays open for its background task: nothing has stopped yet.
  assert.deepEqual([h.slack.streamTs.length, h.slack.callsTo("chat.stopStream").length], [1, 0]);
  await (await session.submit("next")).done.wait();
  // the second reply has nothing of its own pending, but it is the last reply and the first
  // command still runs: it rests, to take that command's report
  assert.equal(h.slack.streamTs.length, 2);
  assert.ok(!at(h.slack.messageBlocks(), -1).some((block) => block.type === "divider"));
  h.clients[0]?.inject([...notice, ...injected]);
  // The first reply is no longer the last thing in the thread: the report renders into the
  // second, which then ends, and the first stops in place with it. One footer, under the last
  // message.
  await h.until(() => session.idle);
  await h.sleep(3);
  assert.equal(h.slack.streamTs.length, 2);
  assert.ok(h.bodies().some(isReport));
  assert.equal(footers(h).filter(Boolean).length, 1, "the session ended with the report");
  assert.equal(footers(h).at(-1), true);
  assert.equal(h.slack.pushes(), 3);
});

test("two prompts tasks ending together each reply ends", async (t) => {
  // The CLI's one report turn opens with the end of every task that finished together but
  // renders into only one reply: the first of the tasks' replies that is the last thing in the
  // thread, B's here, since B sits below A. The other must still end, not wait forever for a
  // report turn that was never coming for it specifically.
  const [first, notice, injected] = splitBackground();
  const [firstB, noticeB] = renamedBackground();
  const h = harnessFor(t)({ turns: [first, firstB] });
  const session = h.session();
  await (await session.submit("start A")).done.wait();
  await (await session.submit("start B")).done.wait();
  const a = taskReply(session, "bny2rux7d");
  const b = taskReply(session, "bc41other");
  assert.notEqual(a, b);
  // Both tasks end while idle, then Claude Code's one report turn, which renders into A's
  // reply (the first of the two ended tasks).
  h.clients[0]?.inject([...notice, ...noticeB, ...injected]);
  await h.until(() => a.closedOut);
  // The sessions' clock crosses the wait.
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => b.closedOut);
  await h.until(() => noStreamOpen(h));
  assert.equal(h.slack.callsTo("chat.stopStream").length, 2);
});

test("a background task frame stays out of other replies", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.replies().some(isReport));
  await h.sleep(0.05);
  const report = h.replies().find(isReport);
  const taskId = String(systemRecord(notice, "task_notification").task_id);
  assert.ok(report !== undefined && !report.includes(taskId));
});

function hasParent(item: Item): boolean {
  return (recordOf(item)?.parent_tool_use_id ?? null) !== null;
}

test("a background agent is a launch line, and its calls write nothing", async (t) => {
  // subagent.jsonl: the agent's own calls arrive after the turn that started it has ended.
  const [first, ...later] = splitTurns(sdkMessages("subagent")) as [Item[], ...Item[][]];
  assert.ok(later.flat().some(hasParent));
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const launch = "**Agent**(Run ls and report contents)\n⎿ Running in background";
  assert.ok(at(h.bodies(), 0).includes(launch));
  h.clients[0]?.inject(later.flat());
  await h.until(() => h.reactions().at(-1) === Status.DONE && session.idle, 3.0);
  // No card at any point, for the agent or for what it ran, and one launch line.
  assert.deepEqual(h.slack.messageCards().flat(), []);
  const body = at(h.bodies(), 0);
  assert.equal(body.split("Running in background").length - 1, 1);
  assert.ok(body.includes('✓ Agent "Run ls and report contents" finished'));
  assert.equal(h.slack.streamTs.length, 1);
});

test("a background agent that ends while a turn runs has its end line in that turn s reply", async (t) => {
  // subagent.jsonl with the frames of the agent's end moved before the first turn's result, as
  // for an agent quicker than the turn that started it. With no card to complete, the end is a
  // line of the reply being written, where the terminal prints it (captured 2026-10-13 on
  // Claude Code 2.1.296).
  const [first, ...later] = splitTurns(sdkMessages("subagent")) as [Item[], ...Item[][]];
  const ends = later
    .flat()
    .filter((item) => isSystem(item, "task_updated") || isSystem(item, "task_notification"));
  assert.equal(ends.length, 2);
  const h = harnessFor(t)({ turns: [[...first.slice(0, -1), ...ends, at(first, -1)]] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => session.idle);
  const body = at(h.bodies(), 0);
  assert.equal(body.split('✓ Agent "Run ls and report contents" finished').length - 1, 1);
  assert.ok(body.indexOf("Running in background") < body.indexOf("✓ Agent"));
  assert.deepEqual(h.slack.messageCards().flat(), []);
  assert.equal(session.runningKinds, "");
});

test("a background agent that ends while a message waits has its end line in that message s reply", async (t) => {
  // Seen in a real session (2026-10-13): of two agents ending as the owner wrote, one end fell
  // between the message and the start of its turn, and no line said it.
  const [first, ...later] = splitTurns(sdkMessages("subagent")) as [Item[], ...Item[][]];
  const ends = later
    .flat()
    .filter((item) => isSystem(item, "task_updated") || isSystem(item, "task_notification"));
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const waiting = session.submit("hello");
  h.clients[0]?.inject(ends);
  await (await waiting).done.wait();
  await h.until(() => session.idle);
  const line = '✓ Agent "Run ls and report contents" finished';
  assert.equal(h.bodies().join("\n").split(line).length - 1, 1);
  assert.ok(at(h.bodies(), -1).includes(line) || at(h.bodies(), 0).includes(line));
});

test("ended tasks are forgotten past the limit", async (t) => {
  const [first, notice, injected] = splitBackground();
  const renamed = first.map((item) => {
    const record = recordOf(item);
    const task = ["task_started", "task_notification", "task_updated"].some((subtype) =>
      isSystem(item, subtype),
    );
    return record !== null && task ? { record: { ...record, task_id: "other" } } : item;
  });
  // One task reply is kept (`taskRepliesKept: 1`).
  const h = harnessFor(t, { taskRepliesKept: 1 })({ turns: [first, renamed] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => isReport(h.bodies()[0] ?? ""));
  await (await session.submit("again")).done.wait();
  assert.deepEqual([...inside(session).taskReplies.keys()], ["other"]);
});

test("a failed background task shows why in the reply that started it", async (t) => {
  const [first, notice, injected] = splitBackground();
  // The recorded order: a terminal task_updated (no summary), then task_notification (summary).
  const failed = notice.map((item) => withTaskStatus(item, "failed"));
  const summary = String(systemRecord(notice, "task_notification").summary);
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  h.clients[0]?.inject([...failed, ...injected]);
  await h.until(() => h.replies().some(isReport));
  const started = at(h.replies(), 0);
  const words = summary.split(/\s+/).filter(Boolean).join(" ").slice(0, 40);
  assert.ok(started.includes("✗") && started.includes(words));
});

test("closing the session leaves no card and no stream for running tasks", async (t) => {
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  await h.manager.closeAll();
  assert.equal(runningTitle(at(h.slack.messageBlocks(), 0)), null);
  // A command left running has no card to stop (issue #299): the list is all that showed it.
  assert.deepEqual(h.cards(), []);
  assert.ok(noStreamOpen(h));
});

test("a shutdown during an active turn with a background task ends both replies", async (t) => {
  // A restart or shutdown while a turn is active, with an earlier background task still
  // running: `closeReply` with `force` runs before `stopTaskReplies` has actually stopped the
  // task, and both replies still end with their streams stopped, nothing posted.
  const [first] = splitBackground();
  const partial = sdkMessages("tools")
    .filter((item) => !isResult(item))
    .slice(0, 22);
  const h = harnessFor(t)({ turns: [first, partial] }); // the second query gets no scripted result
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await session.submit("second");
  await h.until(() => inside(session).active !== null);
  await session.close(); // a restart or a shutdown: ends everything
  assert.deepEqual(h.slack.postedTs, []);
  assert.ok(noStreamOpen(h));
  assert.equal(h.slack.streamTs.length, 2);
});

test("an idle close ends a reply that still waited for its task", async (t) => {
  // An idle close (like a restart or SessionGone) stops the still-open stream at once and puts
  // the footer under it, which the close flushes.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  assert.deepEqual(h.slack.callsTo("chat.stopStream"), []);
  await session.close(texts.ENDED_IDLE);
  const [stop, ...more] = h.slack.callsTo("chat.stopStream");
  assert.equal(more.length, 0);
  assert.ok(!blocksOf(stop).some((block) => block.type === "divider"));
  assert.deepEqual(footers(h), [true]);
  assert.deepEqual(h.slack.postedTs, []);
});

test("a notification with no turn is said in the reply to the next message and releases the queue", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice);
  await h.sleep(0.05);
  const second = await session.submit("next");
  await reportTurnNeverCame(h); // the wait for a report turn passes
  await second.done.wait();
  // The task has no line, and the owner's message came before any report: its end is said at
  // the top of the reply to that message, where the terminal prints it, and in no post of its
  // own.
  await h.until(() => isReport(at(h.replies(), 1)));
  assert.ok(!isReport(at(h.replies(), 0)));
  assert.equal(h.slack.streamTs.length, 2);
  assert.deepEqual(h.slack.callsTo("chat.postMessage"), []);
  assert.deepEqual(h.clients[0]?.queries, ["start it", "next"]);
});

/** A recorded background task's records, as another task of the same turn. */
function asSecondTask(item: Item): Item {
  return JSON.parse(
    JSON.stringify(item)
      .replaceAll("bny2rux7d", "bny2other")
      .replaceAll("toolu_01LiZwhcy5g12fYSVLgAq5TS", "toolu_01OTHERxxxxxxxxxxxxxxxxx")
      .replaceAll("Sleep for 5 seconds then print done", "Second sleep"),
  );
}

test("a task that ends after a report turn began waits for the next report turn", async (t) => {
  // Measured 2026-10-14 (Claude Code 2.1.296): of two tasks ending 0.3 s apart, the second was
  // notified after the first report turn began, and that turn knew of the first alone. The
  // records of the second task are the recorded ones under other ids.
  const [first, notice, injected] = splitBackground();
  const started = first.findIndex((item) => isSystem(item, "task_started"));
  const turn = [
    ...first.slice(0, started + 1),
    asSecondTask(at(first, started)),
    ...first.slice(started + 1),
  ];
  const late = notice.filter(
    (item) => isSystem(item, "task_updated") || isSystem(item, "task_notification"),
  );
  const h = harnessFor(t)({ turns: [turn] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice);
  await h.sleep(0.05);
  h.clients[0]?.inject(injected.slice(0, 1)); // the report turn begins with its init record
  await h.sleep(0.05);
  h.clients[0]?.inject(late.map(asSecondTask)); // the second task ends before the turn's first message
  await h.sleep(0.05);
  h.clients[0]?.inject(injected.slice(1));
  await h.until(() => inside(session).active === null && h.replies().some(isReport), 3.0);
  const text = h.replies().join("\n");
  assert.ok(text.includes('Background command "Sleep for 5 seconds then print done" completed'));
  assert.ok(!text.includes("Second sleep"));
  // No turn comes to report the second: once the wait for one has passed, its end is said in
  // the reply that started it. The first report's start had cancelled the wait.
  await reportTurnNeverCame(h);
  await h.until(() => h.replies().join("\n").includes('Background command "Second sleep"'), 3.0);
});

test("a query crossing a notification never hangs", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools"), sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice);
  const second = await session.submit("next");
  await second.done.wait();
  h.clients[0]?.inject(injected);
  const third = await session.submit("after");
  await third.done.wait();
  assert.deepEqual(h.clients[0]?.queries, ["start it", "next", "after"]);
});

test("a notification after the owner query was sent leaves the turn to the owner", async (t) => {
  // Measured 2026-09-24: the owner's prompt reached the CLI queue first, then the task ended;
  // the CLI reported the task inside the owner's turn and started no turn of its own.
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const second = await session.submit("next");
  await h.until(() => h.clients[0]?.queries.join() === "start it,next");
  h.clients[0]?.inject(notice);
  await h.sleep(0.05);
  h.clients[0]?.answer(sdkMessages("tools"));
  await second.done.wait();
  // The command has no line to update, so its end opens the owner's reply, where the terminal
  // prints it; no report reply of its own follows.
  const replies = h.replies();
  assert.equal(replies.length, 2);
  assert.ok(!isReport(at(replies, 0)) && isReport(at(replies, 1)));
  assert.equal(h.slack.streamTs.length, 2);
});

function loseEveryWrite(h: Harness): void {
  for (const method of WRITES) h.slack.responses[method] = networkDown();
}

test("a slack network error does not stop the session", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools"), sdkMessages("tools")] });
  loseEveryWrite(h);
  const session = h.session();
  await (await session.submit("while offline")).done.wait();
  assert.ok(h.clients[0]?.connected);
  h.slack.responses = new FakeSlack().responses;
  await (await session.submit("back online")).done.wait();
  assert.deepEqual(h.clients[0]?.queries, ["while offline", "back online"]);
  assert.equal(h.clients.length, 1);
});

test("a cli that exits ends the turn and the next message reconnects", async (t) => {
  const h = harnessFor(t)(
    { turns: [[...sdkMessages("tools").slice(0, 3), END_OF_STREAM]] },
    { turns: [sdkMessages("tools")] },
  );
  const session = h.session();
  await (await session.submit("first")).done.wait();
  await (await session.submit("second")).done.wait();
  assert.deepEqual(
    h.clients.map((client) => client.queries),
    [["first"], ["second"]],
  );
});

test("a cli that exits mid turn ends its reply once", async (t) => {
  // Cut right after the reply's first message_start: where that falls among the init, status
  // and rate-limit messages changes between CLI releases.
  const tools = sdkMessages("tools");
  const started = tools.findIndex(
    (item) => isRecord(item, "stream_event") && part(item, "event").type === "message_start",
  );
  assert.notEqual(started, -1);
  const h = harnessFor(t)({ turns: [[...tools.slice(0, started + 1), END_OF_STREAM]] });
  const session = h.session();
  await (await session.submit("first")).done.wait();
  assert.ok(h.slack.streamTs.length === 1 && h.slack.pushes() === 1);
  assert.ok(noStreamOpen(h));
});

test("a failed background post still releases the queue", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  loseEveryWrite(h);
  h.clients[0]?.inject(notice);
  await h.sleep(0.02);
  const second = await session.submit("next");
  await reportTurnNeverCame(h); // the wait for a report turn passes
  await second.done.wait();
  assert.deepEqual(h.clients[0]?.queries, ["start it", "next"]);
});

test("a missing directory starts nothing and says so", async (t) => {
  const h = harnessFor(t)({});
  const missing = join(h.tmpPath, "gone");
  mkdirSync(missing);
  h.state.bind(CHANNEL, missing);
  rmdirSync(missing);
  const turn = await h.session().submit("hello");
  await turn.done.wait();
  assert.deepEqual(h.clients, []);
  assert.deepEqual(h.bodies(), [texts.fill(texts.DIRECTORY_MISSING, { directory: missing })]);
  assert.equal(h.slack.pushes(), 1); // the reply's one stop: an error the owner has to act on
});

test("an unreadable directory says how to grant access", POSIX_ONLY, async (t) => {
  const h = harnessFor(t)({});
  const locked = join(h.tmpPath, "locked");
  mkdirSync(locked);
  h.state.bind(CHANNEL, locked);
  chmodSync(locked, 0);
  try {
    const turn = await h.session().submit("hello");
    await turn.done.wait();
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.deepEqual(h.clients, []);
  assert.deepEqual(h.bodies(), [texts.fill(texts.DIRECTORY_UNREADABLE, { directory: locked })]);
  assert.equal(h.slack.pushes(), 1);
});

test(
  "a directory under a folder the daemon cannot enter says how to grant access",
  POSIX_ONLY,
  async (t) => {
    // The stat itself is refused there. It read as a folder that no longer exists.
    const h = harnessFor(t)({});
    const locked = join(h.tmpPath, "locked");
    const inside = join(locked, "inside");
    mkdirSync(inside, { recursive: true });
    h.state.bind(CHANNEL, inside);
    chmodSync(locked, 0);
    try {
      const turn = await h.session().submit("hello");
      await turn.done.wait();
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.deepEqual(h.clients, []);
    assert.deepEqual(h.bodies(), [texts.fill(texts.DIRECTORY_UNREADABLE, { directory: inside })]);
  },
);

test("a path the system refuses to look at names no folder", async () => {
  // A null in a path: Node throws before any call to the system, and the folder is missing.
  await assert.rejects(
    checkDirectory("/home/dev/pro\0ject", async () => true, NAMES),
    (error: unknown) => error instanceof DirectoryMissing,
  );
});

/** The footer (the last context block) of every write that carried one, in order. */
function statuses(h: Harness): string[] {
  const lasts: string[] = [];
  for (const call of h.slack.apiCalls) {
    const last = blocksOf(call.args).at(-1);
    if (
      ["chat.postMessage", "chat.update", "chat.stopStream"].includes(call.method) &&
      last?.type === "context"
    ) {
      lasts.push(String(at(last.elements as JsonObject[], 0).text));
    }
  }
  return lasts;
}

test("the footer follows an effort set from slack", async (t) => {
  const effortTurn = withResult(
    sdkMessages("usage"),
    "Set effort level to high (this session only): Comprehensive",
  );
  const h = harnessFor(t)({ turns: [effortTurn, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("/effort high")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  await (await session.submit("next")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.includes("*effort* high"));
});

/** A recorded turn with the CLI's Stop hook call where the CLI makes it: before the result. */
function withStopHook(turn: readonly Item[], hookInput: JsonObject): Item[] {
  return [...turn.slice(0, -1), hookRun(hookInput), at(turn, -1)];
}

test("the footer shows the effort claude code reports", async (t) => {
  // A top-level effortLevel in the settings does not decide the level (Opus 5.5 ignores the
  // user's): the level Claude Code runs at is the one its Stop hook reports.
  const hookInput = sdkJson("stop-hook") as JsonObject;
  const h = harnessFor(t)({ turns: [withStopHook(sdkMessages("tools"), hookInput)] });
  mkdirSync(join(h.tmpPath, ".claude"));
  writeFileSync(join(h.tmpPath, ".claude", "settings.json"), '{"effortLevel": "high"}');
  await (await h.session().submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.includes("*effort* medium"));
});

test("the footer leaves out the effort until claude code reports it", async (t) => {
  // A local command's turn (`/usage`) runs no Stop hook: the level is not known yet.
  const h = harnessFor(t)({ turns: [sdkMessages("usage")] });
  await (await h.session().submit("/usage")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).length > 0 && !statuses(h).at(-1)?.includes("effort"));
});

test("the footer says default when claude code reports no effort", async (t) => {
  // Claude Code leaves the field out when the model takes no effort parameter.
  const { effort: _effort, ...hookInput } = sdkJson("stop-hook") as JsonObject;
  const h = harnessFor(t)({ turns: [withStopHook(sdkMessages("tools"), hookInput)] });
  await (await h.session().submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.includes("*effort* default"));
});

test("an effort set before a restart is not carried over", async (t) => {
  // Measured 2026-09-25: a resumed session runs at the settings' level, not the `/effort` one.
  const effortTurn = withResult(
    sdkMessages("usage"),
    "Set effort level to low (this session only): Quick",
  );
  const h = harnessFor(t)(
    { turns: [effortTurn] },
    { turns: [withStopHook(sdkMessages("tools"), sdkJson("stop-hook") as JsonObject)] },
  );
  await (await h.session().submit("/effort low")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.includes("*effort* low"));
  await h.restart();
  await (await h.session().submit("next")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.includes("*effort* medium"));
});

test("an approval slack refuses to show is denied and logged", async (t) => {
  // The approval request is the only post: Slack refuses it; the reply's stream is unaffected.
  const h = harnessFor(t)({
    turns: [[canUseToolCall("Bash", { command: "ls" }), ...sdkMessages("tools")]],
  });
  const errors = logged(t, "error");
  h.slack.responses["chat.postMessage"] = rejected("ratelimited");
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  assert.deepEqual(at(h.clients[0]?.permissionResults ?? [], 0), {
    allow: false,
    message: texts.named(texts.APPROVAL_UNPOSTED, NAMES),
  });
  const line = errors.find((said) => said.includes("could not post an approval request"));
  assert.ok(line?.includes("ratelimited"));
});

test("a footer that fails to build still ends the reply", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  // The lookup `gitState` makes of the back end fails, which is the one part of it the session
  // supplies, and `gitState` lets any failure but its own timeout through.
  h.backend.repository = async () => {
    throw new TypeError("invalid start byte");
  };
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  const [stop, ...more] = h.slack.callsTo("chat.stopStream");
  assert.equal(more.length, 0);
  assert.ok(stop !== undefined && !("blocks" in stop)); // no footer to show, and the stream still stopped
  assert.ok(noStreamOpen(h));
});

test("a usage entry without a token count still gets a footer", async (t) => {
  const messages = sdkMessages("tools");
  const result = recordOf(messages.at(-1));
  assert.ok(result !== null && isResult(messages.at(-1)));
  const usage = result.modelUsage as JsonObject;
  const model = at(Object.keys(usage), 0);
  const trimmed = {
    record: { ...result, modelUsage: { [model]: { inputTokens: 1000, outputTokens: 500 } } },
  };
  const h = harnessFor(t)({ turns: [[...messages.slice(0, -1), trimmed]] });
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.includes("1.5k *tok*"));
});

test("a context usage failure is logged", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")], contextUsageError: new Error("x") });
  const warnings = logged(t, "warning");
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  assert.ok(warnings.some((line) => line.includes("could not read the context usage")));
});

/** An error as a library would raise it: what a log line says of it is its name. */
function named(name: string): Error {
  return Object.assign(new Error("x"), { name });
}

test("a failed disconnect is logged", async (t) => {
  const h = harnessFor(t)({ closeError: named("BrokenPipeError") });
  const warnings = logged(t, "warning");
  await h.session().ensureConnected();
  await h.session().close();
  const line = warnings.find((said) => said.includes("could not close Claude Code"));
  assert.ok(line?.includes("BrokenPipeError"));
});

test("a turn taken while claude code starts is ended on close", async (t) => {
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ startGate: gate });
  const session = h.session();
  const turn = await session.submit("hello");
  await h.sleep(0.05); // the worker has taken the turn and waits for the CLI
  const closing = session.close();
  const closed = finishing(closing);
  await h.sleep(0.05);
  // the turn is ended, yet the close waits for the CLI to finish starting
  assert.ok(turn.done.isSet);
  assert.ok(!closed.done());
  gate.set();
  await closing;
  // no reply had started: the taken message is named in one message of its own
  const [note, ...more] = h.slack.callsTo("chat.postMessage");
  assert.equal(more.length, 0);
  const said = texts.fill(texts.NOT_SENT_ONE, { count: 1, because: texts.BECAUSE_SHUTDOWN });
  assert.ok(String(note?.text).includes(said));
});

test("a setup failure after connect closes the client", async (t) => {
  const h = harnessFor(t)({ infoError: named("RuntimeError") }, {});
  await assert.rejects(h.session().ensureConnected(), { name: "RuntimeError" });
  assert.equal(h.clients[0]?.connected, false);
  await h.session().ensureConnected(); // the next attempt starts one process, not two
  assert.ok(h.clients.length === 2 && h.clients[1]?.connected);
});

test("a bind after a turn never touches that thread s own record", async (t) => {
  const messages = sdkMessages("tools");
  const h = harnessFor(t)({ turns: [messages] });
  const result = recordOf(messages.at(-1));
  assert.ok(result !== null && isResult(messages.at(-1)));
  await (await h.session().submit("list the files")).done.wait();
  assert.equal(thread(h).sessionId, result.session_id);
  const other = join(h.tmpPath, "other");
  mkdirSync(other);
  assert.equal(await h.manager.bind(CHANNEL, other), true); // affects only the channel's next thread
  assert.equal(h.state.channel(CHANNEL)?.directory, other);
  assert.equal(thread(h).directory, h.tmpPath);
  assert.equal(thread(h).sessionId, result.session_id);
});

test("a folder claude code does not trust is not started", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  h.backend.trusted = async () => false;
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  assert.deepEqual(h.clients, []); // no Claude Code process, so no hook of the folder's ran
  assert.ok(h.writtenText().includes("trust"));
});

/** What a session answers `info()` with, from the keys the CLI's answer holds. */
function infoOf(raw: JsonObject) {
  return agentInfo(raw);
}

test("bypass from the folder s own settings shows and turns off", async (t) => {
  const info = infoOf({ commands: [], current_permission_mode: "bypassPermissions" });
  const h = harnessFor(t)({ turns: [sdkMessages("tools"), sdkMessages("tools")], info });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.startsWith("⚡ bypass"));
  await session.setBypass(false);
  assert.equal(h.clients[0]?.modes.at(-1), "default");
  assert.ok((await session.status()).includes("Mode: `default`"));
  await (await session.submit("again")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(!statuses(h).at(-1)?.startsWith("⚡ bypass"));
});

test("a stored bypass off is sent when the agent reports no mode, with one line in the log", async (t) => {
  // The initialize answer without `current_permission_mode`, which no SDK type declares: what a
  // release that drops the field gives. The process may have started in bypass.
  const info = infoOf({ commands: [] });
  assert.equal(info.permissionMode, null);
  const warnings = logged(t, "warning");
  const h = harnessFor(t)({ turns: [sdkMessages("tools")], info });
  const session = h.session();
  h.state.setBypass(CHANNEL, THREAD, false);
  await (await session.submit("list the files")).done.wait();
  assert.deepEqual(h.clients[0]?.modes, ["default"]);
  assert.equal(session.mode, "default");
  const unreported = warnings.filter((line) => line.includes("reported no permission mode"));
  assert.equal(unreported.length, 1, warnings.join("\n"));
  assert.ok(unreported[0]?.includes(`${CHANNEL}/${THREAD}`));
});

test("a stored bypass off sends nothing when the agent reports the default mode", async (t) => {
  const info = infoOf({ commands: [], current_permission_mode: "default" });
  const warnings = logged(t, "warning");
  const h = harnessFor(t)({ turns: [sdkMessages("tools")], info });
  const session = h.session();
  h.state.setBypass(CHANNEL, THREAD, false);
  await (await session.submit("list the files")).done.wait();
  assert.deepEqual(h.clients[0]?.modes, []);
  assert.ok(!warnings.some((line) => line.includes("reported no permission mode")));
});

const AUTO_INFO = infoOf({ commands: [], current_permission_mode: "auto" });

test("a thread claude code started in auto mode says so in status only", async (t) => {
  // Bypass never chosen: the mode is the one the owner's own settings start Claude Code in.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")], info: AUTO_INFO });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  assert.deepEqual(h.clients[0]?.modes, []); // the daemon set no mode of its own
  // The footer marks bypass alone: with it off, the mode is on `!status`.
  assert.ok(!statuses(h).at(-1)?.includes("auto") && !statuses(h).at(-1)?.includes("⚡"));
  assert.ok((await session.status()).includes("Mode: `auto`"));
});

test("bypass off returns an auto thread to auto", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools"), sdkMessages("tools")], info: AUTO_INFO });
  const session = h.session();
  await session.setBypass(true);
  await (await session.submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.startsWith("⚡ bypass"));
  await session.setBypass(false);
  assert.deepEqual(h.clients[0]?.modes, ["bypassPermissions", "auto"]);
  assert.ok((await session.status()).includes("Mode: `auto`"));
  await (await session.submit("again")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(!statuses(h).at(-1)?.startsWith("⚡ bypass"));
});

test("bypass off lands on default when claude code refuses auto", async (t) => {
  // The refusal as the CLI words it for a model with no auto mode (measured 2026-10-08, SDK
  // 0.2.164): it left the session in bypass, so off has to land somewhere that is not bypass.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")], info: AUTO_INFO });
  const session = h.session();
  await session.ensureConnected();
  const client = at(h.clients, 0);
  await session.setBypass(true);
  const accepted = client.setPermissionMode.bind(client);
  client.setPermissionMode = async (mode) => {
    if (mode === "auto") {
      throw new Error("Cannot set permission mode to auto: auto mode unavailable");
    }
    await accepted(mode);
  };
  await session.setBypass(false);
  assert.deepEqual(client.modes, ["bypassPermissions", "default"]);
  assert.equal(thread(h).bypass, false);
  assert.ok((await session.status()).includes("Mode: `default`"));
  await (await session.submit("list the files")).done.wait();
  assert.ok(!statuses(h).at(-1)?.startsWith("⚡"));
});

test("bypass off that no mode accepts is not recorded", async (t) => {
  const h = harnessFor(t)({ info: AUTO_INFO });
  const session = h.session();
  await session.ensureConnected();
  const client = at(h.clients, 0);
  await session.setBypass(true);
  client.setPermissionMode = async () => {
    throw named("ConnectionError");
  };
  await assert.rejects(session.setBypass(false), { name: "ConnectionError" });
  assert.equal(thread(h).bypass, true);
  assert.ok(session.bypass);
});

test("the mode claude code reports is the one shown", async (t) => {
  // Both reports as recorded after `set_permission_mode` (2026-10-08, SDK 0.2.164): the mode
  // shown follows them, whatever the session started in.
  const [bypassReported, autoReported] = sdkMessages("permission-mode-status") as [Item, Item];
  const turns = [
    [autoReported, ...sdkMessages("tools")],
    [bypassReported, ...sdkMessages("tools")],
  ];
  const h = harnessFor(t)({ turns });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  assert.ok((await session.status()).includes("Mode: `auto`"));
  await (await session.submit("again")).done.wait();
  assert.ok((await session.status()).includes("Mode: `bypassPermissions`"));
});

test("bypass off does not trade another refused mode for default", async (t) => {
  // Only auto mode's refusal was measured: any other mode that fails stays an error.
  const info = infoOf({ commands: [], current_permission_mode: "acceptEdits" });
  const h = harnessFor(t)({ info });
  const session = h.session();
  await session.ensureConnected();
  const client = at(h.clients, 0);
  await session.setBypass(true);
  const accepted = client.setPermissionMode.bind(client);
  client.setPermissionMode = async (mode) => {
    if (mode === "acceptEdits") throw new Error("Cannot set permission mode to acceptEdits");
    await accepted(mode);
  };
  await assert.rejects(session.setBypass(false), /acceptEdits/);
  assert.deepEqual(client.modes, ["bypassPermissions"]);
  assert.ok(session.bypass);
});

test("every message is posted without link previews", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const turn = await h.session().submit("list the files");
  await h.until(() => pending(h.approvals).length === 1);
  resolve(h, APPROVE);
  await turn.done.wait();
  const posts = h.slack.callsTo("chat.postMessage");
  assert.ok(posts.length > 0); // the approval request
  assert.ok(posts.every((post) => post.unfurl_links === false && post.unfurl_media === false));
});

test("resume creates a new thread already on the given session", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] }, {});
  await (await h.session().submit("list the files")).done.wait();
  const other = "68da9311-0000-4000-8000-00000000abcd";
  const resumed = await h.manager.resume(CHANNEL, OTHER_THREAD, other);
  assert.ok(resumed !== null);
  assert.equal(thread(h, OTHER_THREAD).sessionId, other);
  assert.notEqual(thread(h).sessionId, other); // the original thread is untouched
  await resumed.ensureConnected(); // the next message on the new thread starts on that session
  assert.equal(h.clients.at(-1)?.options.resume, other);
});

test("resume creates a thread with bypass off regardless of others", async (t) => {
  const h = harnessFor(t)({}, {});
  await h.session().setBypass(true); // bypass is per thread: only the original thread's
  const resumed = await h.manager.resume(
    CHANNEL,
    OTHER_THREAD,
    "68da9311-0000-4000-8000-00000000abcd",
  );
  assert.ok(resumed !== null && !resumed.bypass);
  await resumed.ensureConnected();
  assert.deepEqual(h.clients.at(-1)?.modes, []);
});

test("resume creates an independent thread even while another is busy", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  await h.session().submit("list the files");
  await h.until(() => pending(h.approvals).length === 1);
  const resumed = await h.manager.resume(
    CHANNEL,
    OTHER_THREAD,
    "68da9311-0000-4000-8000-00000000abcd",
  );
  assert.ok(resumed !== null);
  assert.notEqual(h.state.thread(CHANNEL, OTHER_THREAD), null);
  assert.ok(h.session().busy); // the original thread's turn is unaffected
});

test("resume returns none when the channel is unbound", async (t) => {
  const h = harnessFor(t)();
  assert.equal(await h.manager.resume("C000OTHER", THREAD, "some-session"), null);
});

test("open returns none when the channel is unbound", (t) => {
  const h = harnessFor(t)();
  assert.equal(h.manager.open("C000OTHER", THREAD), null);
});

test("the footer names the bound folder", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  await (await h.session().submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  const folder = basename(h.tmpPath);
  assert.ok(statuses(h).at(-1)?.startsWith("Haiku 4.5 · "));
  assert.ok(statuses(h).at(-1)?.includes(` · ${folder} · `));
});

/** A RegExp source that matches `text` literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the footer follows the folder the session works in", async (t) => {
  // The layout where the bound folder's branch was always missing (#37). The folder shown
  // stays the channel's, where the owner bound it; the branch is the session's.
  const make = harnessFor(t);
  const repo = repoUnder(make.tmpPath);
  const moved = { ...(sdkJson("stop-hook") as JsonObject), cwd: repo };
  const h = make({ turns: [withStopHook(sdkMessages("tools"), moved)] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.match(
    statuses(h).at(-1) ?? "",
    new RegExp(
      ` · ${literal(basename(h.tmpPath))} · feature-x · \\(\\+0,-0\\) · [\\d.]+[kM]? \\*tok\\* · \\*ctx\\* `,
    ),
  );
  const lines = (await session.status()).split("\n");
  assert.equal(lines[0], `Directory: \`${h.tmpPath}\``);
  const values = lines.slice(lines.indexOf("Now: idle") + 1);
  assert.equal(values[0], `Working in: \`${repo}\``);
  assert.ok(values.includes("Branch: `feature-x`") && values.includes("Uncommitted: `(+0,-0)`"));
});

test("a tool s hook moves the branch when no stop hook runs", async (t) => {
  // A turn stopped or failed runs no Stop hook; PostToolUse still reports where the session
  // went after the tool (measured 2026-09-27 on 2.1.283), so the footer is not left behind.
  const make = harnessFor(t);
  const repo = repoUnder(make.tmpPath);
  const messages = sdkMessages("tools");
  const firstResult = messages.findIndex(isToolResult);
  assert.notEqual(firstResult, -1);
  const moved = { ...(sdkJson("post-tool-use-hook") as JsonObject), cwd: repo };
  const turn = [
    ...messages.slice(0, firstResult + 1),
    hookRun(moved, "PostToolUse"),
    ...messages.slice(firstResult + 1),
  ];
  const h = make({ turns: [turn] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(
    statuses(h)
      .at(-1)
      ?.includes(` · ${basename(h.tmpPath)} · feature-x · (+0,-0) · `),
  );
  assert.equal(session.workingDirectory, repo);
});

test("the footer leaves out the branch of a repository not trusted", async (t) => {
  // The session went into a repo the owner never trusted in Claude Code: no git runs there,
  // and neither the footer nor `!status` says anything in its place.
  const make = harnessFor(t);
  const repo = repoUnder(make.tmpPath);
  const moved = { ...(sdkJson("stop-hook") as JsonObject), cwd: repo };
  const h = make({ turns: [withStopHook(sdkMessages("tools"), moved)] });
  h.backend.repository = async () => null;
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  assert.ok(!statuses(h).at(-1)?.includes("feature-x") && !statuses(h).at(-1)?.includes("(+0,-0)"));
  const text = await session.status();
  assert.ok(text.includes(`Working in: \`${repo}\``));
  assert.ok(!text.includes("Branch:") && !text.includes("Uncommitted:"));
});

test("a restarted client starts again in the bound folder", async (t) => {
  const make = harnessFor(t);
  const repo = repoUnder(make.tmpPath);
  const moved = { ...(sdkJson("stop-hook") as JsonObject), cwd: repo };
  const h = make({ turns: [withStopHook(sdkMessages("tools"), moved)] }, { turns: [] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle(); // the footer is drawn once the session has ended
  assert.ok(statuses(h).at(-1)?.includes("feature-x"));
  await h.restart();
  const text = await h.session().status();
  assert.ok(!text.includes("Working in") && !text.includes("feature-x"));
});

test("status lists the footer s values of the latest reply", async (t) => {
  // The session stayed in the channel's folder, which is no repo: no branch, no changes.
  const make = harnessFor(t);
  const stayed = { ...(sdkJson("stop-hook") as JsonObject), cwd: make.tmpPath };
  const h = make({ turns: [withStopHook(sdkMessages("tools"), stayed)] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.until(() => h.usageFetches === 1); // the turn's own refresh of the limits
  const text = await session.status();
  assert.ok(text.startsWith("Directory:") && text.includes("Claude Code: `2.1.286`"));
  const tokens = /([\d.]+[kM]?) \*tok\*/.exec(statuses(h).at(-1) ?? "");
  assert.notEqual(tokens, null);
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(lines.indexOf("Now: idle") + 1), [
    "Model: `Haiku 4.5`",
    "Effort: `medium`",
    `Session tokens: \`${tokens?.[1]}\``,
    "Context: `7%`",
    "5h limit: `5%`",
  ]);
});

test("status before any turn starts the client and leaves out the tokens", async (t) => {
  const h = harnessFor(t)({ turns: [] });
  const text = await h.session().status();
  assert.ok(h.clients.length === 1 && h.clients[0]?.queries.length === 0);
  // The version comes with a turn's `init` message, never on connect (measured 2026-09-26).
  assert.ok(text.includes(`Claude Code: \`${texts.VERSION_PENDING}\``));
  assert.ok(text.includes("Model: `Haiku 4.5`") && text.includes("Context: `7%`"));
  // Only a turn's Stop hook, or `/effort`, reports the level: the settings do not say it.
  assert.ok(!text.includes("Session tokens") && !text.includes("Effort"));
  // No session exists yet, so there is nothing the terminal could fork (#12).
  assert.ok(text.includes("Session: `new`\nMode: ") && !text.includes("Terminal:"));
});

test("status gives the command that forks the session in the terminal", async (t) => {
  // A session born in Slack stays out of the terminal's picker; a fork of it is listed (#12).
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  const stored = thread(h).sessionId;
  const lines = (await session.status()).split("\n");
  assert.equal(lines[1], `Session: \`${stored}\``);
  const folder = shellQuote(h.tmpPath);
  assert.equal(lines[2], `Terminal: \`cd ${folder} && claude --resume ${stored} --fork-session\``);
  assert.ok(lines[3]?.startsWith("Mode: "));
});

test("status escapes a terminal command that holds a backtick for a reference", async (t) => {
  // The chat marks a notice and a reference up differently: as a notice the line would read
  // `&amp;&amp;` and keep the backtick that ends a code span.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const folder = join(h.tmpPath, "my`proj");
  mkdirSync(folder);
  h.state.bind(CHANNEL, folder);
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  const line = (await session.status()).split("\n").find((l) => l.startsWith("Terminal: "));
  assert.ok(line?.includes("my\\`proj"), line);
  assert.ok(line?.includes("\\&\\& claude --resume"), line);
});

// The shell line of the Claude back end (`AgentWords.terminal`), written out.
const TERMINAL = "cd {directory} && claude --resume {session} --fork-session";

test("a terminal command holding a backtick is escaped text not a code span", () => {
  // A code span would end at the folder's backtick and the owner would copy half a command.
  // The escape is the chat's: this one marks what it was handed.
  const line = terminalLine(TERMINAL, "/work/my`proj", "0000-id", (text) => `<${text}>`);
  assert.equal(line, "Terminal: <cd '/work/my`proj' && claude --resume 0000-id --fork-session>");
});

test("status leaves the terminal command out of a folder that cannot be used", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  await (await h.session().submit("list the files")).done.wait();
  await h.restart();
  h.backend.trusted = async () => false;
  const text = await h.session().status();
  const stored = thread(h).sessionId;
  assert.ok(text.includes(`Session: \`${stored}\`\nMode: `) && !text.includes("Terminal:"));
  assert.ok(
    text.endsWith(
      texts.fill(texts.named(texts.DIRECTORY_UNTRUSTED, NAMES), { directory: h.tmpPath }),
    ),
  );
});

test("the terminal command quotes a folder the shell would split", async (t) => {
  const make = harnessFor(t);
  const spaced = join(make.tmpPath, "my project");
  mkdirSync(spaced);
  const h = make({ turns: [sdkMessages("tools")] });
  h.state.bind(CHANNEL, spaced);
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  assert.ok((await session.status()).includes(`Terminal: \`cd '${spaced}' && claude --resume `));
});

test("status says why claude code cannot start in place of the footer s values", async (t) => {
  const h = harnessFor(t)({ turns: [] });
  h.backend.trusted = async () => false;
  const text = await h.session().status();
  assert.deepEqual(h.clients, []);
  assert.ok(text.includes("Claude Code: `not started`"));
  assert.ok(
    text.endsWith(
      `Now: idle\n${texts.fill(texts.named(texts.DIRECTORY_UNTRUSTED, NAMES), { directory: h.tmpPath })}`,
    ),
  );
});

test("status during a turn shows the model and the context", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools").slice(0, -1)] });
  const session = h.session();
  await session.submit("list the files");
  await h.until(() => h.clients.length === 1 && h.clients[0]?.queries.length === 1);
  assert.deepEqual(h.clients[0]?.queries, ["list the files"]);
  const text = await session.status();
  assert.ok(text.includes(texts.fill(texts.ACTIVITY_BUSY, { queued: 0 })));
  assert.ok(text.includes("Model: `Haiku 4.5`") && text.includes("Context: `7%`"));
});

test("status shows a running task beside the list the waiting reply holds", async (t) => {
  // The reply waits for the task and shows it as the list; `!status` says it in its own words.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(
    () => runningTitle(h.slack.messageBlocks().at(-1) ?? []) === "1 shell still running",
  );
  assert.ok((await session.status()).endsWith("\nBackground: `1 shell`"));
});

test("a queued prompt is a command by Python's lstrip: U+001C is skipped, U+FEFF is not", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  const state = inside(session);
  state.notificationWaits = true;
  // A report turn that opens with words leaves a plain prompt waiting, and takes a command's.
  for (const [prompt, taken] of [
    ["\u001c/compact", true],
    ["\ufeff/compact", false],
  ] as const) {
    const turn = new Turn(prompt, null as never);
    state.sent = [turn];
    assert.equal(state.whoseTurn(true), taken ? turn : null, JSON.stringify(prompt));
  }
});

/** The recorded background run with the type its task starts under changed to `taskType`. */
function retypedBackground(taskType: string): ReturnType<typeof splitBackground> {
  return splitBackground(
    sdkMessages("background").map((item) =>
      isSystem(item, "task_started") && "record" in item
        ? { record: { ...item.record, task_type: taskType } }
        : item,
    ),
  );
}

// The type comes from the agent: a name of `Object.prototype` is no kind of ours.
for (const taskType of ["constructor", "__proto__"]) {
  test(`a task of type ${taskType} counts and ends as an unknown kind`, async (t) => {
    const [first, notice, injected] = retypedBackground(taskType);
    const h = harnessFor(t)({ turns: [first] });
    const session = h.session();
    await (await session.submit("start it")).done.wait();
    assert.ok((await session.status()).endsWith("\nBackground: `1 task`"));
    h.clients[0]?.inject([...notice, ...injected]);
    await h.until(() => h.bodies().some((body) => body.includes('Task "')));
    assert.ok(!h.bodies().some((body) => body.includes("undefined")), h.bodies().join("\n"));
  });
}

test("status refreshes the usage limits and the next one shows them", async (t) => {
  const h = harnessFor(t)({ turns: [] });
  const session = h.session();
  await session.status();
  await h.until(() => h.usageFetches === 1);
  assert.ok((await session.status()).includes("5h limit: `5%`"));
});

test("status after claude code restarts leaves out the old process s tokens", async (t) => {
  const h = harnessFor(t)(
    { turns: [withStopHook(sdkMessages("tools"), sdkJson("stop-hook") as JsonObject)] },
    {},
  );
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  let text = await session.status();
  assert.ok(text.includes("Session tokens") && text.includes("Effort: `medium`"));
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  text = await session.status();
  assert.ok(h.clients.length === 2 && text.includes("Context: `7%`"));
  assert.ok(!text.includes("Session tokens") && !text.includes("Effort"));
});

test("status says claude code s error when it fails to start", async (t) => {
  const h = harnessFor(t)({ startError: named("RuntimeError") });
  const warnings = logged(t, "warning");
  // The reason a prompt would get in the same state, never less.
  const text = await h.session().status();
  assert.ok(
    text.endsWith(
      `Now: idle\n${texts.fill(texts.named(texts.ERROR_REPLY, NAMES), { error: "RuntimeError" })}`,
    ),
  );
  assert.ok(
    warnings.some((line) => line.includes("could not read the footer's values for the status")),
  );
});

test("status follows a reply that reports no tokens", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools"), sdkMessages("usage")] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await (await session.submit("/usage")).done.wait();
  assert.ok(!statuses(h).at(-1)?.includes(" tok"));
  assert.ok(!(await session.status()).includes("Session tokens"));
});

test("a skill typed as a command shows its task while it runs", async (t) => {
  // skill-fork-command.jsonl (CLI 2.1.286): the forked skill's task starts and ends before the
  // turn's first message, and none of its calls is streamed.
  const messages = sdkMessages("skill-fork-command");
  const started = messages.findIndex((item) => isSystem(item, "task_started"));
  const h = harnessFor(t)({ turns: [messages.slice(0, started + 1)] });
  const turn = await h.session().submit("/list-files");
  await h.until(
    () =>
      h
        .cards()
        .map((card) => card.status)
        .join() === "in_progress",
  );
  assert.equal(at(h.cards(), 0).title, "/list-files");
  h.clients[0]?.inject(messages.slice(started + 1));
  await turn.done.wait();
  assert.deepEqual(
    h.cards().map((card) => [card.title, card.status]),
    [["/list-files", "complete"]],
  );
  assert.equal(h.slack.streamTs.length, 1); // one reply: the task's card is the owner's turn's
});

test("a task started by a call does not start the owner s turn", async (t) => {
  // foreground.jsonl: a long Bash call's task, whose tool_use_id names that call.
  const h = harnessFor(t)({ turns: [[startedOf("foreground")]] });
  const session = h.session();
  await session.submit("run it");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "run it");
  await h.sleep(0.05);
  assert.ok(inside(session).active === null && inside(session).held.length === 1);
  // nothing is written: no task card in a reply, and no reply
  assert.deepEqual(
    h.slack.apiCalls.filter((call) => call.method.startsWith("chat.")),
    [],
  );
});

test("a command s task waits while a report turn is expected", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.submit("/list-files");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "/list-files");
  // The prompt is sent, and a report turn is expected meanwhile (a turn that crossed it).
  inside(session).expectInjectedTurn();
  h.clients[0]?.inject([startedOf("skill-fork-command")]);
  await h.until(() => inside(session).held.length === 1);
  assert.equal(inside(session).active, null);
});

/** The recorded subagent's turn as the main stream carries it, and the records of its own calls. */
function subagentStream(): { turn: Item[]; children: Item[]; recorded: Item[] } {
  const recorded = sdkMessages("subagent");
  const turn = (splitTurns(recorded)[0] ?? []).filter((item) => !hasParent(item));
  const children = recorded.filter(hasParent);
  return { turn, children, recorded };
}

/** A task of the recorded subagent's start, as a task under it: `nested`, tied to `callId`. */
function nestedStart(callId: string): Item {
  const record = recordOf(startedOf("subagent"));
  assert.ok(record !== null);
  return { record: { ...record, task_id: "nested", tool_use_id: callId, description: "nested" } };
}

test("a task started after its call ended is an ordinary task of the agent s reply", async (t) => {
  // The `nested` frame is hand-written, with no recording behind it: a subagent asked to start
  // a subagent ran the command itself (2026-10-03, CLI 2.1.286), so no real task of type agent
  // under an agent is known. A task that starts once its call has ended is not that call's
  // foreground work: it is any background task, on the reply holding the agent.
  const { turn, children } = subagentStream();
  const childCall = children.map(toolUseOf).find((id) => id !== null);
  assert.ok(childCall !== undefined && childCall !== null);
  const nested = nestedStart(childCall);
  const h = harnessFor(t)({ turns: [turn] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const posted = h.slack.postedTs.length;
  h.clients[0]?.inject([...children, nested]);
  await h.until(() => inside(session).taskReplies.has("nested"));
  assert.ok(h.slack.postedTs.length === posted && h.slack.streamTs.length === 1); // no reply of its own
  // An agent in the background: a running task of that reply, with no card as any such agent.
  assert.ok(inside(session).runningTaskIds().includes("nested"));
  assert.ok(!h.cards().some((card) => card.title === "nested"));
});

test("a nested task that ends before its call s result is the agent s foreground work", async (t) => {
  // Hand-written like the one above (an agent under an agent is unrecorded), in the order the
  // recorded nested command has: the task's end comes before its call's result.
  const { turn, children, recorded } = subagentStream();
  const call = children.find((item) => toolUseOf(item) !== null);
  assert.ok(call !== undefined);
  const childCall = toolUseOf(call);
  assert.ok(childCall !== null);
  const nested = nestedStart(childCall);
  const notification = recordOf(recorded.find((item) => isSystem(item, "task_notification")));
  assert.ok(notification !== null);
  const ended: Item = {
    record: { ...notification, task_id: "nested", tool_use_id: childCall },
  };
  const h = harnessFor(t)({ turns: [turn] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const after = children.indexOf(call) + 1;
  h.clients[0]?.inject([...children.slice(0, after), nested, ended, ...children.slice(after)]);
  await h.sleep(0.1);
  assert.ok(!h.cards().some((card) => card.title === "nested"));
  assert.ok(!inside(session).taskReplies.has("nested") && !inside(session).tasks.has("nested"));
  assert.ok(inside(session).ended.length === 0 && inside(session).expiry === null);
});

/** A drain of the manager that has been started: whether it has returned, and how to end it. */
interface Drain {
  readonly cut: AbortController;
  readonly promise: Promise<void>;
  readonly done: () => boolean;
}

function startDrain(h: Harness): Drain {
  const cut = new AbortController();
  let finished = false;
  const promise = h.manager.drain(cut.signal).then(() => {
    finished = true;
  });
  return { cut, promise, done: () => finished };
}

/**
 * One poll of the drain has passed: what is ready runs, and the sessions' clock moves on by the
 * interval the drain sleeps between its checks. The drain has looked once more by the time this
 * returns, so a test can assert it is still waiting.
 */
async function polled(h: Harness): Promise<void> {
  await h.idle();
  await h.clock.advance(DRAIN_POLL_SECONDS);
}

/**
 * Until the drain returns, one poll at a time. The turn it waits for ends with a real
 * subprocess (the footer's `git`) and real file reads, which take as long as the machine lets
 * them: each round gives them a moment of real time, and only the real-time bound fails the
 * test, since a count of polls would give up early on a loaded machine.
 */
async function drainEnds(h: Harness, drain: Drain): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!drain.done()) {
    if (Date.now() > deadline) throw new Error("the drain never returned");
    await polled(h);
    if (!drain.done()) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  await drain.promise;
}

test("a stop lets the running turn finish and ends the queued one", async (t) => {
  const messages = sdkMessages("tools");
  const running = messages.slice(0, -1);
  const result = at(messages, -1);
  const h = harnessFor(t)({ turns: [running, sdkMessages("tools")] });
  const session = h.session();
  const first = await session.submit("first");
  const second = await session.submit("second");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  const drain = startDrain(h);
  await second.done.wait();
  assert.ok(!drain.done() && !first.done.isSet);
  h.clients[0]?.inject([result]);
  await drainEnds(h, drain);
  assert.ok(first.done.isSet);
  assert.deepEqual(h.clients[0]?.queries, ["first"]);
  // the queued message gets no reply of its own: the running one's end names it
  assert.equal(h.slack.streamTs.length, 1);
  assert.ok(
    h.slack
      .streamTexts()[0]
      ?.includes(texts.fill(texts.NOT_SENT_ONE, { because: texts.BECAUSE_RESTARTED })),
  );
  assert.equal(thread(h).sessionId, recordOf(result)?.session_id);
});

test("a stop waits for the reply s final write", async (t) => {
  const messages = sdkMessages("tools");
  const running = messages.slice(0, -1);
  const result = at(messages, -1);
  const h = harnessFor(t)({ turns: [running] });
  const turn = await h.session().submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  await h.until(() => h.slack.streamTs.length > 0);
  const client = at(h.clients, 0);
  // Slack holds the stream's stop: the reply's end is on its way.
  const stopping = new AsyncEvent();
  h.slack.gateMethod = "chat.stopStream";
  h.slack.gate = stopping;
  const drain = startDrain(h);
  client.inject([result]);
  await h.slack.gated.wait();
  await polled(h);
  assert.ok(!drain.done()); // the reply's end is still being written: it is not final yet
  h.slack.gate = null;
  stopping.set();
  await drainEnds(h, drain);
  assert.ok(turn.done.isSet);
  assert.equal(h.slack.callsTo("chat.stopStream").length, 1); // the reply has ended
  assert.deepEqual(footerWrites(h), ["chat.update"]); // and the session's footer was drawn
});

/**
 * A tools turn whose reply is open, closed by `session.close()` (a stop that does not drain)
 * either while the turn runs or once it has ended, with the footer's read held. The
 * stream's stops and the reply's last text are what the owner sees.
 */
async function closedAround(t: TestContext, ending: boolean) {
  const messages = sdkMessages("tools");
  const result = at(messages, -1);
  const h = harnessFor(t)({ turns: [messages.slice(0, -1)] });
  const session = h.session();
  const turn = await session.submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  const client = at(h.clients, 0);
  const footerRead = new AsyncEvent();
  let reading = false;
  const original = client.contextUsage.bind(client);
  client.contextUsage = async () => {
    reading = true;
    await footerRead.wait();
    return original();
  };
  await h.until(() => h.slack.streamTs.length > 0);
  if (ending) {
    client.inject([result]);
    await h.until(() => reading); // the turn has ended, and the session's footer is being read
  }
  await session.close();
  footerRead.set();
  await h.idle();
  return { h, turn };
}

test("a close while the turn runs stops the reply's stream and says awaydesk stopped", async (t) => {
  const { h, turn } = await closedAround(t, false);
  assert.equal(h.slack.callsTo("chat.stopStream").length, 1);
  assert.equal(
    h
      .replies()
      .filter((reply) => reply.includes(texts.fill(texts.ENDED, { reason: texts.ENDED_SHUTDOWN })))
      .length,
    1,
  );
  assert.deepEqual(thread(h).openReplies, []);
  assert.equal(thread(h).ended, "error");
  assert.ok(turn.done.isSet);
});

// Issue #263: the turn had ended, so its answer is whole. The reply does not say it ended before
// an answer, and the root does not get the status of a turn cut short.
test("a close while the turn's end is being written stops the reply's stream and leaves the answer as it is", async (t) => {
  const { h, turn } = await closedAround(t, true);
  assert.equal(h.slack.callsTo("chat.stopStream").length, 1);
  const ended = texts.fill(texts.ENDED, { reason: texts.ENDED_SHUTDOWN });
  assert.ok(!h.replies().some((reply) => reply.includes(ended)));
  assert.deepEqual(thread(h).openReplies, []);
  assert.equal(thread(h).ended, "done");
  assert.ok(turn.done.isSet);
});

test("a reader cancelled while the session is not closing settles the turn it was ending", async (t) => {
  // `dropClient` cancels the reader too (a reconnect): only a close hands the turn to `abandon`.
  const messages = sdkMessages("tools");
  const h = harnessFor(t)({ turns: [messages.slice(0, -1)] });
  const session = h.session();
  const turn = await session.submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  const client = at(h.clients, 0);
  const footerRead = new AsyncEvent();
  let reading = false;
  client.contextUsage = async () => {
    reading = true;
    await footerRead.wait();
    return { model: null, percentage: null };
  };
  await h.until(() => h.slack.streamTs.length > 0);
  client.inject([at(messages, -1)]);
  await h.until(() => reading);
  await inside(session).dropClient();
  assert.ok(turn.done.isSet);
  assert.equal(inside(session).active, null);
  footerRead.set();
  await h.idle();
  const ended = texts.fill(texts.ENDED, { reason: texts.ENDED_SHUTDOWN });
  assert.ok(!h.replies().some((reply) => reply.includes(ended)));
});

test("a close that cancels the sweep after a turn ended normally finds no turn to abandon", async (t) => {
  // The turn's reply stays open for a task it started (`stillOwed`), so `finish` returns with the
  // reply not closed out; the sweep in its `finally` is then cancelled by the close. The turn was
  // settled by then: it is not the active one when `close` reaches `abandon`, which would end its
  // reply as one cut short.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  const sweeping = new AsyncEvent();
  const original = inside(session).sweepClosedOut.bind(session);
  t.mock.method(inside(session), "sweepClosedOut", async (signal?: AbortSignal) => {
    if (sweeping.isSet() || signal === undefined) return original(signal);
    sweeping.set();
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  });
  let activeAtAbandon: unknown = "abandon was not called";
  const abandon = inside(session).abandon.bind(session);
  t.mock.method(inside(session), "abandon", (...args: Parameters<typeof abandon>) => {
    activeAtAbandon = inside(session).active;
    return abandon(...args);
  });
  const turn = await session.submit("start it");
  await h.until(() => sweeping.isSet());
  await session.close();
  assert.ok(turn.done.isSet);
  assert.equal(activeAtAbandon, null);
});

// Issue #263, from the review: a restart's drain dropped a queued prompt, and its error stands.
test("a close that cuts a turn's end keeps the error a dropped prompt left on the root", async (t) => {
  const messages = sdkMessages("tools");
  const h = harnessFor(t)({ turns: [messages.slice(0, -1)] });
  const session = h.session();
  const turn = await session.submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  const client = at(h.clients, 0);
  const footerRead = new AsyncEvent();
  let reading = false;
  const original = client.contextUsage.bind(client);
  client.contextUsage = async () => {
    reading = true;
    await footerRead.wait();
    return original();
  };
  await h.until(() => h.slack.streamTs.length > 0);
  // Queued, and dropped before the worker takes it, as the drain of a restart does.
  const queuing = session.submit("next");
  const dropping = session.dropQueued({ error: true });
  const second = await queuing;
  await dropping;
  client.inject([at(messages, -1)]);
  await h.until(() => reading); // the reader is inside `finish`, waiting for the footer
  await session.close();
  footerRead.set();
  await h.idle();
  assert.ok(turn.done.isSet && second.done.isSet);
  assert.ok(h.replies().some((reply) => reply.includes("was not sent")));
  assert.equal(thread(h).ended, "error");
});

test("a close after the turn's reply was closed leaves that reply as it ended", async (t) => {
  const messages = sdkMessages("tools");
  const h = harnessFor(t)({ turns: [messages.slice(0, -1)] });
  const session = h.session();
  const turn = await session.submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  await h.until(() => h.slack.streamTs.length > 0);
  const gate = armGate(h); // the reply's final write is in flight
  at(h.clients, 0).inject([at(messages, -1)]);
  await h.slack.gated.wait();
  const closing = session.close();
  await h.until(() => session.closed);
  openGate(h, gate);
  await closing;
  assert.equal(h.slack.callsTo("chat.stopStream").length, 1);
  const ended = texts.fill(texts.ENDED, { reason: texts.ENDED_SHUTDOWN });
  assert.ok(!h.replies().some((reply) => reply.includes(ended)));
  assert.ok(turn.done.isSet);
});

for (const bypass of [true, false]) {
  test(`a stop posts nothing in a thread that has nothing running [${bypass ? "True" : "False"}]`, async (t) => {
    // Bypass outlives a restart, so nothing is said about it: a message would only notify.
    const h = harnessFor(t)({});
    await h.session().setBypass(bypass);
    h.state.setSession(CHANNEL, THREAD, "sess-ran");
    await drainEnds(h, startDrain(h));
    assert.deepEqual(h.slack.callsTo("chat.postMessage"), []);
    assert.deepEqual(h.slack.callsTo("assistant.threads.setStatus"), []);
  });
}

test("an approval asked during a stop stays open and the turn finishes", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const turn = await h.session().submit("first");
  await h.until(() => pending(h.approvals).length > 0);
  const drain = startDrain(h);
  await polled(h);
  assert.ok(!drain.done() && !turn.done.isSet);
  // The owner answers while the daemon stops, as a Slack session that restarted it would need.
  resolve(h, APPROVE);
  await drainEnds(h, drain);
  assert.ok(turn.done.isSet);
  assert.deepEqual(h.clients[0]?.permissionResults[0], { allow: true });
  assert.equal(h.clients[0]?.interrupts, 0);
});

test("a turn taken before a stop is never sent", async (t) => {
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ startGate: gate, turns: [sdkMessages("tools")] });
  const turn = await h.session().submit("first");
  await h.until(() => h.clients.length > 0);
  const drain = startDrain(h);
  gate.set();
  await drainEnds(h, drain);
  assert.ok(turn.done.isSet && h.clients[0]?.queries.length === 0);
  const [note, ...more] = h.slack.callsTo("chat.postMessage"); // nothing ran: the note is a message of its own
  assert.equal(more.length, 0);
  assert.ok(
    String(note?.text).includes(
      texts.fill(texts.NOT_SENT_ONE, { because: texts.BECAUSE_RESTARTED }),
    ),
  );
});

test("a second signal cuts the stop short", async (t) => {
  const running = sdkMessages("tools").slice(0, -1);
  const h = harnessFor(t)({ turns: [running] });
  const turn = await h.session().submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  const drain = startDrain(h);
  await polled(h);
  assert.ok(!drain.done());
  drain.cut.abort();
  await drainEnds(h, drain);
  assert.ok(!turn.done.isSet); // closeAll ends it, as before
});

test("a stop waits for a background task and the turn that reports it", async (t) => {
  const [first, notice, injected] = splitBackground();
  const ended = notice.filter((item) => !isSystem(item, "task_notification"));
  const notification = notice.filter((item) => isSystem(item, "task_notification"));
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  const drain = startDrain(h);
  await polled(h);
  assert.ok(!drain.done()); // the task still runs
  // Live, the terminal task_updated came a moment before the notification (2026-09-26): the
  // task's line is closed, yet the turn that reports it has not started.
  h.clients[0]?.inject(ended);
  await polled(h);
  assert.ok(!drain.done());
  h.clients[0]?.inject(notification);
  await polled(h);
  assert.ok(!drain.done()); // Claude Code is expected to report it
  h.clients[0]?.inject(injected);
  await drainEnds(h, drain);
  assert.ok(h.replies().some(isReport));
});

test("a stop waits only a while for a notification that never comes", async (t) => {
  // A task stopped with TaskStop can end with no notification (SDK TaskUpdatedMessage docstring).
  const [first, notice] = splitBackground();
  const ended = notice.filter((item) => !isSystem(item, "task_notification"));
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  h.clients[0]?.inject(ended);
  await h.idle();
  const drain = startDrain(h);
  await polled(h);
  assert.ok(!drain.done());
  await reportTurnNeverCame(h);
  await drainEnds(h, drain);
});

test("a stop does not wait for a task its running turn starts afterwards", async (t) => {
  // A session that ran `launchctl kill TERM` then waited in the background for the new process
  // held the restart until `!stop` or the limit (issue #87, three times on 2026-09-30). The
  // signal names no sender; the one that ordered it has a turn running when it arrives.
  const [first] = splitBackground();
  const [before, after] = splitAtTaskStart(first);
  const h = harnessFor(t)({ turns: [before] });
  const session = h.session();
  const turn = await session.submit("restart the daemon");
  await h.until(
    () => h.clients.length > 0 && h.clients[0]?.queries.join() === "restart the daemon",
  );
  const drain = startDrain(h);
  await polled(h);
  assert.ok(!drain.done()); // its turn still runs
  h.clients[0]?.inject(after);
  await drainEnds(h, drain);
  assert.ok(turn.done.isSet);
  assert.ok(inside(session).runningTaskIds().length > 0); // still running: the shutdown ends it
  await h.sleep(0.05);
  assert.ok(!statusLines(h).some((line) => line.startsWith("Restart waits")));
  await h.manager.closeAll(); // the shutdown that follows
  const stored = thread(h);
  assert.ok(stored.openReplies.length === 0 && stored.status === null);
  // Its turn ended well: the task the shutdown ends is its own wait, not work cut short (decided
  // 2026-10-01: ✅, as `!stop` showed before this change).
  assert.equal(h.reactions().at(-1), Status.DONE);
  assert.ok(!h.reactions().includes(Status.ERROR));
});

test("a stop still waits for a task the running turn started before it", async (t) => {
  const [first] = splitBackground();
  const running = first.slice(0, -1);
  const result = at(first, -1);
  const h = harnessFor(t)({ turns: [running] });
  const turn = await h.session().submit("start it");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "start it");
  await h.until(() => inside(h.session()).runningTaskIds().length > 0);
  const drain = startDrain(h);
  h.clients[0]?.inject([result]);
  await turn.done.wait();
  await polled(h);
  assert.ok(!drain.done()); // the task began before the signal: it is waited for
  // Said by the thread's status line, never by a message: no push, and nothing left behind.
  const waits = texts.fill(texts.RESTART_WAITS, { counts: "1 shell", them: "it" });
  await h.until(() => statusLines(h).at(-1) === waits);
  assert.equal(waits, "Restart waits for 1 shell · !stop ends it now");
  assert.deepEqual(h.slack.callsTo("chat.postMessage"), []);
  drain.cut.abort();
  await drain.promise;
});

test("a stop held by a background task says so and bang stop ends it", async (t) => {
  // A task that never ends (a watcher) held a restart for the whole limit (2026-09-27).
  const [first, notice] = splitBackground();
  const taskId = String(systemRecord(first, "task_started").task_id);
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const drain = startDrain(h);
  await polled(h);
  assert.ok(!drain.done());
  // Said by the thread's status line, never by a message: no push, and nothing left behind.
  const waits = texts.fill(texts.RESTART_WAITS, { counts: "1 shell", them: "it" });
  await h.until(() => statusLines(h).at(-1) === waits);
  assert.equal(waits, "Restart waits for 1 shell · !stop ends it now");
  assert.deepEqual(h.slack.callsTo("chat.postMessage"), []);
  assert.ok(await session.stop());
  assert.deepEqual(h.clients[0]?.stoppedTasks, [taskId]);
  assert.equal(h.clients[0]?.interrupts, 0); // no turn was running
  // No report turn follows a stopped task, so the stop does not wait INJECTED_TURN_WAIT for one.
  h.clients[0]?.inject(stoppedEnd(notice));
  await drainEnds(h, drain);
});

test("a stop whose interrupt is refused still stops the background tasks", async (t) => {
  // The SDK rejects a control request on a query it has cleaned up ("Query closed before
  // response received", read in sdk.mjs 0.3.296) and one the CLI refuses with its own error.
  const [first] = splitBackground();
  const taskId = String(systemRecord(first, "task_started").task_id);
  const warnings = logged(t, "warning");
  const h = harnessFor(t)({
    turns: [first, [canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("tools")]],
  });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await session.submit("clean"); // a turn that waits on an approval, with the command running
  await h.until(() => pending(h.approvals).length > 0);
  const client = h.clients[0];
  assert.ok(client !== undefined);
  client.interrupt = async () => {
    throw new TypeError("Query closed before response received");
  };
  assert.equal(await session.stop(), true);
  assert.deepEqual(client.stoppedTasks, [taskId]);
  const refused = warnings.filter((line) => line.includes("could not interrupt"));
  assert.equal(refused.length, 1, warnings.join("\n"));
  const line = String(refused[0]);
  assert.ok(line.includes(`${CHANNEL}/${THREAD}`) && line.includes("TypeError"));
  assert.ok(!line.includes("Query closed")); // the error's name, never its text
});

test("a stop of a background task ends the reply like any other end", async (t) => {
  // `!stop` (S2): the task's own end lets the reply's stream stop, as a normal end does, and the
  // stop has ended the session: the footer follows by an edit. Nothing is posted, and the ✅ is
  // the stop's own.
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  assert.ok(await session.stop());
  await h.sleep(0.05);
  assert.deepEqual(h.slack.callsTo("chat.stopStream"), []); // the task has not ended yet
  h.clients[0]?.inject(stoppedEnd(notice));
  await h.until(() => h.slack.callsTo("chat.stopStream").length > 0);
  await h.until(() => session.idle);
  await h.sleep(3);
  assert.deepEqual(footers(h), [true]);
  assert.ok(h.slack.postedTs.length === 0 && h.slack.pushes() === 1);
  assert.equal(h.reactions().at(-1), Status.DONE);
});

test("a stopped report turn ends like any other end", async (t) => {
  // A report turn `!stop` cuts short ends like a stopped owner turn does: its reply, at rest
  // since the first turn ended, ends with the footer under its ending, once.
  const [first, notice, injected] = splitBackground();
  const partial = injected.filter((item) => !isResult(item));
  const result = recordOf(injected.find(isResult));
  assert.ok(result !== null);
  const interrupted: Item = { record: { ...result, terminal_reason: "aborted_streaming" } };
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice);
  await h.until(() => inside(session).injectedExpected);
  h.clients[0]?.inject(partial);
  await h.until(() => inside(session).active !== null);
  assert.equal(await session.stop(), true);
  h.clients[0]?.inject([interrupted]);
  await h.until(() => h.slack.postedTs.length > 0);
  // The stream stopped when the first turn ended; the report turn's end posts its ending.
  assert.ok(h.slack.postedTs.length === 1 && h.slack.pushes() === 2);
  assert.ok(noStreamOpen(h));
});

test("the next prompt after bang stop does not wait for a report", async (t) => {
  // Measured 2026-09-27 on Claude Code 2.1.283: the stopped task's notification stays queued
  // and no turn reports it; the owner's next prompt waited INJECTED_TURN_WAIT (30 s).
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  assert.ok(await session.stop());
  h.clients[0]?.inject(stoppedEnd(notice));
  await h.until(() => session.runningKinds === "");
  const following = await session.submit("next");
  await following.done.wait(); // no advance of the sessions' clock: it waits for nothing
  assert.deepEqual(h.clients[0]?.queries, ["start it", "next"]);
});

/**
 * Every line the daemon logs from here on, parsed, over the whole `awaydesk` logger tree, where
 * `logged` reads one logger. Call `stop` when the part under test is over.
 */
function captureLog(): {
  readonly entries: Array<{ level: string; name: string; message: string }>;
  stop(): void;
} {
  const entries: Array<{ level: string; name: string; message: string }> = [];
  const before = setWriter((line) => {
    const parsed = /^\S+ \S+ ([A-Z]+) ([^:]+): (.*)$/s.exec(line);
    if (parsed !== null) {
      entries.push({
        level: String(parsed[1]),
        name: String(parsed[2]),
        message: String(parsed[3]),
      });
    }
  });
  return { entries, stop: () => void setWriter(before) };
}

/** What a call that is still running will end with: its error, or null. Never rejects. */
function outcome(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => null,
    (error: unknown) => error,
  );
}

/** Whether a call has returned yet, kept by a flag since a promise cannot be asked. */
function finishing(call: Promise<unknown>): { readonly done: () => boolean } {
  let finished = false;
  void call.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  return { done: () => finished };
}

test("a close while a word starts the client leaves no process", async (t) => {
  // `!help` or `!status` starts the client in its own task, outside the prompt queue; the
  // trigger for a concurrent close is now closeAll at shutdown (and, later, an idle close).
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ startGate: gate });
  const session = h.session();
  const word = session.ensureConnected();
  const wordEnd = outcome(word);
  await h.until(() => h.clients.length === 1);
  const closing = session.close();
  const closed = finishing(closing);
  await h.sleep(0.05);
  assert.ok(!closed.done()); // the close waits for the connect in progress
  gate.set();
  await closing;
  await wordEnd;
  assert.ok(h.clients.length === 1 && h.clients[0]?.connected === false);
});

test("a close waits for the start the worker gave up, and disconnects it", async (t) => {
  // `close()` cancels the worker, whose own signal ends its wait for the start while the agent's
  // process is still launching: the close must not end, nor `doneClosing` fire (which lets a
  // later session resume the same id), before that process is closed (issue #240).
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ startGate: gate });
  const session = h.session();
  await session.submit("first");
  await h.until(() => h.clients.length === 1);
  const closing = session.close();
  const closed = finishing(closing);
  try {
    await h.sleep(0.05);
    assert.ok(!closed.done()); // the start is still launching
    assert.ok(!session.doneClosing.isSet);
    // the chat is settled meanwhile: the wait is the close's last step
    await h.until(() => h.reactions().at(-1) === Status.ERROR, 1.0);
  } finally {
    gate.set(); // a failed check must not leave the close waiting for good
  }
  await closing;
  assert.ok(h.clients[0]?.connected === false); // closed before the close ended
  assert.ok(session.doneClosing.isSet);
});

test("bypass asked while the session closes is not stored", async (t) => {
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ startGate: gate });
  const session = h.session();
  const wordEnd = outcome(session.setBypass(true));
  await h.until(() => h.clients.length === 1);
  const closing = session.close();
  await h.sleep(0.05);
  gate.set();
  await closing;
  assert.ok((await wordEnd) instanceof SessionClosed);
  assert.equal(thread(h).bypass, null); // never stored
});

test("the status of a session closed meanwhile is not given", async (t) => {
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ startGate: gate });
  const session = h.session();
  const wordEnd = outcome(session.status());
  await h.until(() => h.clients.length === 1);
  const closing = session.close();
  await h.sleep(0.05);
  gate.set();
  await closing;
  assert.ok((await wordEnd) instanceof SessionClosed); // connected before the close, read after it
  await assert.rejects(session.status(), SessionClosed);
});

test("a closed session starts no client", async (t) => {
  const h = harnessFor(t)();
  const session = h.session();
  await session.close();
  await assert.rejects(session.ensureConnected(), SessionClosed);
  assert.deepEqual(h.clients, []);
});

test("bypass whose client closes under it says the session closed", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  const client = await session.ensureConnected();
  (client as FakeAgentSession).setPermissionMode = async () => {
    await session.close();
    throw named("ConnectionError"); // the CLI went away
  };
  await assert.rejects(session.setBypass(true), SessionClosed);
  assert.equal(thread(h).bypass, null); // never stored
});

// The effort level `/effort` sets is stored per thread and passed back on the next connect;
// a Claude Code process with nothing to do for an hour closes itself, and the next message
// rebuilds it.

test("a result reporting an effort change stores it", async (t) => {
  const effortTurn = withResult(
    sdkMessages("usage"),
    "Set effort level to high (this session only): Comprehensive",
  );
  const h = harnessFor(t)({ turns: [effortTurn] });
  await (await h.session().submit("/effort high")).done.wait();
  assert.equal(thread(h).effort, "high");
});

test("a reply that reads like an effort change stores nothing", async (t) => {
  // The final text of an ordinary turn is the model's, and what the agent read can shape it:
  // only the output of a command that sets the level is read for it.
  const reply = withResult(
    sdkMessages("tools"),
    "Set effort level to low (this session only): Quick",
  );
  const h = harnessFor(t)({ turns: [reply] });
  const session = h.session(); // opens the thread
  h.state.setEffort(CHANNEL, THREAD, "high"); // the level the owner chose
  await (await session.submit("summarise the page")).done.wait();
  assert.equal(thread(h).effort, "high");
  assert.ok(!statuses(h).at(-1)?.includes("*effort* low"));
});

test("setting effort back to auto stores the default", async (t) => {
  const effortTurn = withResult(
    sdkMessages("usage"),
    "Effort level set to auto (this session only)",
  );
  const h = harnessFor(t)({ turns: [effortTurn] });
  const session = h.session(); // opens the thread
  h.state.setEffort(CHANNEL, THREAD, "high"); // a level was stored from an earlier turn
  await (await session.submit("/effort auto")).done.wait();
  assert.equal(thread(h).effort, null);
});

test("the footer shows a stored effort at once after a reconnect", async (t) => {
  // A stored `!effort` is sent to Claude Code on every reconnect; the footer must not show
  // "unknown" for the level the daemon itself just asked for, before any turn reports another.
  const h = harnessFor(t)({});
  h.session();
  h.state.setEffort(CHANNEL, THREAD, "low");
  assert.ok((await h.session().status()).includes("Effort: `low`"));
});

/**
 * The idle delay passes over a session that has nothing to do: it is idle first (a turn's last
 * write has landed), and its timer, which starts on the next turn of the event loop, is
 * running before the sessions' clock moves on.
 */
async function idleDelayPasses(h: Harness, session: ThreadSession, fraction = 1): Promise<void> {
  await h.until(() => session.idle);
  await h.idle();
  await h.clock.advance(IDLE_CLOSE_SECONDS * fraction);
}

test("an idle session closes itself after the delay and posts nothing", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  // `done` is set before the thread status's last write (the end now runs in its own task):
  // let it land, so only the close itself is counted.
  await h.sleep(0.02);
  const callsBefore = h.slack.apiCalls.length; // every kind: postMessage, update, delete
  await idleDelayPasses(h, session);
  await h.until(() => h.clients[0]?.connected === false, 1);
  assert.ok(session.closed);
  assert.equal(h.slack.apiCalls.length, callsBefore); // a silent close
});

test("release closes an idle session silently and refuses one in use", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  assert.ok(await h.manager.release(CHANNEL, THREAD)); // no live session: the thread is free
  h.manager.free(CHANNEL, THREAD);
  const session = h.session();
  const turn = await session.submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  assert.ok(!(await h.manager.release(CHANNEL, THREAD))); // waiting on the owner
  assert.ok(!session.closed && h.clients[0]?.connected === true);
  assert.ok(!h.manager.held(CHANNEL, THREAD)); // refused: nothing is held
  resolve(h, APPROVE);
  await turn.done.wait();
  await h.until(() => session.idle);
  await h.sleep(0.02); // the thread status's last write lands
  const callsBefore = h.slack.apiCalls.length;
  assert.ok(await h.manager.release(CHANNEL, THREAD));
  assert.ok(session.closed && session.doneClosing.isSet);
  assert.ok(!h.clients[0]?.connected);
  assert.equal(h.slack.apiCalls.length, callsBefore); // as silent as the idle close
  // Released, the thread is held: no session is rebuilt from the entry `state.json` still
  // has, so a message sent while its messages are deleted starts nothing.
  assert.ok(h.manager.held(CHANNEL, THREAD));
  assert.notEqual(h.state.thread(CHANNEL, THREAD), null);
  assert.equal(h.manager.get(CHANNEL, THREAD), null);
  assert.equal(h.clients.length, 1);
  h.manager.free(CHANNEL, THREAD);
  assert.ok(!h.manager.held(CHANNEL, THREAD));
  assert.notEqual(h.manager.get(CHANNEL, THREAD), null); // a delete that failed: usable again
});

test("the idle close does not fire while a turn runs", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const session = h.session();
  const turn = await session.submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  await h.idle(); // the timer starts on the next turn of the loop
  await h.clock.advance(IDLE_CLOSE_SECONDS); // past the idle delay, still waiting on the owner's decision
  assert.ok(!session.closed && h.clients[0]?.connected === true);
  resolve(h, APPROVE);
  await turn.done.wait();
  await idleDelayPasses(h, session); // idle again: the timer restarted
  await h.until(() => session.closed, 1);
});

test("the idle close waits for a background task", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  assert.ok(session.runningKinds !== ""); // the task outlived its turn
  await h.idle(); // the timer starts on the next turn of the loop
  await h.clock.advance(IDLE_CLOSE_SECONDS); // past the idle delay, the task is still running
  assert.ok(!session.closed && h.clients[0]?.connected === true);
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => session.runningKinds === "");
  await idleDelayPasses(h, session); // idle again once the task ends
  await h.until(() => session.closed, 1);
});

test("the idle close waits for an expected report turn", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice); // a report turn is expected; not idle until it arrives
  await h.idle();
  // The idle delay is the longer one, so what is checked is that no idle timer runs during the
  // report's wait.
  assert.equal(inside(session).idleExpiry, null);
  await h.clock.advance(INJECTED_TURN_WAIT - 1);
  assert.ok(!session.closed && h.clients[0]?.connected === true);
  h.clients[0]?.inject(injected);
  await h.until(() => isReport(h.bodies()[0] ?? ""));
  await idleDelayPasses(h, session);
  await h.until(() => session.closed, 1);
});

test("a message after a close gets a rebuilt session never the closed one", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  h.state.setSession(CHANNEL, THREAD, "prior");
  h.state.setEffort(CHANNEL, THREAD, "high");
  await session.close();
  assert.ok(session.closed);
  const rebuilt = h.manager.get(CHANNEL, THREAD);
  assert.ok(rebuilt !== null && rebuilt !== session);
  const turn = await rebuilt.submit("next");
  await turn.done.wait();
  assert.equal(h.clients.at(-1)?.options.resume, "prior");
  assert.equal(h.clients.at(-1)?.options.effort, "high");
});

test("the next message after an idle close resumes with effort", async (t) => {
  const effortTurn = withResult(
    sdkMessages("usage"),
    "Set effort level to high (this session only): Comprehensive",
  );
  const h = harnessFor(t)({ turns: [effortTurn] }, { turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("/effort high")).done.wait();
  await idleDelayPasses(h, session);
  await h.until(() => session.closed, 1);
  const stored = thread(h);
  const rebuilt = h.manager.get(CHANNEL, THREAD);
  assert.ok(rebuilt !== null && rebuilt !== session);
  await (await rebuilt.submit("next")).done.wait();
  assert.equal(h.clients[1]?.options.resume, stored.sessionId);
  assert.equal(h.clients[1]?.options.effort, "high");
});

test("sessions of leaves out a closed session", async (t) => {
  // Closing has started but its disconnect has not ended, so the manager has not evicted it yet.
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ closeGate: gate });
  const session = h.session();
  await session.ensureConnected();
  assert.deepEqual(h.manager.sessionsOf(CHANNEL), [session]);
  const closing = session.close();
  try {
    await h.sleep(0.05);
    assert.ok(session.closed);
    assert.equal(h.clients[0]?.connected, true); // blocked inside the gated disconnect
    assert.deepEqual(h.manager.sessionsOf(CHANNEL), []);
  } finally {
    gate.set(); // a failed assertion must not leave the close hanging
    await closing;
  }
});

test("a gone session is left out of sessions of", async (t) => {
  // The case Task 2 left open: a resume that finds its session gone stays a closed entry
  // in the manager until something looks it up again; sessionsOf must not show it meanwhile.
  const h = harnessFor(t)({ startError: gone() });
  const session = h.session();
  h.state.setSession(CHANNEL, THREAD, "gone");
  const turn = await session.submit("hello");
  await turn.done.wait();
  assert.ok(session.closed);
  assert.deepEqual(h.manager.sessionsOf(CHANNEL), []);
});

// Idle close races: the resume race, the routing race, the re-arm points after a word's connect
// and an expired report wait, the effort edge cases and the eviction of a closed session.

test("ensure connected waits for the predecessor s disconnect before resuming", async (t) => {
  // The CLI needs real time to flush and exit after EOF: a rebuild must never resume the same
  // session id while that is still in flight.
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ closeGate: gate }, { turns: [sdkMessages("tools")] });
  const session = h.session();
  await session.ensureConnected();
  h.state.setSession(CHANNEL, THREAD, "prior");
  const closing = session.close();
  const closingEnd = finishing(closing);
  await h.sleep(0.05); // close() is now blocked inside the gated disconnect
  assert.ok(!closingEnd.done());
  assert.ok(session.closed); // closing has started...
  assert.equal(h.clients[0]?.connected, true); // ...but has not finished
  const rebuilt = h.manager.get(CHANNEL, THREAD);
  assert.ok(rebuilt !== null && rebuilt !== session);
  const connecting = rebuilt.ensureConnected();
  const connectingEnd = finishing(connecting);
  await h.sleep(0.05);
  assert.ok(!connectingEnd.done()); // waiting on the predecessor: no second client started yet
  assert.equal(h.clients.length, 1);
  gate.set();
  await closing;
  await connecting;
  assert.equal(h.clients.length, 2);
  assert.equal(h.clients[1]?.options.resume, "prior");
});

test("close all waits for an idle close already in flight", async (t) => {
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ closeGate: gate });
  const session = h.session();
  await session.ensureConnected();
  await idleDelayPasses(h, session);
  await h.until(() => session.closed, 1); // the idle close fired and is now in flight
  assert.equal(h.clients[0]?.connected, true); // blocked inside the gated disconnect
  const closingAll = h.manager.closeAll();
  const closingAllEnd = finishing(closingAll);
  await h.sleep(0.05);
  assert.ok(!closingAllEnd.done()); // waits for the in-flight close rather than returning early
  gate.set();
  await closingAll;
  assert.equal(h.clients[0]?.connected, false);
});

test("close all continues past a session whose close raises", async (t) => {
  const h = harnessFor(t)({}, {});
  const first = h.session(THREAD);
  const second = h.session(OTHER_THREAD);
  await first.ensureConnected();
  await second.ensureConnected();
  // A real `close()` always sets `doneClosing` from its own `finally`, whatever fails.
  (first as { close: ThreadSession["close"] }).close = async () => {
    first.doneClosing.set();
    throw new Error("boom");
  };
  await h.manager.closeAll();
  assert.equal(h.clients[1]?.connected, false); // the second session still closed
  assert.deepEqual(h.manager.sessionsOf(CHANNEL), []);
});

test("a lookup touches the idle timer before any await", async (t) => {
  // The timer armed when the turn ended is close to firing; a lookup (a message arriving) must
  // reset it to a fresh IDLE_CLOSE_SECONDS, synchronously, before any slow step (a download, a
  // Slack call) a caller might do on the way to its own submit.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  await idleDelayPasses(h, session, 0.7); // close to the stale timer's own delay, not yet closed
  const lookedUp = h.manager.get(CHANNEL, THREAD);
  assert.equal(lookedUp, session);
  await h.idle(); // the timer starts on the next turn of the loop
  await h.clock.advance(IDLE_CLOSE_SECONDS * 0.7); // past where the STALE timer would have fired
  assert.ok(!session.closed); // the touch gave it a fresh window instead
});

test("a lookup of an idle session still closes it eventually", async (t) => {
  // The touch above resets the clock; it does not disarm it. A lookup with no submit ever
  // following stays a session with nothing to do, and closes on its own new schedule.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  assert.equal(h.manager.get(CHANNEL, THREAD), session);
  await idleDelayPasses(h, session);
  await h.until(() => session.closed, 1);
});

test("submit on a closed session raises session closed", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.close();
  await assert.rejects(session.submit("hi"), SessionClosed);
});

test("ensure connected arms the idle close too", async (t) => {
  // A daemon word (`!status`, `!help`, `!bypass`) connects with no turn ever submitted.
  const h = harnessFor(t)({});
  const session = h.session();
  await session.ensureConnected();
  await idleDelayPasses(h, session);
  await h.until(() => session.closed, 1);
});

test("the idle close arms again when no report turn ever comes", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice); // a report turn is expected, but never sent in this test
  await reportTurnNeverCame(h); // INJECTED_TURN_WAIT elapses, then the timer
  await idleDelayPasses(h, session);
  await h.until(() => session.closed, 1);
});

test("a model change with no effort does not clear the stored level", async (t) => {
  const modelTurn = withResult(
    sdkMessages("usage"),
    "Set model to `Sonnet 5` for this session only",
  );
  const h = harnessFor(t)({ turns: [modelTurn] });
  const session = h.session(); // opens the thread
  h.state.setEffort(CHANNEL, THREAD, "high"); // stored from an earlier turn
  await (await session.submit("/model sonnet")).done.wait();
  assert.equal(thread(h).effort, "high"); // unknown, not cleared
});

test("an unrecognized stored effort is dropped not sent", async (t) => {
  const h = harnessFor(t)({});
  h.session(); // opens the thread
  h.state.setEffort(CHANNEL, THREAD, "ultra"); // not one of the SDK's EffortLevel values
  await h.session().ensureConnected();
  assert.equal(h.clients[0]?.options.effort, null);
});

test("an idle closed session is evicted even with no further lookup", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  await idleDelayPasses(h, session);
  await h.until(() => h.clients[0]?.connected === false, 1);
  const live = (h.manager as unknown as { sessions: Map<string, ThreadSession> }).sessions;
  await h.until(() => !live.has(`${CHANNEL}\n${THREAD}`), 1);
});

test("the idle close does not fire while a plain turn runs", async (t) => {
  // No approval at all this time: just a turn that has not finished yet.
  const h = harnessFor(t)({ turns: [[]] }); // a turn with no result: stays "sent" forever
  const session = h.session();
  const turn = await session.submit("still working");
  await h.idle();
  await h.clock.advance(IDLE_CLOSE_SECONDS);
  assert.ok(!session.closed);
  assert.ok(!turn.done.isSet);
});

test("drain suppresses the idle close", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  session.draining = true;
  await idleDelayPasses(h, session);
  assert.ok(!session.closed);
});

// Close ordering: close() must signal doneClosing even when a step inside it raises, the
// predecessor chain must hold past an unconnected middle generation, submit's own awaits must
// not be closeable under it, and a few more missed re-arm points.

test("close sets done closing even if a step inside it raises", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.ensureConnected();
  (session as unknown as { stopTaskReplies: () => Promise<void> }).stopTaskReplies = async () => {
    throw new Error("boom");
  };
  await assert.rejects(session.close(), /boom/);
  assert.ok(session.doneClosing.isSet);
  assert.deepEqual(h.manager.sessionsOf(CHANNEL), []); // onClosed still ran too
});

test("close all waits for a predecessor evicted before it but still disconnecting", async (t) => {
  // A (idle-closing, gated) is evicted by a lookup that builds B; B never connects. closeAll
  // only ever sees B in its map, yet must still wait for A's own disconnect to finish.
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ closeGate: gate });
  const sessionA = h.session();
  await sessionA.ensureConnected();
  const closingA = sessionA.close();
  await h.sleep(0.05); // A is now blocked inside the gated disconnect
  assert.ok(sessionA.closed && h.clients[0]?.connected === true);
  const sessionB = h.manager.get(CHANNEL, THREAD);
  assert.ok(sessionB !== null && sessionB !== sessionA);
  const closingAll = h.manager.closeAll();
  const closingAllEnd = finishing(closingAll);
  await h.sleep(0.05);
  assert.ok(!closingAllEnd.done()); // chained through B, waiting on A's still-gated disconnect
  gate.set();
  await closingA;
  await closingAll;
  assert.equal(h.clients[0]?.connected, false);
});

test("a third generation session waits through an unconnected middle one", async (t) => {
  // A disconnecting (gated); B is built as its replacement but closes before ever connecting
  // (so it never itself waited on A); C must still wait for A, through B's own close().
  const gate = new AsyncEvent();
  const h = harnessFor(t)({ closeGate: gate }, { turns: [sdkMessages("tools")] });
  const sessionA = h.session();
  await sessionA.ensureConnected();
  h.state.setSession(CHANNEL, THREAD, "prior");
  const closingA = sessionA.close();
  await h.sleep(0.05); // A is now blocked inside the gated disconnect
  assert.ok(sessionA.closed && h.clients[0]?.connected === true);
  const sessionB = h.manager.get(CHANNEL, THREAD);
  assert.ok(sessionB !== null && sessionB !== sessionA);
  const closingB = sessionB.close();
  const closingBEnd = finishing(closingB);
  await h.sleep(0.05);
  assert.ok(!closingBEnd.done()); // B's own close is chained behind A's still-open disconnect
  const sessionC = h.manager.get(CHANNEL, THREAD);
  assert.ok(sessionC !== null && sessionC !== sessionA && sessionC !== sessionB);
  const connectingC = sessionC.ensureConnected();
  const connectingCEnd = finishing(connectingC);
  await h.sleep(0.05);
  assert.ok(!connectingCEnd.done()); // must not resume the same id while A is still exiting
  assert.equal(h.clients.length, 1);
  gate.set();
  await closingA;
  await closingB;
  await connectingC;
  assert.equal(h.clients.length, 2);
  assert.equal(h.clients[1]?.options.resume, "prior");
});

test("the idle close cannot fire during submit s own awaits", async (t) => {
  // Making the reply waits for nothing, so the test holds `sink` as the tests above do.
  // Without the fix, the timer armed at submit's own entry would reset instead of staying
  // cancelled, and fire while `submit` is still awaiting the reply.
  const h = harnessFor(t)({ turns: [sdkMessages("tools"), sdkMessages("tools")] });
  const open = new AsyncEvent();
  open.set();
  const held = new AsyncEvent();
  const sinks = gatedSinks(t, [open, held]);
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  await h.idle();
  const again = session.submit("again");
  await h.until(() => sinks.entered === 2);
  await h.idle(); // the timer starts on the next turn of the loop
  await h.clock.advance(IDLE_CLOSE_SECONDS); // longer than the idle delay, inside the submit
  assert.ok(!session.closed);
  held.set();
  const turn = await again;
  await turn.done.wait();
  assert.deepEqual(h.clients[0]?.queries, ["hi", "again"]);
});

test("the crash tail re arms the idle close", async (t) => {
  const h = harnessFor(t)({ turns: [[...sdkMessages("tools").slice(0, 3), END_OF_STREAM]] });
  const session = h.session();
  await (await session.submit("first")).done.wait();
  await h.until(() => inside(session).client === null, 1); // the reader's crash tail ran
  await h.idle(); // the timer starts on the next turn of the loop
  await h.clock.advance(IDLE_CLOSE_SECONDS);
  await h.until(() => session.closed, 1); // ...and re-armed the timer there
});

test("a failed query re arms the idle close", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.ensureConnected();
  at(h.clients, 0).send = async () => {
    throw new Error("boom");
  };
  const turn = await session.submit("hi");
  await turn.done.wait();
  await h.idle(); // the timer starts on the next turn of the loop
  await h.clock.advance(IDLE_CLOSE_SECONDS);
  await h.until(() => session.closed, 1);
});

// The status reaction: one on each session's root message, driven by `ThreadSession`
// itself. `Harness.reactions` reads it from `FakeSlack.apiCalls`, never a session's own internals.

/** The reactions that stand on the root message after every add and remove, in call order. */
function onRoot(h: Harness): Set<string> {
  const shown = new Set<string>();
  for (const { method, args } of h.slack.apiCalls) {
    if (method === "reactions.add") shown.add(String(args.name));
    else if (method === "reactions.remove") shown.delete(String(args.name));
  }
  return shown;
}

test("a plain turn shows working then done", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  // `turn.done` is set (`settle`) before the sweep that checks whether the session is now
  // idle enough for ✅ (both run in `finish`'s own `finally`, in that order).
  await h.until(() => h.reactions().join() === [Status.WORKING, Status.DONE].join());
});

test("a turn with an approval shows waiting then working again", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harnessFor(t)({ turns: [[ask, ...sdkMessages("tools")]] });
  const turn = await h.session().submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  assert.deepEqual(h.reactions(), [Status.WORKING, Status.WAITING]);
  resolve(h, APPROVE);
  await turn.done.wait();
  const expected = [Status.WORKING, Status.WAITING, Status.WORKING, Status.DONE];
  await h.until(() => h.reactions().join() === expected.join());
});

test("a background task outliving the turn stays working until its report closes", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  // The turn itself ended, but the task it started still runs: no ✅ yet.
  assert.deepEqual(h.reactions(), [Status.WORKING]);
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => isReport(h.bodies()[0] ?? ""));
  await h.sleep(0.05);
  assert.deepEqual(h.reactions(), [Status.WORKING, Status.DONE]);
});

test("a failed turn shows error", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.ensureConnected();
  at(h.clients, 0).send = async () => {
    throw new Error("boom");
  };
  const turn = await session.submit("hi");
  await turn.done.wait();
  assert.deepEqual(h.reactions(), [Status.WORKING, Status.ERROR]);
});

test("quick turn after stop ends on working", async (t) => {
  // `StatusReaction.current` only updates once its own `reactions.add` returns.
  // A quick turn right after a stop can end (and try to react working, then done) before
  // that slow round trip lands, so gating on `current` alone missed the standing ❌ and let
  // an already-in-flight ⏳ add stick with nothing left to ever remove it.
  const h = harnessFor(t)({
    turns: [
      [canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("interrupt")],
      sdkMessages("tools"),
    ],
  });
  const session = h.session();
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  assert.equal(await session.stop(), true);
  await turn.done.wait();
  await h.until(() => h.reactions().at(-1) === Status.DONE);
  // A Slack round trip slower than the turn itself: every add waits at the gate.
  h.slack.gateMethod = "reactions.add";
  const gate = armGate(h);
  const quick = await session.submit("quick");
  await quick.done.wait();
  await h.sleep(0.8);
  openGate(h, gate);
  await h.sleep(0.8);
  assert.deepEqual(onRoot(h), new Set([Status.DONE]));
});

test("a gone session shows error", async (t) => {
  const h = harnessFor(t)({ startError: gone() });
  h.session(); // opens the thread
  h.state.setSession(CHANNEL, THREAD, "gone");
  const turn = await h.session().submit("hello");
  await turn.done.wait();
  assert.equal(h.reactions().at(-1), Status.ERROR);
});

test("a drain that cuts a busy session shows error", async (t) => {
  const running = sdkMessages("tools").slice(0, -1);
  const h = harnessFor(t)({ turns: [running] });
  const turn = await h.session().submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  const drain = startDrain(h);
  await polled(h);
  drain.cut.abort();
  await drainEnds(h, drain);
  assert.ok(!turn.done.isSet); // not settled by the drain itself
  await h.manager.closeAll(); // the shutdown that follows a cut-short drain
  assert.equal(h.reactions().at(-1), Status.ERROR);
});

test("work drain path leaves hourglass", async (t) => {
  // `work`'s own draining branch dropped a taken turn's prompt with a `fail` that
  // reacted to nothing at all: the ⏳ (or ✅, once the session read idle) a submit had already
  // shown stood as if that turn had gone through, though it never did.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("first")).done.wait();
  inside(session).settled.clear(); // a report turn still in flight: the worker waits on it
  const second = await session.submit("second");
  await h.until(() => inside(session).taken !== null);
  session.draining = true;
  inside(session).settled.set();
  await second.done.wait();
  await session.close();
  await session.doneClosing.wait();
  assert.deepEqual(onRoot(h), new Set([Status.ERROR]));
});

test("close leaves no list when an owner message sits below the reply that held it", async (t) => {
  // `!status` under the reply that holds the list: the owner's message seals the holder, and
  // taking the list off it must still be written before the process ends.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("next")).done.wait();
  await h.until(
    () => runningTitle(h.slack.messageBlocks().at(-1) ?? []) === "1 shell still running",
  );
  await session.status();
  await session.close();
  await session.doneClosing.wait();
  assert.ok(h.slack.messageBlocks().every((blocks) => runningTitle(blocks) === null));
});

test("close leaves no list on the reply that held it", async (t) => {
  // A shutdown's own event loop iteration ends right after `close()` returns, so a change that
  // only debounced never gets to run: the close settles the replies the session tracks, and the
  // list that the close empties must have left the reply it was drawn on.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first, sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("next")).done.wait();
  await h.until(
    () => runningTitle(h.slack.messageBlocks().at(-1) ?? []) === "1 shell still running",
  );
  await session.close();
  await session.doneClosing.wait();
  assert.ok(h.slack.messageBlocks().every((blocks) => runningTitle(blocks) === null));
});
test("a top level status word gets no reaction", async (t) => {
  const h = harnessFor(t)({});
  await h.session().status();
  assert.deepEqual(h.reactions(), []);
});

test("owner query crossing a task notification is answered once with no error", async (t) => {
  // `settle`: the turn's start guessed Claude Code's own report (`injectedExpected`), but
  // the result says a person asked it after all, with the owner's own turn still in `sent`
  // to redirect it to. The turn itself succeeded: no ❌, and its answer, already in the
  // misrouted reply, is that reply's own: the owner turn's own reply is never written.
  const h = harnessFor(t)({ turns: [] });
  const session = h.session();
  const owner = await session.submit("what happened");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "what happened");
  inside(session).injectedExpected = true; // Claude Code's own report was also expected right now
  h.clients[0]?.inject(sdkMessages("tools")); // the result: a genuine human turn after all
  await owner.done.wait();
  await h.sleep(0.1);
  assert.deepEqual(h.reactions(), [Status.WORKING]); // no ❌: this turn actually succeeded
  assert.ok(h.slack.streamTs.length === 1 && h.slack.postedTs.length === 0);
  assert.equal(h.slack.pushes(), 1);
});

test("an abandon s error stands through a later unreported expiry", async (t) => {
  // `expireUnreported`'s own tail used to call `reactDoneIfIdle` unconditionally,
  // flipping a standing ❌ (here, `abandon({error: true})`, a crashed CLI) back to ✅ once the
  // session reads idle again, even though no new work ever started.
  const [first, notice] = splitBackground();
  const ended = notice.filter((item) => !isSystem(item, "task_notification"));
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(ended); // the task's terminal update, no notification yet: unreported
  await h.idle();
  assert.ok(inside(session).unreported.size > 0); // `expireUnreported`'s own timer is now scheduled
  h.clients[0]?.inject([END_OF_STREAM]); // the CLI process is gone
  await h.until(() => inside(session).client === null);
  assert.equal(h.reactions().at(-1), Status.ERROR);
  await reportTurnNeverCame(h); // past INJECTED_TURN_WAIT: the expiry timer has now fired
  assert.equal(h.reactions().at(-1), Status.ERROR);
});

test("a dropped queued turn with a running task gets a note and no reply", async (t) => {
  // A restart drain drops the queued turn while a background task still runs (drain lets it
  // keep running): the message gets no reply of its own; no turn runs, so one note names it.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  // Queued, and dropped before the worker takes it. `submit` queues in its synchronous part, and
  // awaiting it first would let the worker take the turn meanwhile.
  const queuing = session.submit("next");
  const dropping = session.dropQueued({ error: true });
  const second = await queuing;
  await dropping;
  await second.done.wait();
  assert.equal(h.slack.streamTs.length, 1); // the running reply's stream is the only one
  const [note, ...more] = h.slack.callsTo("chat.postMessage");
  assert.equal(more.length, 0);
  assert.ok(
    String(note?.text).includes(
      texts.fill(texts.NOT_SENT_ONE, { because: texts.BECAUSE_RESTARTED }),
    ),
  );
});

test("closing a session with only a running task left shows error", async (t) => {
  // `busy` (active or sent turns) misses a task that outlived its own turn: `close()` must
  // still react ❌ for cutting it short, or the ⏳ from the turn that started it never clears.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  assert.deepEqual(h.reactions(), [Status.WORKING]); // the task still runs: no ✅ yet
  assert.equal(session.busy, false); // the bug: `busy` alone would miss the running task
  await session.close();
  assert.deepEqual(h.reactions(), [Status.WORKING, Status.ERROR]);
});

test("a turn that finishes after a restart drain dropped a queued one ends on done", async (t) => {
  // A restart drain drops a queued turn (❌) while the running turn waits on an approval the
  // owner can still answer; the answer shows ⏳ again, and when that turn ends the root reads
  // ✅: the ❌ stood only until the next state was asked for.
  const ask = canUseToolCall("Bash", { command: "ls" });
  const messages = sdkMessages("tools");
  const h = harnessFor(t)({ turns: [[...messages.slice(0, 13), ask, ...messages.slice(13)]] });
  const session = h.session();
  const first = await session.submit("first");
  const second = await session.submit("second");
  await h.until(() => pending(h.approvals).length > 0);
  const drain = startDrain(h);
  await second.done.wait();
  resolve(h, APPROVE);
  await first.done.wait();
  await drainEnds(h, drain);
  await h.manager.closeAll();
  await h.sleep(0.2);
  assert.ok(h.reactions().includes(Status.ERROR));
  assert.equal(h.reactions().at(-1), Status.DONE);
});

test("a close right after a turn ends leaves done alone on the root", async (t) => {
  // Issue #104: the session reads idle while its reader is still between the two calls that
  // move ⏳ to ✅. A restart's drain closes it there, and the close cancels the reader.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  // A Slack round trip that is slow for the ⏳ removal only: held at the gate until the close
  // has begun. The fake's gate holds a method whatever it removes,
  // and the first removal of a thread's root is a strip of the other names, so this one is
  // held by name.
  const gate = new AsyncEvent();
  const apiCall = h.slack.apiCall.bind(h.slack);
  h.slack.apiCall = (method, options) =>
    method === "reactions.remove" && options?.name === Status.WORKING
      ? gate.wait().then(() => apiCall(method, options))
      : apiCall(method, options);
  await session.submit("list the files");
  await h.until(() => h.reactions().includes(Status.DONE) && session.restartReady);
  const closing = session.close();
  await h.idle();
  gate.set();
  await closing;
  await h.idle();
  const removed = h.slack.callsTo("reactions.remove").map((args) => String(args.name));
  assert.ok(removed.includes(Status.WORKING));
  assert.ok(!removed.slice(removed.indexOf(Status.WORKING)).includes(Status.DONE));
});

// --- The same-folder hold's reactions ---

test("hold end reacts from the thread s history after a client reset", async (t) => {
  // `client === null` alone is not "brand-new thread": an idle close or a restart evicts the
  // object and hands the thread a fresh one on its next lookup, `client` reset but its
  // history (a stored session id) intact.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  assert.notEqual(thread(h).sessionId, null);
  inside(session).client = null; // what an idle close or a restart hands the thread's next lookup
  session.holdStart();
  await h.idle(); // let the WAITING reaction's fire-and-forget task run
  await session.holdEnd({ continued: false });
  await h.until(() => h.reactions().at(-1) === Status.DONE);
});

test("hold end clears the reaction for a thread that never ran", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  assert.equal(thread(h).sessionId, null);
  session.holdStart();
  await h.until(() => onRoot(h).has(Status.WAITING));
  await session.holdEnd({ continued: false });
  await h.until(() => onRoot(h).size === 0);
});

test("hold keeps a standing error and cancel restores it", async (t) => {
  // `holdStart`'s own WAITING reaction must not reset `errorStanding` (it did, through
  // `react`), or Cancel right after turns a standing ❌ back into ✅: a hold is not new work.
  // The CLI process is gone in the middle of the turn: `abandon({error: true})`. One lost while
  // the session is idle leaves no cross (issue #202).
  const h = harnessFor(t)({ turns: [[...sdkMessages("tools").slice(0, 21), END_OF_STREAM]] });
  const session = h.session();
  await (await session.submit("go")).done.wait();
  await h.until(() => inside(session).client === null);
  await h.until(() => h.reactions().at(-1) === Status.ERROR);
  session.holdStart();
  assert.equal(inside(session).errorStanding, true); // not reset by the WAITING reaction
  await h.idle();
  await session.holdEnd({ continued: false });
  await h.until(() => h.reactions().at(-1) === Status.ERROR); // Cancel restores it, not ✅
  await h.idle();
  assert.equal(h.reactions().at(-1), Status.ERROR);
});

test("cancel while another approval is open shows waiting not working", async (t) => {
  // holdEnd's not-idle branch reacted WORKING unconditionally; a parallel approval this
  // thread still holds must keep showing ✋, not ⏳ (`reactWaitingOrWorking`).
  const h = harnessFor(t)({
    turns: [[canUseToolCall("Bash", { command: "ls" }), ...sdkMessages("tools")]],
  });
  const session = h.session();
  const turn = await session.submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  assert.ok(session.waitingForOwner); // the approval is open
  session.holdStart();
  await h.idle();
  await session.holdEnd({ continued: false });
  await h.idle();
  assert.equal(h.reactions().at(-1), Status.WAITING); // not WORKING: the approval is still open
  resolve(h, APPROVE);
  await turn.done.wait();
});

test("working in does not resolve a path on every lookup", async (t) => {
  // `workingIn` resolves no path on a message: each session's folder is resolved once, at
  // construction. The `lstatSync` that `resolvePath` walks with is replaced and the built-ins'
  // ES bindings are synced to it. The test first checks that this does stop `resolvePath`.
  const h = harnessFor(t)({
    turns: [[canUseToolCall("Bash", { command: "ls" }), ...sdkMessages("tools")]],
  });
  const first = h.session(THREAD);
  const second = h.session(OTHER_THREAD);
  await first.submit("clean");
  await h.until(() => pending(h.approvals).length > 0); // first is genuinely busy now
  // Typed as a constant, and a plain property of the module object at run time.
  const patched = fs as { lstatSync: typeof fs.lstatSync };
  const real = fs.lstatSync;
  patched.lstatSync = (() => {
    throw new Error("workingIn must not resolve a path on every lookup");
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => resolvePath(h.tmpPath), /must not resolve/);
    assert.equal(h.manager.workingIn({ besides: second }), first);
  } finally {
    patched.lstatSync = real;
    syncBuiltinESMExports();
  }
  resolve(h, APPROVE);
});

test("the manager names the threads with a live session", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  assert.deepEqual(h.manager.liveThreads(), []);
  const session = h.session();
  assert.deepEqual(h.manager.liveThreads(), [{ channel: CHANNEL, thread: THREAD }]);
  await session.close();
  assert.deepEqual(h.manager.liveThreads(), []); // a closed one is no longer in the way
});

test("a stop says what it waits for in a message where slack refuses a status", async (t) => {
  // The token cannot set a thread status: Slack refused the first call, and the flag that
  // says so is the process's.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  h.slack.responses["assistant.threads.setStatus"] = rejected("missing_scope");
  await (await h.session().submit("start it")).done.wait();
  await h.until(() => ThreadStatus.refused());
  const statusCalls = h.slack.callsTo("assistant.threads.setStatus").length;
  const drain = startDrain(h);
  await polled(h);
  await polled(h);
  assert.ok(!drain.done());
  const posted = h.slack.callsTo("chat.postMessage").map((args) => String(args.text));
  assert.deepEqual(posted, [texts.fill(texts.RESTART_WAITS_MESSAGE, { counts: "1 shell" })]); // once, however long
  assert.equal(h.slack.callsTo("assistant.threads.setStatus").length, statusCalls);
  drain.cut.abort();
  await drain.promise;
});

test("a post outside the session sets its thread status again", async (t) => {
  const h = harnessFor(t)({}); // a turn that never answers: `Working…` shows
  const session = h.session();
  await session.submit("hello");
  await h.until(() => statusLines(h).length > 0);
  await h.idle();
  const shown = statusLines(h).length;
  h.manager.wrote(CHANNEL, "1790000000.999999"); // no live session there: nothing to set
  await h.sleep(1);
  assert.equal(statusLines(h).length, shown);
  h.manager.wrote(CHANNEL, THREAD);
  await h.until(() => statusLines(h).length > shown, 3); // set again within 2 s of the write
});

test("the commands a subagent runs arm no wait for a report turn", async (t) => {
  // subagent-nested-command.jsonl: each long command the agent runs gets a task of its own on
  // the main stream, started by a call that has a parent. Claude Code reports it to the agent,
  // so no turn follows it.
  const waits = expectedTurns(t);
  const warnings = logged(t, "warning");
  const [first, work, , ends] = splitNestedCommand();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const agentTasks = [...inside(session).taskReplies.keys()];
  assert.equal(agentTasks.length, 1);
  h.clients[0]?.inject(work.slice(0, at(ends, 1) + 1));
  await reportTurnNeverCame(h); // longer than the wait: nothing was armed to fire in it
  assert.ok(waits.entered === 0 && inside(session).expiry === null);
  assert.ok(inside(session).settled.isSet && !inside(session).injectedExpected);
  assert.ok(!warnings.some((line) => line.includes("no turn followed a task notification")));
  assert.deepEqual([...inside(session).tasks.keys()], agentTasks);
  assert.deepEqual([...inside(session).taskReplies.keys()], agentTasks);
  assert.ok(
    inside(session).ended.length === 0 &&
      inside(session).unreported.size === 0 &&
      inside(session).held.length === 0,
  );
});

test("an owner prompt is not held while a subagent s command ends", async (t) => {
  const [first, work, , ends] = splitNestedCommand();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(work.slice(0, at(ends, 0) + 1));
  await h.sleep(0.05);
  await session.submit("and now?");
  // INJECTED_TURN_WAIT is the production 30 s and the sessions' clock stays put: a held prompt
  // would not reach the client here
  await h.until(() => h.clients[0]?.queries.join("\n") === "start it\nand now?", 1.0);
});

test("a subagent s commands have no card and no end line in the report", async (t) => {
  const waits = expectedTurns(t);
  const [first, work, report] = splitNestedCommand();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(work);
  h.clients[0]?.inject(report);
  await h.until(() => session.idle && h.reactions().at(-1) === Status.DONE, 3.0);
  assert.equal(waits.entered, 1); // the agent's own notification
  const bodies = h.bodies(); // The report renders into the reply that started the agent
  assert.equal(bodies.length, 2); // and its ending is posted as the reply's last message
  const body = at(bodies, 0);
  assert.ok(body.split("✓ ").length - 1 === 1 && body.includes('✓ Agent "'));
  // The agent runs in the background: a launch line, and no card for it or for its commands.
  assert.equal(body.split("Running in background").length - 1, 1);
  assert.deepEqual(h.slack.messageCards().flat(), []);
  assert.ok(noStreamOpen(h));
});

test("a subagent s command whose reply is not tracked is held as before", async (t) => {
  // A restart or an idle close dropped the reply that holds the agent's call: the session cannot
  // tell the command's task is nested, and treats it as any task of no known reply (held, and a
  // report turn expected). Ignoring it instead would drop a top-level task of an unknown call.
  const waits = expectedTurns(t);
  const [first, work, , ends] = splitNestedCommand();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  inside(session).taskReplies.clear();
  const nested = recordOf(at(work, at(ends, 0)))?.task_id; // the frames of the first command's task alone
  h.clients[0]?.inject(
    work.slice(0, at(ends, 0) + 1).filter((item) => recordOf(item)?.task_id === nested),
  );
  await h.until(() => waits.entered === 1);
  assert.ok(
    inside(session).held.some((event) => (event as { type: string }).type === "task_ended"),
  );
});

test("a subagent s command that outlives its call is a running shell", async (t) => {
  // subagent-nested-background.jsonl: the command runs in the background of a subagent that
  // ends (and reports) before it does; its own end follows the report turn.
  const [first] = splitNestedBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  const [command] = await nestedBackgroundRunning(h, session);
  await h.until(() => inside(session).taskReplies.has(command) && inside(session).active === null);
  await h.sleep(0.1);
  assert.ok(
    session.runningKinds === "1 shell" && inside(session).runningTaskIds().includes(command),
  );
  assert.ok(!session.idle && !session.restartReady);
  assert.equal(h.reactions().at(-1), Status.WORKING); // the first report turn did not end it
  const drain = startDrain(h);
  await polled(h);
  assert.ok(!drain.done()); // a drain waits for the command
  drain.cut.abort();
  await drain.promise;
  assert.equal(await session.stop(), true);
  assert.deepEqual(h.clients[0]?.stoppedTasks, [command]);
});

test("a background subagent s api error is the reason in its end line", async (t) => {
  // subagent-api-error.jsonl (issue #161): a background subagent whose requests all fail,
  // after the main turn's result; then Claude Code's report turn.
  const [first, later] = splitTurns(sdkMessages("subagent-api-error")) as [Item[], Item[]];
  const failed = later.filter((item) => isSystem(item, "task_notification"));
  assert.equal(failed.length, 1);
  assert.equal(recordOf(at(failed, 0))?.status, "failed");
  const reason = "Agent terminated early due to an API error: API Error: 529";
  assert.ok(String(recordOf(at(failed, 0))?.summary).startsWith(reason));
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  const log = captureLog();
  try {
    await (await session.submit("start it")).done.wait();
    h.clients[0]?.inject(later);
    await h.until(() => h.reactions().at(-1) === Status.DONE && session.idle);
  } finally {
    log.stop();
  }
  const texts_ = h.slack.messageTexts();
  assert.equal(texts_.length, 2); // the reply, and its ending posted when the report came
  const text = String(texts_[0]);
  // The terminal's line: the task's end, then why. The subagent's own message is no line of the
  // reply, as no other text of a subagent is, and no card is left to carry it.
  const lines = text.split("\n");
  assert.equal(lines.filter((line) => line.includes("API Error")).length, 1);
  assert.ok(lines.some((line) => line.startsWith(`✗ Agent "Synthetic subtask" failed: ${reason}`)));
  assert.deepEqual(h.slack.messageCards().flat(), []);
  assert.ok(!h.reactions().includes(Status.ERROR)); // the main turn and its report both succeeded
  assert.deepEqual(
    log.entries.filter((entry) => entry.level === "WARNING").map((entry) => entry.message),
    [`Claude Code reported a subagent's error in ${CHANNEL}/${THREAD}: server_error`],
  );
});

test("a foreground subagent s api error shows on its card", async (t) => {
  // subagent-api-error-foreground.jsonl (CLI 2.1.286): the Agent call is asked to run in the
  // foreground. No message with `error` is forwarded then: the task is notified as failed and
  // the call's result, an error, says why.
  const messages = sdkMessages("subagent-api-error-foreground");
  assert.ok(!messages.some((item) => isRecord(item, "assistant") && recordOf(item)?.error));
  const h = harnessFor(t)({ turns: [messages] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => h.reactions().at(-1) === Status.DONE);
  const card = at(taskCards(h), -1);
  // A failed call of a tool the fold has no count for keeps a card of its own, with the error
  // in its output.
  assert.equal(card.status, "error");
  assert.ok(
    String(card.output).includes("Agent terminated early due to an API error: API Error: 529"),
  );
  assert.ok(!h.slack.streamTexts().join("").includes("API Error"));
});

test("a reply s end that brings no checkmark logs what held it", async (t) => {
  // Issue #160: a root left on ⏳ could not be traced, since the check returned in silence.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const log = captureLog();
  try {
    await (await h.session().submit("start it")).done.wait();
    await h.sleep(0.1);
  } finally {
    log.stop();
  }
  const held = log.entries
    .map((entry) => entry.message)
    .filter((line) => line.includes("no done reaction"));
  assert.ok(held.length > 0 && held.every((line) => line.includes("running=1 shell"))); // the command still runs
  assert.equal(h.reactions().at(-1), Status.WORKING);
});

test("the reply is not ended while its turn is still active", async (t) => {
  const [head, commandEnd, tail] = nestedBackgroundEndingMidTurn();
  const h = harnessFor(t)({ turns: [[...head, ...commandEnd]] });
  const session = h.session();
  const turn = await session.submit("start it");
  await h.until(() => h.slack.callsTo("chat.startStream").length > 0);
  await h.sleep(0.2);
  // The turn has no result yet: the end of the subagent's command may not end its reply.
  assert.ok(inside(session).active !== null && !turn.done.isSet);
  assert.deepEqual(h.slack.callsTo("chat.stopStream"), []);

  h.clients[0]?.inject(tail);
  await turn.done.wait();
  await h.until(() => h.reactions().at(-1) === Status.DONE);
  await h.idle();
  // Ended once, by its own turn; the footer follows by an edit once the session has ended.
  assert.equal(h.slack.callsTo("chat.stopStream").length, 1);
  assert.deepEqual(footerWrites(h), ["chat.update"]);
});

test("a recorded turn that outlives its subagent s command ends once, then shows its footer", async (t) => {
  // subagent-nested-background-mid-turn.jsonl, in the order the CLI sent it (issue #149): the
  // command a subagent left running ends, and is notified, while the owner's turn still runs
  // a foreground command of its own; the agent then ends a second time and a report follows.
  const [first, later] = splitTurns(sdkMessages("subagent-nested-background-mid-turn")) as [
    Item[],
    Item[],
  ];
  const result = first.findIndex(isResult);
  const endedMidTurn = first
    .slice(0, result)
    .filter((item) => isSystem(item, "task_notification") && recordOf(item)?.status === "completed")
    .map((item) => recordOf(item)?.task_id);
  assert.equal(endedMidTurn.length, 3); // the agent, its command, the turn's own command
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => h.reactions().at(-1) === Status.DONE);
  await h.idle();
  assert.deepEqual(footerWrites(h), ["chat.update"]); // the session ended: its footer, by an edit
  assert.equal(h.slack.callsTo("chat.stopStream").length, 1); // at the turn's end, not before
  assert.deepEqual(h.slack.callsTo("chat.postMessage"), []); // no closing message of its own

  h.clients[0]?.inject(later); // the agent's second end, then Claude Code's report turn
  await h.until(() => h.slack.callsTo("chat.stopStream").length === 2);
  await h.until(() => h.reactions().at(-1) === Status.DONE && session.idle);
  await h.idle();
  // Each end of the session drew its footer by an edit; no stop carried one.
  assert.deepEqual(footerWrites(h), ["chat.update", "chat.update"]);
  assert.deepEqual(h.slack.callsTo("chat.postMessage"), []);
});

test("a subagent s command and the agent s second end close the reply as before", async (t) => {
  const [first] = splitNestedBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  const [command, tail, reportTwo] = await nestedBackgroundRunning(h, session);
  await h.until(() => inside(session).taskReplies.has(command) && inside(session).active === null);
  h.clients[0]?.inject(tail);
  h.clients[0]?.inject(reportTwo);
  await h.until(() => session.idle && h.reactions().at(-1) === Status.DONE, 3.0);
  assert.ok(session.runningKinds === "" && inside(session).runningTaskIds().length === 0);
  assert.equal(inside(session).unlanded.size, 0);
  assert.ok(noStreamOpen(h));
  // No card at all: the agent that started the command has a launch line, and the command,
  // left running, has none.
  assert.deepEqual(h.cards(), []);
  assert.equal(h.slack.streamTs.length, 1); // every report rendered into the reply that began it
  // The command's end is told to the subagent, which reports it: the terminal prints no line
  // for it in the conversation (captured 2026-10-14), only the agent's own ends.
  const body = h.bodies().join("\n");
  assert.ok(!body.includes("Background command"), body);
  assert.equal(body.split("✓ Agent ").length - 1, 2);
});

test("a command a continued subagent starts after a restart gets no end line either", async (t) => {
  // subagent-resume-after-restart.jsonl (issue #294, CLI 2.1.300): a new process resumes the
  // session and continues a background subagent with `SendMessage`. The subagent's own records
  // name the `Agent` call of the process before, which this one never saw; the command's
  // `task_started` names the subagent's task as its parent.
  const m = sdkMessages("subagent-resume-after-restart");
  const first = m.findIndex(isResult);
  const h = harnessFor(t)({ turns: [m.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("continue the agent")).done.wait();
  h.clients[0]?.inject(m.slice(first + 1));
  await h.until(() => session.idle && h.reactions().at(-1) === Status.DONE, 3.0);
  const body = h.bodies().join("\n");
  assert.ok(!body.includes("Background command"), body);
  assert.equal(body.split("✓ Agent ").length - 1, 2, body);
});

test("a posted and a removed request are logged by id and age only", async (t) => {
  // Issue #71: the push of a request is matched to its timing from the log.
  const recorded = recordedQuestion();
  const ask = canUseToolCall("Bash", { command: "SECRET-COMMAND-TEXT" });
  const question = canUseToolCall(recorded.toolName, recorded.input, "toolu_fake_2");
  const h = harnessFor(t)({ turns: [[ask, question, ...sdkMessages("tools")]] });
  const log = captureLog();
  let turn: Awaited<ReturnType<ThreadSession["submit"]>>;
  let approvalTs: string | undefined;
  let questionTs: string | undefined;
  try {
    const session = h.session();
    turn = await session.submit("SECRET-PROMPT-CONTENT");
    await h.until(() => pending(h.approvals).length > 0);
    approvalTs = h.slack.postedTs.at(-1);
    resolve(h, APPROVE);
    await h.until(() => pending(h.approvals).length > 0);
    questionTs = h.slack.postedTs.at(-1);
    assert.equal(await session.stop(), true);
    await session.stopLanded();
    await turn.done.wait();
    await h.until(() => log.entries.some((entry) => entry.message.startsWith("removed a request")));
  } finally {
    log.stop();
  }
  const lines = log.entries.map((entry) => entry.message);
  assert.ok(
    lines.includes(`posted an approval request in ${CHANNEL}/${THREAD}: message ${approvalTs}`),
  );
  assert.ok(
    lines.includes(`posted a question request in ${CHANNEL}/${THREAD}: message ${questionTs}`),
  );
  const removed = lines.filter((line) => line.startsWith("removed a request"));
  assert.equal(removed.length, 1);
  assert.ok(
    String(removed[0]).startsWith(`removed a request in ${CHANNEL}: message ${questionTs}, `),
  );
  assert.ok(String(removed[0]).endsWith("s after it was posted"));
  const everything = log.entries.map((entry) => entry.message).join("\n");
  assert.ok(!everything.includes("SECRET-PROMPT-CONTENT"));
  assert.ok(!everything.includes("SECRET-COMMAND-TEXT"));
});
