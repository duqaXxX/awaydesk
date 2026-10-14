/**
 * What the core reads from the capabilities of the agent (`AgentBackend.capabilities`) and of the
 * chat (`ChatProvider.capabilities`). With a capability false the feature it names is not
 * offered and the core never calls what serves it; with it true everything is as before, which
 * the rest of the session tests show. The capabilities are the harness's: the Claude back end's
 * declaration with the one under test turned off, and the real Slack provider, behind a facade
 * that records what the sessions call on it when the test sets what the chat declares.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Capabilities, ListedSession, SessionEvent } from "../../../src/agent/seam.ts";
import { BypassUnavailable, DirectoryUntrusted } from "../../../src/core/sessions/errors.ts";
import { DEFAULT } from "../../../src/core/setup.ts";
import { CHANNEL, THREAD } from "../../support/fake-slack.ts";
import {
  event,
  type Harness,
  harnessFor,
  type Item,
  isResult,
  sdkMessages,
} from "../../support/sessions.ts";
import { inside, logged, play, said, send, splitBackground, statusLines } from "./helpers.ts";

/** The agent of `h` with `capabilities` changed, before its first session starts. */
function lacking(h: Harness, capabilities: Partial<Capabilities>): void {
  h.backend.capabilities = { ...h.backend.capabilities, ...capabilities };
}

const OWNER_TURN_ENDED: SessionEvent = {
  type: "turn_ended",
  sessionId: "session-1",
  startedBy: "owner",
  finalText: null,
  ending: "done",
  steps: 1,
  tokens: {},
};

const AGENT_TURN_ENDED: SessionEvent = { ...OWNER_TURN_ENDED, startedBy: "agent" };

function listed(id: string): ListedSession {
  return { id, title: id, customTitle: null, branch: null, size: null, lastModified: 1 };
}

// ---- the agent's capabilities -----------------------------------------------------------------

test("usageLimits off: no limit is fetched, shown or invalidated", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  lacking(h, { usageLimits: false });
  const errors = logged(t, "error");
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  h.clients[0]?.inject([event({ type: "limits_changed" })]);
  const status = await session.status();
  await h.idle();
  assert.equal(h.usageFetches, 0);
  assert.ok(!status.includes("limit"), status);
  assert.deepEqual(errors, []);
});

test("usageLimits off and no cache: the footer and the status are built without one", async (t) => {
  const h = harnessFor(t, { usage: null })({ turns: [sdkMessages("tools")] });
  lacking(h, { usageLimits: false });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  h.clients[0]?.inject([event({ type: "limits_changed" })]);
  const status = await session.status();
  assert.ok(status.includes("Context: `7%`") && !status.includes("limit"), status);
  assert.equal(h.usageFetches, 0);
});

test("models off: the setup lists no model and setModel is never called", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { models: false });
  const session = h.session();
  await session.ensureConnected();
  assert.deepEqual(session.models, []);
  // A choice that names a model anyway (a stale form) reaches no `setModel`.
  await session.applySetup({ model: "haiku", effort: DEFAULT, bypass: false });
  assert.deepEqual(h.clients[0]?.modelsSet, []);
});

test("models on: the setup lists the agent's models and a chosen one is set", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.ensureConnected();
  assert.ok(session.models.some((model) => model.value === "haiku"));
  await session.applySetup({ model: "haiku", effort: DEFAULT, bypass: false });
  assert.deepEqual(h.clients[0]?.modelsSet, ["haiku"]);
});

test("models off: the footer shows the model the agent reports, and none otherwise", async (t) => {
  const reported = harnessFor(t)({ turns: [sdkMessages("tools")] });
  lacking(reported, { models: false });
  await (await reported.session().submit("list the files")).done.wait();
  assert.ok((await reported.session().status()).includes("Model: `claude-haiku-4-5-20251001`"));
});

test("models off and none reported: the footer and the status show no model", async (t) => {
  const h = harnessFor(t)({
    turns: [sdkMessages("tools")],
    contextUsage: { model: null, percentage: null },
  });
  lacking(h, { models: false });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  assert.ok(!(await session.status()).includes("Model:"));
});

test("commands off: the agent's commands are not read", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { commands: false });
  const session = h.session();
  await session.ensureConnected();
  assert.deepEqual(session.commands, []);
  // What the help and the passthrough make of an agent with no commands: `test/core/commands.test.ts`.
});

test("commands on: the session holds the agent's commands", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.ensureConnected();
  assert.ok(session.commands.some((command) => command.name === "compact"));
});

