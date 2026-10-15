/**
 * The asking flows of the core, over the memory chat: what is asked of the owner, which choices
 * exist and what follows an answer. The chat only draws; it checks who acted before anything
 * reaches the core, and a second chat that draws gets the same behaviour as Slack.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { HoldRequest, SetupRequest } from "../../../src/chat/seam.ts";
import { logger } from "../../../src/core/flows/talk.ts";
import { SessionClosed, SessionGone } from "../../../src/core/sessions/errors.ts";
import { StateStore } from "../../../src/core/state.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { OWNER, SOMEONE } from "../../support/memory-chat.ts";
import { call, type PlainAgent, question, say } from "../../support/plain-agent.ts";
import { FakeAgentBackend, settledTurn } from "../../support/sessions.ts";
import { AskingWorld } from "./asking-world.ts";

/** The lines the core's flows logged from here on. */
function logged(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of ["info", "warning", "error"] as const) {
    const write = logger[level].bind(logger);
    t.mock.method(logger, level, (line: string) => {
      lines.push(line);
      write(line);
    });
  }
  return lines;
}

// The names the texts take when the plain agent and the memory chat are the two modules.
const PLAIN_NAMES = {
  agent: "Plain",
  author: "Plain",
  cli: "plain",
  chat: "Memory chat",
  examples: "`!echo hello`, `!count one two`",
  login: "signin",
  logout: "signout",
  newSession: ["restart"],
};

/** A second thread with its session, working in the folder: the one a hold names. */
async function busyNeighbour(world: AskingWorld) {
  const neighbour = world.thread();
  (world.agent as PlainAgent).next({ hold: true });
  await neighbour.session.submit("long job");
  for (let round = 0; round < 50 && !neighbour.session.busy; round += 1) {
    await settledTurn();
  }
  assert.ok(neighbour.session.busy, "the neighbour works");
  return neighbour;
}

// --- The same-folder hold

test("a hold is asked with the link to the other thread and sends on Send anyway", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  const sent = world.flows.hold.beforeSending(ref, session, other.session);
  const open = await world.asked(ref, "hold");
  const request = open.request as HoldRequest;
  const link = fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: other.ref.thread });
  assert.deepEqual(request, { type: "hold", requestId: open.requestId, other: other.ref, link });
  assert.equal(open.title, fill(texts.HOLD_QUESTION, { link }));
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, [open.message]);

  assert.equal(await world.answers(open.requestId, { type: "hold", send: true }), true);
  assert.equal(await sent, true);
  assert.deepEqual(world.open(ref), []);
  assert.ok(!world.shown(ref).includes(open.title), "the question is removed");
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
  assert.ok(!world.shown(ref).includes(texts.NOT_SENT));
  assert.deepEqual(world.chat.strayCalls(), []);
});

test("a hold the owner does not send says Not sent. and is gone", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  const sent = world.flows.hold.beforeSending(ref, session, other.session);
  const open = await world.asked(ref, "hold");

  assert.equal(await world.answers(open.requestId, { type: "hold", send: false }), true);
  assert.equal(await sent, false);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.NOT_SENT]);
  assert.ok(!world.shown(ref).includes(open.title));
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
});

test("a hold answered twice is refused the second time, and the log says why", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  const sent = world.flows.hold.beforeSending(ref, session, other.session);
  const open = await world.asked(ref, "hold");
  await world.inbound.answer(ref, open.requestId, { type: "hold", send: true }, open.message);
  await sent;
  const lines = logged(t);

  const again = await world.inbound.answer(
    ref,
    open.requestId,
    { type: "hold", send: true },
    open.message,
  );
  assert.equal(again, false);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.HOLD_GONE]);
  assert.deepEqual(lines, [
    `refused a click (hold decision) in ${ref.channel}/${ref.thread} on message ${open.message}; send=True, held=False, decided=False`,
  ]);
});

test("a hold answered from another thread is refused and stays open", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  const sent = world.flows.hold.beforeSending(ref, session, other.session);
  const open = await world.asked(ref, "hold");

  const wrong = await world.inbound.answer(
    other.ref,
    open.requestId,
    { type: "hold", send: true },
    open.message,
  );
  assert.equal(wrong, false);
  assert.deepEqual(world.shown(other.ref).slice(-1), [texts.HOLD_GONE]);
  assert.equal(world.open(ref).length, 1, "the owner can still answer it where it was asked");
  await world.answers(open.requestId, { type: "hold", send: false });
  assert.equal(await sent, false);
});

