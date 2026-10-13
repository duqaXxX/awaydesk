/**
 * An agent continued with `SendMessage` in a daemon that never saw the call that first started
 * it (issue #150), replayed from a recording made on 2026-10-05 with claude-agent-sdk 0.2.163
 * and its bundled CLI 2.1.286 (`report-turn-agent-resume`).
 *
 * Measured there: an agent continued with `SendMessage` keeps its task id, and its own records
 * name the call that first started it, not the `SendMessage` call. Claude Code takes a prompt
 * that reaches it while a turn runs into that turn, with no result of the prompt's own, so the
 * session must hold the owner's next prompt until the turn that reports the agent has ended.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import {
  type Harness,
  harnessFor,
  type Item,
  isResult,
  isSystem,
  recordOf,
  sdkMessages,
} from "../../support/sessions.ts";
import {
  assertNothingRuns,
  assertStopHasNothingToStop,
  commandRuns,
  inside,
  isTopLevelCall,
  toolUseOf,
  workerHolds,
} from "./helpers.ts";

/**
 * A recording cut where its last report turn starts and where that turn's first tool call is
 * made: `head` runs up to the call, `rest` from there to the turn's one result.
 */
interface Recording {
  readonly messages: Item[];
  readonly results: number[];
  readonly report: number;
  readonly call: number;
  readonly callId: string;
  readonly head: Item[];
  readonly rest: Item[];
}

function at<T>(list: readonly T[], index: number): T {
  const found = list.at(index);
  if (found === undefined) throw new Error(`nothing at ${index}`);
  return found;
}

/**
 * The recording ends with a prompt of the driver's own that gets a result of its own, after one
 * result with an origin: the last report turn.
 */
function cut(messages: Item[]): Recording {
  const results = messages.flatMap((item, index) => (isResult(item) ? [index] : []));
  const reported = at(
    results.filter((index) => recordOf(messages[index])?.origin),
    -1,
  );
  let report = -1;
  for (let index = 0; index < reported; index += 1) {
    if (isSystem(messages[index], "init")) report = index;
  }
  let call = -1;
  for (let index = report; index < reported && call === -1; index += 1) {
    if (isTopLevelCall(messages[index])) call = index;
  }
  assert.ok(report !== -1 && call !== -1);
  const callId = toolUseOf(messages[call]);
  assert.ok(callId !== null);
  return {
    messages,
    results,
    report,
    call,
    callId,
    head: messages.slice(report, call + 1),
    rest: messages.slice(call + 1, at(results, -2) + 1),
  };
}

/**
 * The `agent-resume` recording, the session itself deciding when the second prompt is sent: the
 * owner has an agent continued with `SendMessage`, the agent ends, Claude Code starts the turn
 * that reports it and that turn runs a command; the owner's prompt is queued then. `restarted`:
 * the daemon starts at the `SendMessage` turn, so it never saw the call that first started the
 * agent.
 */
async function playTheContinuedAgent(
  t: TestContext,
  options: { readonly restarted: boolean },
): Promise<[Harness, ThreadSession]> {
  const r = cut(sdkMessages("report-turn-agent-resume"));
  const m = r.messages;
  const [owner, firstReport, sent, , answered] = r.results as [
    number,
    number,
    number,
    number,
    number,
  ];
  const sendTurn = m.slice(firstReport + 1, sent + 1);
  const agentWorks = m.slice(sent + 1, r.report);
  let h: Harness;
  let session: ThreadSession;
  if (options.restarted) {
    h = harnessFor(t)({ turns: [sendTurn] });
    session = h.session();
  } else {
    h = harnessFor(t)({ turns: [m.slice(0, owner + 1), sendTurn] });
    session = h.session();
    await (await session.submit("start an agent")).done.wait();
    h.clients[0]?.inject(m.slice(owner + 1, firstReport + 1));
    await h.until(() => session.idle);
  }
  await (await session.submit("continue the agent")).done.wait();
  const client = at(h.clients, 0);
  const sentSoFar = client.queries.length;
  client.inject([...agentWorks, ...r.head]);
  await commandRuns(h, session, r.callId);
  const prompt = await session.submit("what did it find?");
  await workerHolds(h, session, prompt);
  // The report turn would take the prompt into itself and end it with its own one result.
  assert.equal(client.queries.length, sentSoFar);
  client.inject(r.rest);
  await h.until(() => client.queries.length === sentSoFar + 1);
  assert.equal(inside(session).active, null);
  client.answer(m.slice(at(r.results, -2) + 1, answered + 1));
  await prompt.done.wait();
  await h.until(() => inside(session).active === null);
  return [h, session];
}