test("promptDuringTurn off: a prompt waits for the turn the agent started by itself", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { promptDuringTurn: false });
  const session = h.session();
  await session.ensureConnected();
  // The agent starts a turn of its own while the session expects none.
  h.clients[0]?.inject([
    event({ type: "message_started", parentCallId: null }),
    event({ type: "text", text: "reporting" }),
  ]);
  await h.until(() => inside(session).active !== null);
  const prompt = await session.submit("and now this");
  await h.sleep(0.2);
  assert.deepEqual(h.clients[0]?.sent, [], "the prompt was handed to the agent mid-turn");
  assert.ok(session.busy);
  h.clients[0]?.inject([event(AGENT_TURN_ENDED)]);
  await h.until(() => h.clients[0]?.sent.length === 1);
  assert.equal(h.clients[0]?.queries[0], "and now this");
  assert.ok(!prompt.done.isSet);
});

test("promptDuringTurn on: a prompt is handed to the agent while its own turn runs", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  await session.ensureConnected();
  h.clients[0]?.inject([
    event({ type: "message_started", parentCallId: null }),
    event({ type: "text", text: "reporting" }),
  ]);
  await h.until(() => inside(session).active !== null);
  await session.submit("and now this");
  await h.until(() => h.clients[0]?.sent.length === 1);
});

test("sessionListing off: no session is listed or dated and the agent is not asked", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { sessionListing: false });
  h.backend.listed = [listed("a"), listed("b")];
  assert.deepEqual(await h.manager.sessionsIn(h.tmpPath), []);
  assert.deepEqual(await h.manager.sessionsIn(h.tmpPath, { dated: true }), []);
  assert.deepEqual(await h.manager.dated(h.tmpPath, h.backend.listed), []);
  assert.deepEqual(h.backend.called, []);
});

test("sessionListing on: the agent's sessions are listed and dated", async (t) => {
  const h = harnessFor(t)({});
  h.backend.listed = [listed("a")];
  assert.deepEqual(await h.manager.sessionsIn(h.tmpPath, { dated: true }), [listed("a")]);
  assert.deepEqual(h.backend.called, ["listSessions", "datedSessions"]);
});

test("folderTrust off: a session starts in an untrusted folder and no trust is asked", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  lacking(h, { folderTrust: false });
  h.backend.trusted = async () => false;
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle();
  assert.equal(h.clients.length, 1);
  assert.equal(await h.manager.unavailable(h.tmpPath), null);
  assert.equal(await h.manager.repository(h.tmpPath), null);
  assert.ok(!h.backend.called.includes("folderTrusted"), h.backend.called.join());
  assert.ok(!h.backend.called.includes("trustedRepository"), h.backend.called.join());
  assert.ok(!(await session.status()).includes("Branch:"));
});

test("folderTrust off: the folders offered to bind are every one under the root", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { folderTrust: false });
  h.backend.trusted = async () => false;
  mkdirSync(join(h.tmpPath, "first"));
  assert.deepEqual(await h.manager.foldersIn(h.tmpPath), [h.tmpPath, join(h.tmpPath, "first")]);
  assert.deepEqual(h.backend.called, []);
});

test("folderTrust on: an untrusted folder starts no session", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  h.backend.trusted = async () => false;
  assert.ok((await h.manager.unavailable(h.tmpPath)) instanceof DirectoryUntrusted);
  assert.deepEqual(await h.manager.foldersIn(h.tmpPath), []);
  assert.deepEqual(h.backend.called, ["folderTrusted", "folderTrusted"]);
});

/** The events of an owner's turn in which an agent runs a subagent that calls a tool. */
function subagentTurn(): Item[] {
  return [
    event({ type: "message_started", parentCallId: null }),
    event({
      type: "call_started",
      callId: "agent-1",
      toolName: "Agent",
      input: { description: "look around" },
      parentCallId: null,
    }),
    event({
      type: "task_started",
      taskId: "task-1",
      kind: "subagent",
      taskType: "local_agent",
      description: "look around",
      callId: "agent-1",
      agentType: "general-purpose",
      // One the call waits for, which has a card for its calls to be counted on.
      background: false,
    }),
    event({
      type: "call_started",
      callId: "inner-1",
      toolName: "Read",
      input: { file_path: "inner-notes.txt" },
      parentCallId: "agent-1",
    }),
    event({
      type: "call_ended",
      callId: "inner-1",
      isError: false,
      output: "ok",
      fileChange: null,
      parentCallId: "agent-1",
    }),
    event({ type: "task_progress", taskId: "task-1", description: "reading", callId: "agent-1" }),
    event({
      type: "task_ended",
      taskId: "task-1",
      status: "completed",
      summary: "looked",
      durationMs: 5,
      callId: "agent-1",
    }),
    event({
      type: "call_ended",
      callId: "agent-1",
      isError: false,
      output: "looked",
      fileChange: null,
      parentCallId: null,
    }),
    event({ type: "message_ended", parentCallId: null }),
    event(OWNER_TURN_ENDED),
  ];
}