test("a stop of the thread cancels the hold: Not sent., the question removed", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  const sent = world.flows.hold.beforeSending(ref, session, other.session);
  const open = await world.asked(ref, "hold");

  await session.stop();
  assert.equal(await sent, false);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.NOT_SENT]);
  assert.ok(!world.shown(ref).includes(open.title));
  assert.deepEqual(world.open(ref), []);
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
});

test("a hold the chat cannot show is not sent, and the owner is told", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  // The channel is gone for the chat: every post is refused.
  world.chat.removeChannel(world.channel);
  const lines = logged(t);
  assert.equal(await world.flows.hold.beforeSending(ref, session, other.session), false);
  assert.deepEqual(lines, [
    `could not post a hold in ${ref.channel}/${ref.thread}: channel_not_found`,
  ]);
  assert.equal(world.holds.get("anything"), null);
  assert.deepEqual(world.chat.requests(), []);
});

// --- The drain, before, during and after a question is shown

test("a drain that began before the question refuses it and shows nothing", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  world.sessions.draining = true;

  assert.equal(await world.flows.hold.beforeSending(ref, session, other.session), false);
  assert.equal(world.shown(ref).at(-1)?.startsWith(texts.RESTARTING), true);
  assert.deepEqual(world.chat.requests(), []);
  assert.equal(await world.flows.setup.beforeSending(ref, session), null);
  assert.deepEqual(world.chat.requests(), []);
});

test("a drain that starts while the question is shown cancels it", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");

  const cut = new AbortController();
  const drain = world.sessions.drain(cut.signal);
  assert.equal(await asked, null);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.NOT_SENT]);
  assert.ok(!world.shown(ref).includes(texts.SETUP_FALLBACK));
  assert.equal(world.holds.get(open.requestId), null);
  cut.abort();
  await drain;
});

test("a drain that starts while Start is applied cancels it: nothing is sent", async (t) => {
  const world = await AskingWorld.make(t, { gated: true });
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "full", bypass: false },
  });
  // The summary waits on the chat: Start is still being applied when the drain begins.
  for (let round = 0; round < 20; round += 1) await settledTurn();
  const cut = new AbortController();
  const drain = world.sessions.drain(cut.signal);
  for (let round = 0; round < 20; round += 1) await settledTurn();
  world.gate.set();

  assert.equal(await asked, null);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
  cut.abort();
  await drain;
});

test("a drain that starts after the answer finds nothing to cancel", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  });
  assert.equal(await asked, session);

  const cut = new AbortController();
  cut.abort();
  await world.sessions.drain(cut.signal);
  assert.ok(!world.shown(ref).includes(texts.NOT_SENT));
  assert.ok(
    world
      .shown(ref)
      .includes(fill(texts.SETUP_SUMMARY, { model: "default", effort: "Default", bypass: "off" })),
  );
});

// --- The session's setup

test("a setup of an agent with no model list offers its effort levels and no bypass", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const request = open.request as SetupRequest;

  assert.deepEqual(request, {
    type: "setup",
    requestId: open.requestId,
    models: [],
    efforts: ["brief", "full"],
    bypassOffered: false,
    selection: { model: "default", effort: "default", bypass: false },
  });
  assert.equal(open.title, texts.SETUP_FALLBACK);
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, [open.message]);

  const lines = logged(t);
  assert.equal(
    await world.answers(open.requestId, {
      type: "setup",
      selection: { model: "default", effort: "full", bypass: false },
    }),
    true,
  );
  assert.equal(await asked, session);
  assert.deepEqual(lines, [
    `accepted a setup start in ${ref.channel}/${ref.thread} on message ${open.message}`,
  ]);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.effort, "full");
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
  // The message stays as the record of what was set, with nothing left to press.
  const kept = world.messages(ref).find((m) => m.id === open.message);
  assert.equal(
    kept?.text,
    fill(texts.SETUP_SUMMARY, { model: "default", effort: "full", bypass: "off" }),
  );
  assert.equal(kept?.pressable, false);
  assert.deepEqual(world.open(ref), []);
  assert.deepEqual(world.chat.strayCalls(), []);
});