test("a continued agent after a restart opens no turn and leaves nothing behind", async (t) => {
  // The daemon never saw the `Agent` call the continued agent's records name.
  const [h, session] = await playTheContinuedAgent(t, { restarted: true });
  assertNothingRuns(h, session);
  await assertStopHasNothingToStop(h, session);
});

test("a continued agent in the daemon that saw its first call leaves nothing behind", async (t) => {
  const [h, session] = await playTheContinuedAgent(t, { restarted: false });
  assertNothingRuns(h, session);
  await assertStopHasNothingToStop(h, session);
});

test("a continued agent frame never starts a turn", async (t) => {
  // Records of an agent whose call no reply holds, while no turn runs: nothing of Claude Code's
  // own turn is under way, and the reply of the owner's next prompt is not theirs to take.
  const r = cut(sdkMessages("report-turn-agent-resume"));
  const m = r.messages;
  const [, firstReport, sent] = r.results as [number, number, number];
  const h = harnessFor(t)({ turns: [m.slice(firstReport + 1, sent + 1)] });
  const session = h.session();
  await (await session.submit("continue the agent")).done.wait();
  const agentWorks = m.slice(sent + 1, r.report);
  // Twice: the agent continued a second time works under the same unknown call.
  h.clients[0]?.inject(agentWorks);
  h.clients[0]?.inject(agentWorks);
  await h.sleep(0.2);
  assert.equal(inside(session).active, null);
  // the owner's turn alone has a reply
  assert.equal(h.slack.callsTo("chat.startStream").length, 1);
});

test("a report turn after a restart renders into the one reply that is the last thing (case 1)", async (t) => {
  // The daemon never saw the `Agent` call, but the agent's own task is shown in the reply of the
  // continued turn (`taskReplies`), which nothing sits below: the report renders there. Before
  // the report went to the bottom it opened a reply of its own in the middle of the thread.
  const [h] = await playTheContinuedAgent(t, { restarted: true });
  const texts = h.replies();
  assert.equal(texts.length, 2, texts.join("\n---\n"));
  const [continued, answered] = texts as [string, string];
  assert.ok(continued.startsWith("SENT") && continued.includes("REPORTED"), continued);
  assert.equal(answered, "KIWI");
  assert.equal(h.slack.callsTo("chat.postMessage").length, 0);
});

test("a report turn in the daemon that saw the first call opens its own reply below the waiting one", async (t) => {
  // The reply that started the agent ended with an earlier report; the continued turn's reply sits
  // below it and the report turn comes after, so the thread reads in the order things happened.
  const [h] = await playTheContinuedAgent(t, { restarted: false });
  const texts = h.replies();
  assert.equal(texts.length, 4, texts.join("\n---\n"));
  const [started, continued, report, answered] = texts as [string, string, string, string];
  assert.ok(started.startsWith("STARTED"), started);
  assert.equal(continued, "SENT");
  assert.ok(report.includes("REPORTED") && !report.includes("SENT"), report);
  assert.equal(answered, "KIWI");
  // The waiting reply ended in place: nothing was posted for any ending.
  assert.equal(h.slack.callsTo("chat.postMessage").length, 0);
});