test("subagents on: a call made under a subagent is counted on its card", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  const turn = await send(h, session, "look around");
  h.clients[0]?.inject(subagentTurn());
  await turn.done.wait();
  // The card counts the call made under it.
  assert.ok(JSON.stringify(h.cards()).includes("1 call"), JSON.stringify(h.cards()));
  assert.equal(inside(session).tasks.size, 0); // the task ended with the turn
});

test("subagents off: a subagent's events are ignored, one line each in the log", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { subagents: false });
  const warnings = logged(t, "warning");
  const session = h.session();
  const turn = await send(h, session, "look around");
  h.clients[0]?.inject(subagentTurn());
  await turn.done.wait();
  assert.ok(!JSON.stringify(h.cards()).includes("1 call"));
  assert.equal(inside(session).tasks.size, 0);
  // The two calls under the subagent and the three events of its task.
  const ignored = warnings.filter((line) => line.includes("the agent has no subagents"));
  assert.equal(ignored.length, 5, ignored.join("\n"));
  assert.ok(ignored.every((line) => !line.includes("inner-notes")));
});

test("backgroundTasks off: no task outlives its turn, no report turn is awaited", async (t) => {
  const [first, notice] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  lacking(h, { backgroundTasks: false });
  const warnings = logged(t, "warning");
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  assert.ok(warnings.some((line) => line.includes("backgroundTasks")));
  assert.equal(inside(session).tasks.size, 0);
  assert.equal(inside(session).taskReplies.size, 0);
  assert.equal(session.runningKinds, "");
  h.clients[0]?.inject([...notice, event({ type: "report_started", taskId: "task-1" })]);
  await h.idle();
  assert.equal(inside(session).injectedExpected, false);
  assert.equal(inside(session).notificationWaits, false);
  assert.equal(inside(session).settled.isSet, true);
  assert.equal(inside(session).unreported.size, 0);
  assert.equal(await session.stop(), false);
  assert.deepEqual(h.clients[0]?.stoppedTasks, []);
  assert.equal(session.restartReady, true);
});

test("backgroundTasks off: a stop interrupts a subagent running in the turn and stops no task", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { backgroundTasks: false });
  const session = h.session();
  await send(h, session, "look around");
  h.clients[0]?.inject(subagentTurn().slice(0, 3));
  await h.until(() => inside(session).tasks.size === 1);
  assert.equal(await session.stop(), true);
  assert.equal(h.clients[0]?.interrupts, 1);
  assert.deepEqual(h.clients[0]?.stoppedTasks, []);
});

test("compaction off: a compaction is neither announced nor shown", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, { compaction: false });
  const warnings = logged(t, "warning");
  const session = h.session();
  const running = await send(h, session, "read the ledgers again");
  play(h, sdkMessages("auto-compact"));
  await running.done.wait();
  await h.idle();
  assert.ok(!said(h).includes("Compacted the conversation"));
  assert.ok(!statusLines(h).includes("Compacting conversation…"));
  assert.equal(inside(session).compacting, false);
  assert.ok(warnings.some((line) => line.includes("compaction")));
});

test("declared state off: what the agent says of its state changes no line", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = harnessFor(t)({ turns: [items.slice(0, first + 1)] });
  lacking(h, { declaredState: false });
  const warnings = logged(t, "warning");
  await (await h.session().submit("launch it")).done.wait();
  await h.until(() => statusLines(h).at(-1) === "");
  await h.sleep(0.05);
  // The subagent still runs and the agent said `working`: the line is the owner's prompt's alone.
  assert.equal(statusLines(h).at(-1), "");
  assert.ok(warnings.some((line) => line.includes("declaredState")));
});

test("bypass with no bypass mode: the word is refused and nothing is stored", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, {
    permissionModes: { default: "default", auto: null, bypass: null },
  });
  const session = h.session();
  await session.ensureConnected();
  for (const on of [true, false]) {
    await assert.rejects(session.switchBypass(on), BypassUnavailable);
  }
  assert.equal(session.bypassChoice, null);
  assert.deepEqual(h.clients[0]?.modes, []);
});