test("a setup reads what the owner left against what was offered", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "gpt-x", effort: "turbo", bypass: false },
  });
  await asked;
  // A model nobody listed, an effort the agent does not take: both read as the default.
  assert.equal(world.state.thread(ref.channel, ref.thread)?.effort, null);
  assert.ok(
    world
      .shown(ref)
      .includes(fill(texts.SETUP_SUMMARY, { model: "default", effort: "Default", bypass: "off" })),
  );
});

test("a setup holds bypass to what was offered: an agent with no bypass mode gets none", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  assert.equal((open.request as SetupRequest).bypassOffered, false);
  // The controls offered no bypass: an answer that ticks it anyway reads as off.
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "full", bypass: true },
  });
  await asked;
  assert.notEqual(world.state.thread(ref.channel, ref.thread)?.bypass, true);
  assert.ok(
    world
      .shown(ref)
      .includes(fill(texts.SETUP_SUMMARY, { model: "default", effort: "full", bypass: "off" })),
  );
});

test("an agent that lists models and gave none offers no effort, and takes none", async (t) => {
  // The capability says the agent lists models; this session's list came back empty.
  const agent = new FakeAgentBackend([
    { info: { models: [], commands: [], permissionMode: "default" } },
  ]);
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const request = open.request as SetupRequest;
  assert.deepEqual(request.models, []);
  assert.deepEqual(request.efforts, []);
  // No effort was offered: one of the agent's own levels in the answer reads as the default.
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "high", bypass: false },
  });
  await asked;
  assert.equal(world.state.thread(ref.channel, ref.thread)?.effort, null);
  assert.equal(agent.sessions.at(-1)?.options.effort ?? null, null);
});

test("a setup of an agent with models offers them with bypass, and checks the choice", async (t) => {
  const agent = new FakeAgentBackend([]);
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const request = open.request as SetupRequest;
  assert.ok(request.models.length > 1);
  assert.deepEqual(request.efforts, []);
  assert.equal(request.bypassOffered, true);
  const withEffort = request.models.find((m) => m.supportsEffort);
  const without = request.models.find((m) => !m.supportsEffort);
  assert.ok(withEffort !== undefined && without !== undefined);
  const level = withEffort.supportedEffortLevels[0] as string;

  // An effort the chosen model does not take reads as the default.
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: without.value, effort: level, bypass: true },
  });
  await asked;
  const stored = world.state.thread(ref.channel, ref.thread);
  assert.equal(stored?.effort, null);
  assert.equal(stored?.bypass, true);
  assert.ok(
    world
      .shown(ref)
      .includes(
        fill(texts.SETUP_SUMMARY, { model: without.displayName, effort: "Default", bypass: "on" }),
      ),
  );
});

test("a stop cancels a setup: Not sent., the message removed, nothing applied", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");

  await session.stop();
  assert.equal(await asked, null);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.NOT_SENT]);
  assert.ok(!world.shown(ref).includes(open.title));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.effort, null);
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
});

test("a stop that lands while the summary waits on the chat sends nothing and writes no summary", async (t) => {
  const world = await AskingWorld.make(t, { gated: true });
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "full", bypass: false },
  });
  for (let round = 0; round < 20; round += 1) await settledTurn();
  await session.stop();
  world.gate.set();

  assert.equal(await asked, null);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.NOT_SENT]);
  assert.ok(!world.shown(ref).some((text) => text.startsWith("Model:")));
});

test("a setup answered twice is refused the second time", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const selection = { model: "default", effort: "default", bypass: false };
  await world.inbound.answer(ref, open.requestId, { type: "setup", selection }, open.message);
  await asked;
  const lines = logged(t);

  assert.equal(
    await world.inbound.answer(ref, open.requestId, { type: "setup", selection }, open.message),
    false,
  );
  assert.deepEqual(world.shown(ref).slice(-1), [texts.HOLD_GONE]);
  assert.deepEqual(lines, [
    `refused a click (setup start, not held) in ${ref.channel}/${ref.thread} on message ${open.message}; held=False`,
  ]);
});

