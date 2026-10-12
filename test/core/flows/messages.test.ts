/**
 * The message flow of the core, over the memory chat: what a message of the owner's means by
 * where it was written and what it is, and how a prompt reaches its session. The chat only
 * draws; a second chat that draws gets the same behaviour as Slack.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { logger } from "../../../src/core/flows/talk.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-slack.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld, NoCommands, PLAIN_NAMES } from "./messages-world.ts";

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

// --- Where a message was written

test("a message in the channel opens a thread, asks the setup and sends the prompt once started", async (t) => {
  const world = await MessagesWorld.make(t);
  const sending = world.says("build the module");
  const open = await world.asked("setup");
  assert.deepEqual(await world.prompts(), [], "nothing is sent before Start");
  await world.start(open.ref);
  const sent = await sending;
  assert.equal(sent.topLevel, true);
  assert.deepEqual(await world.prompts(), ["build the module"]);
  assert.equal(world.state.thread(sent.ref.channel, sent.ref.thread)?.directory, world.folder);
  assert.deepEqual(world.chat.strayCalls(), []);
});

test("a message in a channel bound to no folder says where sessions start", async (t) => {
  const world = await MessagesWorld.make(t);
  const free = world.chat.openChannel("free");
  await world.chat.as(OWNER).says(free, "hello");
  assert.deepEqual(world.chat.texts(free).slice(1), [
    fill(texts.UNBOUND_ANY, { root: world.folder }),
  ]);
  assert.deepEqual(await world.prompts(), []);
  assert.deepEqual(world.chat.requests(), []);
});

test("a reply in a session's thread is sent at once, with no second setup", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("first");
  await world.says("and a test", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "and a test"]);
  assert.deepEqual(world.chat.requests(), []);
});

test("a reply in a thread that holds no session is told so, and sent nowhere", async (t) => {
  const world = await MessagesWorld.make(t);
  const old = world.chat.openThread(world.channel);
  await world.says("hello again", old.thread);
  assert.deepEqual(world.shown(old).slice(1), ["hello again", texts.NOT_A_SESSION]);
  assert.deepEqual(await world.prompts(), []);
  assert.equal(world.state.thread(old.channel, old.thread), null);
});

test("a message the chat marks literal is a prompt, whatever its first characters", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = { channel: world.channel, thread: "root-1" };
  const sending = world.send({ ref, id: "root-1", topLevel: true, text: "!stop", literal: true });
  const open = await world.asked("setup");
  await world.start(open.ref);
  await sending;
  assert.deepEqual(await world.prompts(), ["!stop"]);
});

test("a word is read in the plain text when the typed text carries marks", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = { channel: world.channel, thread: "root-2" };
  await world.send({ ref, id: "root-2", topLevel: true, text: "`!status`", plain: "!status" });
  const header = fill(texts.STATUS_CHANNEL_HEADER, { directory: world.folder });
  assert.ok(
    world.inChannel().some((line) => line.startsWith(header)),
    "the word was answered in the channel",
  );
  assert.deepEqual(await world.prompts(), []);
});

// --- The agent's commands

test("a command the agent offers is sent as its slash command", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!echo hello there", ref.thread);
  assert.equal((await world.prompts()).at(-1), "/echo hello there");
});

test("a command the agent does not offer is sent as typed", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!nothing here", ref.thread);
  assert.equal((await world.prompts()).at(-1), "!nothing here");
});

test("a command that is only run on the host is answered, not sent", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!signin", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.LOGIN_ON_HOST, PLAIN_NAMES));
  assert.deepEqual(await world.prompts(), ["first"]);
  await world.says("!signout");
  assert.equal(world.inChannel().at(-1), named(texts.LOGOUT_ON_HOST, PLAIN_NAMES));
  assert.deepEqual(await world.prompts(), ["first"], "no session started either");
});

test("an agent with no commands of its own gets every !text as text", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new NoCommands() });
  const ref = await world.opened();
  await world.says("!login", ref.thread);
  await world.says("!clear", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "!login", "!clear"]);
  assert.ok(!world.shown(ref).includes(texts.CLEAR_IN_THREAD));
});

test("a command that starts a new session is refused inside a thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  for (const word of ["!restart", "!RESTART now"]) await world.says(word, ref.thread);
  assert.deepEqual(world.shown(ref).filter((line) => line === texts.CLEAR_IN_THREAD).length, 2);
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("another agent's login and new-session names reach the plain agent as any other text", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!clear", ref.thread);
  await world.says("!login", ref.thread);
  await world.says("!logout", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "!clear", "!login", "!logout"]);
  assert.ok(!world.shown(ref).includes(texts.CLEAR_IN_THREAD));
  assert.ok(!world.shown(ref).includes(named(texts.LOGIN_ON_HOST, PLAIN_NAMES)));
});

// --- A thread whose folder is no longer the channel's

test("a reply in a thread whose folder is not the channel's any more says so on every prompt", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const docs = join(world.folder, "docs");
  mkdirSync(docs);
  world.state.bind(world.channel, docs);
  const expected = fill(named(texts.OLD_THREAD_FOLDER, PLAIN_NAMES), {
    old: world.folder,
    new: docs,
  });
  await world.says("go on", ref.thread);
  await world.says("again", ref.thread);
  assert.equal(world.shown(ref).filter((line) => line === expected).length, 2);
  assert.deepEqual(await world.prompts(), ["first", "go on", "again"]);
});

// --- The order of a thread's messages

test("the messages of a thread are sent in the order they were written, whatever their files take", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const slow = new AsyncEvent();
  const first = world.send({
    ref,
    id: "slow",
    text: "with a file",
    content: async () => {
      await slow.wait();
      return "with a file, read";
    },
  });
  const second = world.send({ ref, id: "quick", text: "no file" });
  await world.settle();
  assert.deepEqual(await world.prompts(), ["first"], "the second waits for the first's turn");
  slow.set();
  await Promise.all([first, second]);
  assert.deepEqual(await world.prompts(), ["first", "with a file, read", "no file"]);
});

test("the turns of two threads do not wait for each other", async (t) => {
  const world = await MessagesWorld.make(t);
  const one = await world.opened("one");
  const other = await world.opened("other");
  const slow = new AsyncEvent();
  const stuck = world.send({
    ref: one,
    id: "slow",
    text: "slow",
    content: async () => {
      await slow.wait();
      return "slow";
    },
  });
  await world.says("quick", other.thread);
  assert.deepEqual((await world.prompts()).toSorted(), ["one", "other", "quick"]);
  slow.set();
  await stuck;
  assert.deepEqual((await world.prompts()).toSorted(), ["one", "other", "quick", "slow"]);
});

test("a message whose files could not be taken sends nothing and says nothing", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const shown = world.shown(ref).length;
  await world.send({ ref, id: "refused", text: "with a file", content: async () => null });
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).length, shown);
});

// --- A stop, a drain, a session that closed

test("a message that arrives while the daemon drains is refused and names what the stop waits for", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  const cut = new AbortController();
  const drain = world.sessions.drain(cut.signal);
  await world.settle();
  const other = world.chat.openThread(world.channel);
  await world.says("one more", ref.thread);
  const link = fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: ref.thread });
  assert.equal(
    world.shown(ref).at(-1),
    [
      texts.RESTARTING,
      texts.RESTART_WAITS_FOR,
      fill(texts.RESTART_WAIT_ROW, {
        channel: world.channel,
        link,
        hold: texts.RESTART_HOLD_TURN,
      }),
      texts.RESTART_WAIT_STOP,
    ].join("\n"),
  );
  assert.deepEqual(await world.prompts(), ["first", "a long job"]);
  assert.equal(other.thread === ref.thread, false);
  cut.abort();
  await drain;
});

test("a drain that began while a message waited for its files refuses the prompt", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const slow = new AsyncEvent();
  const sending = world.send({
    ref,
    id: "slow",
    text: "late",
    content: async () => {
      await slow.wait();
      return "late";
    },
  });
  await world.settle();
  world.sessions.draining = true;
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).at(-1), texts.RESTARTING);
});

test("a message does nothing once the daemon has stopped", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const slow = new AsyncEvent();
  const shown = world.shown(ref).length;
  const sending = world.send({
    ref,
    id: "slow",
    text: "late",
    content: async () => {
      await slow.wait();
      return "late";
    },
  });
  await world.settle();
  world.stopping.abort();
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).length, shown);
});

test("a session closed during a slow download is retried on a fresh one", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const slow = new AsyncEvent();
  const sending = world.send({
    ref,
    id: "slow",
    text: "more",
    content: async () => {
      await slow.wait();
      return "more";
    },
  });
  await world.settle();
  await session.close();
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first", "more"], "once, never twice");
  const rebuilt = world.sessions.get(ref.channel, ref.thread);
  assert.ok(rebuilt !== null && rebuilt !== session);
});

test("a retry that finds the thread gone answers session gone", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const slow = new AsyncEvent();
  const sending = world.send({
    ref,
    id: "slow",
    text: "more",
    content: async () => {
      await slow.wait();
      return "more";
    },
  });
  await world.settle();
  await session.close();
  world.state.removeThread(ref.channel, ref.thread);
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).at(-1), named(texts.SESSION_GONE, PLAIN_NAMES));
});

// --- The same-folder hold

test("a reply that would wake an idle session beside a busy one asks the hold first", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const neighbour = await world.opened("two");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", neighbour.thread);
  await world.settle();
  const sending = world.says("and this", ref.thread);
  const open = await world.asked("hold", ref);
  assert.equal((await world.prompts()).includes("and this"), false);
  await world.chat.as(OWNER).answers(open.requestId, { type: "hold", send: true });
  await sending;
  assert.equal((await world.prompts()).includes("and this"), true);
});

// --- A failure after the checks

test("a failure of a prompt reaches the owner in its thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const lines = logged(t);
  const ref = await world.opened();
  await world.send({
    ref,
    id: "broken",
    text: "x",
    content: async () => {
      throw new TypeError("a bug");
    },
  });
  assert.equal(
    world.shown(ref).at(-1),
    fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "TypeError" }),
  );
  assert.ok(
    lines.some((line) => line.includes(`a request failed in ${ref.channel}/${ref.thread}`)),
  );
  assert.deepEqual(await world.prompts(), ["first"]);
});