// Found by a mutation run of 2026-10-11: with the guard of `modeFor` gone, no test failed. A stored
// bypass outlives a change of agent, so a connect can meet an agent that has no such mode.
test("a stored bypass on an agent with no bypass mode: the connect fails and no mode is set", async (t) => {
  const h = harnessFor(t)({});
  lacking(h, {
    permissionModes: { default: "default", auto: null, bypass: null },
  });
  const session = h.session();
  h.state.setSession(CHANNEL, THREAD, "session-1");
  h.state.setBypass(CHANNEL, THREAD, true);
  assert.equal(session.bypassChoice, true);
  await assert.rejects(session.ensureConnected(), BypassUnavailable);
  // The mode the agent would be told is null: the call must not be made at all.
  assert.deepEqual(h.clients[0]?.modes, []);
  // The client the failed connect opened is closed, not left running.
  assert.equal(h.clients[0]?.connected, false);
  assert.equal(inside(session).client, null);
});

test("an agent that declares no optional capability runs a whole turn", async (t) => {
  // Every one off at once; the fake still lists models and commands, which the core ignores.
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  lacking(h, {
    subagents: false,
    backgroundTasks: false,
    compaction: false,
    declaredState: false,
    questions: false,
    usageLimits: false,
    models: false,
    commands: false,
    promptDuringTurn: false,
    sessionListing: false,
    folderTrust: false,
  });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle();
  assert.equal(h.usageFetches, 0);
  assert.deepEqual(h.backend.called, []);
  assert.ok(said(h).length > 0);
});

// ---- the chat's capabilities ------------------------------------------------------------------

const STATUS_MEMBERS = ["showStatus", "clearStatus", "settleStatus"];

test("reactions off: no status is shown, cleared or settled, and the stored one is kept", async (t) => {
  const h = harnessFor(t, { chatCapabilities: { reactions: false } })({
    turns: [sdkMessages("tools")],
  });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle();
  await session.close();
  for (const member of STATUS_MEMBERS) {
    assert.ok(!h.chatCalls.includes(member), `${member} was called`);
  }
  assert.deepEqual(h.reactions(), []);
  assert.equal(h.state.thread(CHANNEL, THREAD)?.ended, "done");
});

test("reactions off: a hold that is cancelled clears no status", async (t) => {
  const h = harnessFor(t, { chatCapabilities: { reactions: false } })({});
  const session = h.session();
  session.holdStart();
  await session.holdEnd({ continued: false });
  assert.ok(!h.chatCalls.includes("clearStatus"));
  assert.ok(!h.chatCalls.includes("showStatus"));
});

test("reactions on: the status is shown through the chat", async (t) => {
  const h = harnessFor(t, { chatCapabilities: { reactions: true } })({
    turns: [sdkMessages("tools")],
  });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle();
  assert.ok(h.chatCalls.includes("showStatus"));
  assert.ok(h.reactions().length > 0);
});

test("activityLine off: no activity is shown, and no refusal is read or posted over", async (t) => {
  const h = harnessFor(t, { chatCapabilities: { activityLine: false } })({
    turns: [sdkMessages("tools")],
  });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await session.showRestartWait();
  await h.idle();
  assert.ok(!h.chatCalls.includes("showActivity"));
  assert.ok(!h.chatReads.includes("activityRefused"));
  assert.deepEqual(statusLines(h), []);
});

test("activityLine on: the activity is shown through the chat", async (t) => {
  const h = harnessFor(t, { chatCapabilities: { activityLine: true } })({
    turns: [sdkMessages("tools")],
  });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle();
  assert.ok(h.chatCalls.includes("showActivity"));
});

/** The texts the sessions' replies were handed, from a turn that streams `tools`. */
async function handedOver(t: TestContext, nativeStreaming: boolean): Promise<string[]> {
  const h = harnessFor(t, { chatCapabilities: { nativeStreaming } })({
    turns: [sdkMessages("tools")],
  });
  await (await h.session().submit("list the files")).done.wait();
  await h.idle();
  return h.replyTexts;
}

test("nativeStreaming off: each text is handed to the reply whole, once", async (t) => {
  const streamed = await handedOver(t, true);
  const whole = await handedOver(t, false);
  assert.ok(whole.length < streamed.length, `${whole.length} texts, ${streamed.length} pieces`);
  // The same words reach the reply, put together where a text ends.
  assert.equal(whole.join(""), streamed.join(""));
  assert.equal(new Set(whole).size, whole.length);
});