// Issue #142: a second Start while the first is applied finds the setup decided. The summary that
// replaces the controls is on its way, and a notice under it would contradict it.
test("a second start while the first is applied is refused with no word", async (t) => {
  const world = await AskingWorld.make(t, { gated: true });
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const selection = { model: "default", effort: "default", bypass: false };
  await world.inbound.answer(ref, open.requestId, { type: "setup", selection }, open.message);
  for (let round = 0; round < 20; round += 1) await settledTurn();
  const shownBefore = world.shown(ref).length;
  const lines = logged(t);

  assert.equal(
    await world.inbound.answer(ref, open.requestId, { type: "setup", selection }, open.message),
    false,
  );
  assert.equal(world.shown(ref).length, shownBefore);
  assert.deepEqual(lines, [
    `refused a click (setup start, not resolved) in ${ref.channel}/${ref.thread} on message ${open.message}; held=True, decided=True, same_thread=True`,
  ]);
  world.gate.set();
  assert.equal(await asked, session);
  assert.ok(!world.shown(ref).includes(texts.HOLD_GONE));
});

test("a setup answered from another thread is refused with what differs", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const elsewhere = world.thread().ref;
  const lines = logged(t);

  const selection = { model: "default", effort: "default", bypass: false };
  assert.equal(
    await world.inbound.answer(
      elsewhere,
      open.requestId,
      { type: "setup", selection },
      open.message,
    ),
    false,
  );
  assert.deepEqual(world.shown(elsewhere).slice(-1), [texts.HOLD_GONE]);
  assert.deepEqual(lines, [
    `refused a click (setup start, not resolved) in ${elsewhere.channel}/${elsewhere.thread} on message ${open.message}; held=True, decided=False, same_thread=False`,
  ]);
  await world.answers(open.requestId, { type: "setup", selection });
  assert.equal(await asked, session);
});

test("a setup for a session that closed before it is asked goes on with the thread's fresh one", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  await session.close();

  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  });
  const live = await asked;
  assert.ok(live !== null && live !== session, "the message is sent on the fresh session");
  assert.equal(live.closed, false);
});

test("a setup for a session whose thread is gone fails with SessionGone", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  await session.close();
  world.state.removeThread(ref.channel, ref.thread);

  await assert.rejects(
    world.flows.setup.beforeSending(ref, session),
    (error: unknown) =>
      error instanceof SessionGone && error.message === named(texts.SESSION_GONE, PLAIN_NAMES),
  );
  assert.deepEqual(world.chat.requests(), []);
});

test("a session that closes while its setup is open: the answer fails, the message is removed", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const failure = assert.rejects(asked, (error: unknown) => error instanceof SessionClosed);
  await session.close();
  await world.answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "full", bypass: false },
  });
  await failure;
  assert.ok(!world.shown(ref).includes(open.title));
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
});

// --- A tool's permission and the agent's questions

/** A turn that asks permission for one call, answered by the test. */
async function permissionAsked(world: AskingWorld) {
  const { ref, session } = world.thread();
  (world.agent as PlainAgent).next(
    say("Reading it."),
    call("Shell", { command: "ls" }, { permission: true }),
    say("Done."),
  );
  const turn = await session.submit("list the files");
  const open = await world.asked(ref, "permission");
  return { ref, session, turn, open };
}

test("an approved permission lets the call run and removes the request", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session, turn, open } = await permissionAsked(world);
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, [open.message]);

  assert.equal(await world.answers(open.requestId, { type: "permission", allow: true }), true);
  await turn.done.wait();
  const agent = world.agent as PlainAgent;
  assert.deepEqual(
    agent.sessions[0]?.answers.map((a) => a.answer),
    [{ allow: true }],
  );
  assert.deepEqual(world.open(ref), []);
  assert.ok(!world.messages(ref).some((m) => m.id === open.message), "the request is removed");
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
  assert.ok(session.channelId === ref.channel);
});

test("a denied permission tells the agent so", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, turn, open } = await permissionAsked(world);

  assert.equal(await world.answers(open.requestId, { type: "permission", allow: false }), true);
  await turn.done.wait();
  const agent = world.agent as PlainAgent;
  assert.deepEqual(
    agent.sessions[0]?.answers.map((a) => a.answer),
    [{ allow: false, message: named(texts.DENY_MESSAGE, PLAIN_NAMES) }],
  );
  assert.deepEqual(world.open(ref), []);
});

