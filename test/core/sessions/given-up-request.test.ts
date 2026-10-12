/**
 * A request the agent gives up (it aborts the signal it passed the handler): the core takes it
 * back from the owner as a close does, settling that one request as refused and withdrawing its
 * message. Played with `requestWhileStreaming`, whose `abort` is the request's own signal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Status } from "../../../src/chat/slack/reply/status.ts";
import { APPROVE } from "../../../src/core/requests.ts";
import { CHANNEL, THREAD } from "../../support/fake-slack.ts";
import { type JsonObject, sdkJson } from "../../support/fixtures.ts";
import {
  type Harness,
  harnessFor,
  isRecord,
  recordOf,
  requestWhileStreaming,
  sdkMessages,
} from "../../support/sessions.ts";
import { pending } from "./helpers.ts";

const BASH: JsonObject = { command: "rm -rf build" };

/** The recorded turn cut right after the reply's first message. */
function openedTurn() {
  const tools = sdkMessages("tools");
  const started = tools.findIndex((item) => {
    const event = recordOf(item)?.event;
    return isRecord(item, "stream_event") && (event as JsonObject).type === "message_start";
  });
  assert.notEqual(started, -1);
  return tools.slice(0, started + 1);
}

interface Ask {
  readonly tool: string;
  readonly input: JsonObject;
  readonly callId: string;
  readonly abort: AbortController;
}

/** The recorded turn up to the reply's first message, then the requests, each with its signal. */
function askingTurn(asks: readonly Ask[]) {
  return [
    ...openedTurn(),
    ...asks.map((ask) => requestWhileStreaming(ask.tool, ask.input, ask.callId, ask.abort)),
  ];
}

/** A session with its turn running and `count` requests posted. */
async function posted(h: Harness, count: number) {
  const session = h.session();
  await session.submit("clean");
  await h.until(() => (h.state.thread(CHANNEL, THREAD)?.requests.length ?? 0) === count);
  return session;
}

const bash = (callId: string, abort = new AbortController()): Ask => ({
  tool: "Bash",
  input: BASH,
  callId,
  abort,
});

test("a permission given up while the owner is asked is refused and withdrawn", async (t) => {
  const abort = new AbortController();
  const h = harnessFor(t)({ turns: [askingTurn([bash("toolu_a", abort)])] });
  const session = await posted(h, 1);
  const requestTs = h.state.thread(CHANNEL, THREAD)?.requests[0];
  const approvalId = pending(h.approvals)[0];
  assert.ok(requestTs !== undefined && approvalId !== undefined);
  assert.equal(h.reactions().at(-1), Status.WAITING);

  abort.abort();
  await h.until(() => pending(h.approvals).length === 0);
  await h.idle();

  assert.deepEqual(
    h.slack.callsTo("chat.delete").map((args) => args.ts),
    [requestTs],
  );
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  const refused = h.clients[0]?.permissionResults[0];
  assert.ok(refused !== undefined && "allow" in refused && !refused.allow);
  // A click on the message that was there finds no request.
  assert.equal(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
  assert.equal(h.approvals.get(approvalId), null);
  // The root leaves waiting the way an answer leaves it: the turn still runs.
  assert.equal(h.reactions().at(-1), Status.WORKING);
  assert.equal(session.waitingForOwner, false);
});

test("a question given up while the owner is asked is skipped and withdrawn", async (t) => {
  const recorded = sdkJson("ask-can-use-tool") as JsonObject;
  const abort = new AbortController();
  const question: Ask = {
    tool: String(recorded.tool_name),
    input: recorded.input as JsonObject,
    callId: "q",
    abort,
  };
  const h = harnessFor(t)({ turns: [askingTurn([question])] });
  await posted(h, 1);
  const requestTs = h.state.thread(CHANNEL, THREAD)?.requests[0];

  abort.abort();
  await h.until(() => pending(h.approvals).length === 0);
  await h.idle();

  assert.deepEqual(
    h.slack.callsTo("chat.delete").map((args) => args.ts),
    [requestTs],
  );
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  const skipped = h.clients[0]?.permissionResults[0];
  assert.ok(skipped !== undefined && "answered" in skipped && !skipped.answered);
});

test("a signal aborted after the owner answered changes nothing", async (t) => {
  const abort = new AbortController();
  const h = harnessFor(t)({ turns: [askingTurn([bash("toolu_a", abort)])] });
  await posted(h, 1);
  const approvalId = pending(h.approvals)[0];
  assert.ok(approvalId !== undefined);

  assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
  await h.until(() => h.clients[0]?.permissionResults.length === 1);
  await h.idle();
  const deletes = h.slack.callsTo("chat.delete").length;
  const shown = h.reactions().length;

  abort.abort();
  await h.idle();

  assert.equal(h.slack.callsTo("chat.delete").length, deletes);
  assert.equal(h.reactions().length, shown);
  const answered = h.clients[0]?.permissionResults[0];
  assert.ok(answered !== undefined && "allow" in answered && answered.allow);
});

test("of two requests waiting, the one given up goes and the other stays", async (t) => {
  const abort = new AbortController();
  const h = harnessFor(t)({ turns: [askingTurn([bash("toolu_a", abort), bash("toolu_b")])] });
  const session = await posted(h, 2);
  const [first, second] = h.state.thread(CHANNEL, THREAD)?.requests ?? [];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(pending(h.approvals).length, 2);

  abort.abort();
  await h.until(() => pending(h.approvals).length === 1);
  await h.idle();

  assert.deepEqual(
    h.slack.callsTo("chat.delete").map((args) => args.ts),
    [first],
  );
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, [second]);
  assert.equal(session.waitingForOwner, true);
  assert.equal(h.reactions().at(-1), Status.WAITING);
  assert.equal(h.clients[0]?.permissionResults.length, 1);
});

test("a signal already aborted when the request arrives posts nothing", async (t) => {
  const abort = new AbortController();
  abort.abort();
  const h = harnessFor(t)({ turns: [askingTurn([bash("toolu_a", abort)])] });
  await h.session().submit("clean");
  await h.until(() => h.clients[0]?.permissionResults.length === 1);
  await h.idle();

  const refused = h.clients[0]?.permissionResults[0];
  assert.ok(refused !== undefined && "allow" in refused && !refused.allow);
  assert.deepEqual(pending(h.approvals), []);
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  assert.equal(h.slack.callsTo("chat.delete").length, 0);
  assert.ok(!h.reactions().includes(Status.WAITING));
});