test("a chat with no reactions stores the status as words, and the file reads them back", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, turn, open } = await permissionAsked(world);
  const stored = () => world.state.thread(ref.channel, ref.thread);
  assert.deepEqual([stored()?.status, stored()?.ended], ["waiting", null]);

  await world.answers(open.requestId, { type: "permission", allow: true });
  await turn.done.wait();
  for (let round = 0; round < 200 && stored()?.ended !== "done"; round += 1) await settledTurn();
  assert.deepEqual([stored()?.status, stored()?.ended], [null, "done"]);
  // The words are what the file holds.
  const again = new StateStore(join(world.folder, "state.json"));
  assert.deepEqual(again.thread(ref.channel, ref.thread), stored());
});

test("a permission answered twice is refused the second time: the owner is told", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, turn, open } = await permissionAsked(world);
  await world.inbound.answer(
    ref,
    open.requestId,
    { type: "permission", allow: true },
    open.message,
  );
  await turn.done.wait();

  const again = await world.inbound.answer(
    ref,
    open.requestId,
    { type: "permission", allow: false },
    open.message,
  );
  assert.equal(again, false);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.APPROVAL_GONE]);
  const agent = world.agent as PlainAgent;
  assert.equal(agent.sessions[0]?.answers.length, 1);
});

test("a permission answered from another thread is refused and stays open", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, turn, open } = await permissionAsked(world);
  const elsewhere = world.thread().ref;

  assert.equal(
    await world.inbound.answer(
      elsewhere,
      open.requestId,
      { type: "permission", allow: true },
      open.message,
    ),
    false,
  );
  assert.deepEqual(world.shown(elsewhere).slice(-1), [texts.APPROVAL_GONE]);
  assert.equal(world.open(ref).length, 1);
  await world.answers(open.requestId, { type: "permission", allow: true });
  await turn.done.wait();
});

test("an answered question reaches the agent and the request is not removed by the answer", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  (world.agent as PlainAgent).next(question("Which one?", ["red", "blue"]), say("Chosen."));
  const turn = await session.submit("pick one");
  const open = await world.asked(ref, "question");
  assert.equal(open.request.type, "question");

  assert.equal(
    await world.answers(open.requestId, { type: "question", answers: { "Which one?": "blue" } }),
    true,
  );
  await turn.done.wait();
  const agent = world.agent as PlainAgent;
  assert.deepEqual(
    agent.sessions[0]?.answers.map((a) => a.answer),
    [{ answered: true, answers: { "Which one?": "blue" } }],
  );
  assert.deepEqual(world.open(ref), []);
});

test("a skipped question tells the agent the form was skipped and removes the request", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  (world.agent as PlainAgent).next(question("Which one?", ["red", "blue"]), say("Moving on."));
  const turn = await session.submit("pick one");
  const open = await world.asked(ref, "question");

  assert.equal(await world.answers(open.requestId, { type: "question", answers: null }), true);
  await turn.done.wait();
  const agent = world.agent as PlainAgent;
  assert.deepEqual(
    agent.sessions[0]?.answers.map((a) => a.answer),
    [{ answered: false, message: texts.SKIP_MESSAGE }],
  );
  assert.ok(!world.messages(ref).some((m) => m.id === open.message));
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
});

test("a question answered twice is refused the second time", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  (world.agent as PlainAgent).next(question("Which one?", ["red", "blue"]), say("Chosen."));
  const turn = await session.submit("pick one");
  const open = await world.asked(ref, "question");
  const answer = { type: "question", answers: { "Which one?": "red" } } as const;
  await world.inbound.answer(ref, open.requestId, answer, open.message);
  await turn.done.wait();

  assert.equal(await world.inbound.answer(ref, open.requestId, answer, null), false);
  assert.deepEqual(world.shown(ref).slice(-1), [texts.APPROVAL_GONE]);
});

// --- The owner check stays in the chat

test("an answer from someone else never reaches the core, whatever the request", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const permission = await permissionAsked(world);
  const held = world.thread();
  const hold = world.flows.hold.beforeSending(held.ref, held.session, other.session);
  const holdOpen = await world.asked(held.ref, "hold");
  const setupThread = world.thread();
  const setup = world.flows.setup.beforeSending(setupThread.ref, setupThread.session);
  const setupOpen = await world.asked(setupThread.ref, "setup");
  (world.agent as PlainAgent).next(question("Which one?", ["red", "blue"]));
  const asking = world.thread();
  await asking.session.submit("pick one");
  const questionOpen = await world.asked(asking.ref, "question");
  const reachedBefore = world.reached.length;

  const answers = [
    [permission.open.requestId, { type: "permission", allow: true }],
    [holdOpen.requestId, { type: "hold", send: true }],
    [
      setupOpen.requestId,
      { type: "setup", selection: { model: "default", effort: "full", bypass: true } },
    ],
    [questionOpen.requestId, { type: "question", answers: { "Which one?": "red" } }],
    [questionOpen.requestId, { type: "question", answers: null }],
  ] as const;
  for (const [requestId, answer] of answers) {
    assert.equal(await world.chat.as(SOMEONE).answers(requestId, answer), null);
  }
  assert.equal(world.reached.length, reachedBefore, "nothing reached the core");
  assert.equal(world.open(permission.ref).length, 1);
  assert.equal(world.open(held.ref).length, 1);
  assert.equal(world.open(setupThread.ref).length, 1);
  assert.equal(world.open(asking.ref).length, 1);

  // The owner still can.
  assert.equal(
    await world.chat.as(OWNER).answers(holdOpen.requestId, { type: "hold", send: false }),
    true,
  );
  assert.equal(await hold, false);
  await world.answers(setupOpen.requestId, {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  });
  await setup;
  await world.answers(permission.open.requestId, { type: "permission", allow: true });
  await permission.turn.done.wait();
  await world.answers(questionOpen.requestId, { type: "question", answers: null });
});

// --- An answer is of the kind of the request it names

const ANY_SELECTION = { model: "default", effort: "default", bypass: false };

test("a setup answer with a hold's id is refused, logged, and the hold stays answerable", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const { ref, session } = world.thread();
  const sent = world.flows.hold.beforeSending(ref, session, other.session);
  const open = await world.asked(ref, "hold");
  const lines = logged(t);

  assert.equal(
    await world.inbound.answer(
      ref,
      open.requestId,
      { type: "setup", selection: ANY_SELECTION },
      open.message,
    ),
    false,
  );
  assert.deepEqual(world.shown(ref).slice(-1), [texts.HOLD_GONE]);
  assert.deepEqual(lines, [
    `refused a click (setup start, wrong kind) in ${ref.channel}/${ref.thread} on message ${open.message}; held=True, decided=False, kind_matches=False`,
  ]);
  assert.equal(world.open(ref).length, 1, "the hold is still open");
  assert.equal(world.holds.get(open.requestId)?.decided, false);

  assert.equal(await world.answers(open.requestId, { type: "hold", send: true }), true);
  assert.equal(await sent, true);
});

test("a hold answer with a setup's id is refused, logged, and the setup stays answerable", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");
  const lines = logged(t);

  assert.equal(
    await world.inbound.answer(ref, open.requestId, { type: "hold", send: true }, open.message),
    false,
  );
  assert.deepEqual(world.shown(ref).slice(-1), [texts.HOLD_GONE]);
  assert.deepEqual(lines, [
    `refused a click (hold decision, wrong kind) in ${ref.channel}/${ref.thread} on message ${open.message}; send=True, held=True, decided=False, kind_matches=False`,
  ]);
  assert.equal(world.open(ref).length, 1, "the setup is still open");

  assert.equal(
    await world.answers(open.requestId, { type: "setup", selection: ANY_SELECTION }),
    true,
  );
  assert.equal(await asked, session);
});

test("a setup of an agent with no models is still told from a hold", async (t) => {
  const agent = new FakeAgentBackend([
    { info: { models: [], commands: [], permissionMode: "default" } },
  ]);
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  const asked = world.flows.setup.beforeSending(ref, session);
  const open = await world.asked(ref, "setup");

  assert.equal(
    await world.inbound.answer(ref, open.requestId, { type: "hold", send: true }, open.message),
    false,
  );
  assert.equal(world.open(ref).length, 1, "the setup is still open");
  assert.equal(
    await world.answers(open.requestId, { type: "setup", selection: ANY_SELECTION }),
    true,
  );
  await asked;
});

test("a permission answer with a question's id is refused and the question stays answerable", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  (world.agent as PlainAgent).next(question("Which one?", ["red", "blue"]), say("Chosen."));
  const turn = await session.submit("pick one");
  const open = await world.asked(ref, "question");

  for (const allow of [true, false]) {
    assert.equal(
      await world.inbound.answer(ref, open.requestId, { type: "permission", allow }, open.message),
      false,
    );
    assert.deepEqual(world.shown(ref).slice(-1), [texts.APPROVAL_GONE]);
    assert.equal(world.open(ref).length, 1, "the question is still open");
  }
  assert.equal(
    await world.answers(open.requestId, { type: "question", answers: { "Which one?": "red" } }),
    true,
  );
  await turn.done.wait();
  const agent = world.agent as PlainAgent;
  assert.deepEqual(
    agent.sessions[0]?.answers.map((a) => a.answer),
    [{ answered: true, answers: { "Which one?": "red" } }],
  );
});

test("a question answer with a permission's id is refused and the permission stays answerable", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, turn, open } = await permissionAsked(world);

  assert.equal(
    await world.inbound.answer(
      ref,
      open.requestId,
      { type: "question", answers: { "Which one?": "red" } },
      open.message,
    ),
    false,
  );
  assert.deepEqual(world.shown(ref).slice(-1), [texts.APPROVAL_GONE]);
  assert.equal(world.open(ref).length, 1, "the permission is still open");

  assert.equal(await world.answers(open.requestId, { type: "permission", allow: true }), true);
  await turn.done.wait();
  const agent = world.agent as PlainAgent;
  assert.deepEqual(
    agent.sessions[0]?.answers.map((a) => a.answer),
    [{ allow: true }],
  );
});

// --- The message that goes is the one the core stored

test("a permission answered with a decoy message removes the request's own message", async (t) => {
  const world = await AskingWorld.make(t);
  const real = await permissionAsked(world);
  const decoy = await permissionAsked(world);

  assert.equal(
    await world.inbound.answer(
      real.ref,
      real.open.requestId,
      { type: "permission", allow: true },
      decoy.open.message,
    ),
    true,
  );
  await real.turn.done.wait();
  assert.ok(
    !world.messages(real.ref).some((m) => m.id === real.open.message),
    "the request's own message is removed",
  );
  assert.deepEqual(world.state.thread(real.ref.channel, real.ref.thread)?.requests, []);
  assert.ok(
    world.messages(decoy.ref).some((m) => m.id === decoy.open.message),
    "the decoy stays",
  );
  assert.deepEqual(world.state.thread(decoy.ref.channel, decoy.ref.thread)?.requests, [
    decoy.open.message,
  ]);
  assert.equal(world.open(decoy.ref).length, 1, "the decoy's request is still open");
  await world.answers(decoy.open.requestId, { type: "permission", allow: true });
  await decoy.turn.done.wait();
});

test("a hold answered with a decoy message removes the hold's own message", async (t) => {
  const world = await AskingWorld.make(t);
  const other = await busyNeighbour(world);
  const decoy = await permissionAsked(world);
  const { ref, session } = world.thread();
  const sent = world.flows.hold.beforeSending(ref, session, other.session);
  const open = await world.asked(ref, "hold");

  assert.equal(
    await world.inbound.answer(
      ref,
      open.requestId,
      { type: "hold", send: true },
      decoy.open.message,
    ),
    true,
  );
  assert.equal(await sent, true);
  assert.ok(!world.messages(ref).some((m) => m.id === open.message), "the hold's own is removed");
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
  assert.ok(world.messages(decoy.ref).some((m) => m.id === decoy.open.message));
  await world.answers(decoy.open.requestId, { type: "permission", allow: true });
  await decoy.turn.done.wait();
});

test("a permission answered from its own message makes one removal", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, turn, open } = await permissionAsked(world);
  const withdraw = t.mock.method(world.sessions.chatOf(ref.channel, ref.thread), "withdraw");

  await world.inbound.answer(
    ref,
    open.requestId,
    { type: "permission", allow: true },
    open.message,
  );
  await turn.done.wait();
  assert.deepEqual(
    withdraw.mock.calls.map((call) => call.arguments),
    [[open.message]],
  );
});

test("a permission answered with no message still removes the request's own", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, turn, open } = await permissionAsked(world);

  await world.inbound.answer(ref, open.requestId, { type: "permission", allow: true }, null);
  await turn.done.wait();
  assert.ok(!world.messages(ref).some((m) => m.id === open.message));
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
});
