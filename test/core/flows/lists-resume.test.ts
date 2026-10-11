/**
 * `!resume` as a flow of the core, over the memory chat and the plain agent's record of
 * sessions: the list, a typed target, a pick, and every way a pick can be stale.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import { oneLine } from "../../../src/core/reply/words.ts";
import * as texts from "../../../src/core/texts.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { PLAIN_CAPABILITIES, PlainAgent } from "../../support/plain-agent.ts";
import { ListsWorld } from "./lists-world.ts";

const { fill, named } = texts;

const FIRST = "aaaaaaaa-0000-4000-8000-000000000001";
const SECOND = "aaaaaaaa-0000-4000-8000-000000000002";
const THIRD = "bbbbbbbb-0000-4000-8000-000000000003";

/** A bound channel whose folder holds three sessions, the second the newest. */
async function withSessions(t: Parameters<typeof ListsWorld.build>[0]): Promise<ListsWorld> {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  world.remember(world.app, FIRST, "Fix the footer", 1_000);
  world.remember(world.app, SECOND, "Add a trust gate", 3_000);
  world.remember(world.app, THIRD, "Rename the folder", 2_000);
  return world;
}

/** The link the memory chat gives, which is none: the text falls back to the thread's name. */
function linkTo(thread: string): string {
  return fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: thread });
}

test("an unbound channel is told how to bind, and no list is posted", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.resume.word(await world.word(), "");
  assert.deepEqual(world.said().slice(1), [
    fill(named(texts.UNBOUND, world.names), { root: world.root }),
  ]);
  assert.deepEqual(world.chat.lists(), []);
});

test("with no target the sessions are listed newest first, with the thread they resume into", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  assert.equal(list?.title, fill(texts.RESUME_LIST, { directory: world.app }));
  assert.equal(list?.list.type, "sessions");
  if (list?.list.type !== "sessions") return;
  assert.equal(list.list.folder, world.app);
  assert.deepEqual(
    list.list.sessions.map((session) => session.id),
    [SECOND, THIRD, FIRST],
  );
  assert.equal(list.list.held, 0);
  assert.deepEqual(list.list.thread, ref);
});

test("the rows leave out the sessions a thread holds, and count them", async (t) => {
  const world = await withSessions(t);
  world.state.openThread(world.channel, "1780000000.000009", SECOND);
  await world.flows.resume.word(await world.word(), "");
  const [list] = world.chat.lists();
  assert.ok(list?.list.type === "sessions");
  if (list?.list.type !== "sessions") return;
  assert.deepEqual(
    list.list.sessions.map((session) => session.id),
    [THIRD, FIRST],
  );
  assert.equal(list.list.held, 1);
});

test("a typed id prefix resumes the session into the thread of the word", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word("!resume bbbbbbbb");
  await world.flows.resume.word(ref, "bbbbbbbb");
  assert.equal(world.state.thread(ref.channel, ref.thread)?.sessionId, THIRD);
  assert.deepEqual(world.chat.texts(ref.channel, ref.thread).slice(1), [
    fill(texts.RESUME_OK, { title: "Rename the folder" }),
  ]);
  assert.deepEqual(world.chat.lists(), []);
});

test("a title is shown to the chat as a reference, shortened to one line", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  const title = `${"long ".repeat(40)}\nsecond line`;
  world.remember(world.app, FIRST, title, 1);
  const ref = await world.word();
  await world.flows.resume.word(ref, FIRST);
  assert.deepEqual(world.chat.texts(ref.channel, ref.thread).slice(1), [
    fill(texts.RESUME_OK, { title: oneLine(title, 80) }),
  ]);
});

test("a target that two sessions start with is ambiguous and resumes nothing", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "aaaaaaaa");
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.deepEqual(world.said().slice(-1), [
    fill(texts.RESUME_AMBIGUOUS, { directory: world.app, target: "aaaaaaaa" }),
  ]);
});

test("an unknown target, and an id too short to be one, name no session", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "nothing-like-it");
  await world.flows.resume.word(ref, "bbbbbbb");
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.deepEqual(world.said().slice(-2), [
    fill(texts.RESUME_NONE, { directory: world.app, target: "nothing-like-it" }),
    fill(texts.RESUME_NONE, { directory: world.app, target: "bbbbbbb" }),
  ]);
});

test("a typed target for a thread that already holds a session is refused", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  world.state.openThread(ref.channel, ref.thread, FIRST);
  await world.flows.resume.word(ref, "bbbbbbbb");
  assert.equal(world.state.thread(ref.channel, ref.thread)?.sessionId, FIRST);
  assert.deepEqual(world.said().slice(-1), [texts.RESUME_HELD]);
});

test("a typed target held by another thread is refused with a link to it", async (t) => {
  const world = await withSessions(t);
  const other = await world.word();
  const ref = await world.word();
  await world.flows.resume.word(other, "bbbbbbbb");
  await world.flows.resume.word(ref, "bbbbbbbb");
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.deepEqual(world.said().slice(-1), [
    fill(texts.RESUME_ELSEWHERE, { link: linkTo(other.thread) }),
  ]);
});

test("a pick resumes the session into the thread the list names and takes the list away", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  assert.equal(await world.chat.as(OWNER).picks(list?.message ?? "", THIRD), true);
  assert.deepEqual(world.picked, [
    { type: "session", channel: world.channel, sessionId: THIRD, thread: ref, list: list?.message },
  ]);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.sessionId, THIRD);
  assert.deepEqual(world.chat.texts(ref.channel, ref.thread).slice(1), [
    fill(texts.RESUME_OK, { title: "Rename the folder" }),
  ]);
  assert.deepEqual(world.chat.lists(), []);
  assert.equal(world.faulty.rewrites.length, 0);
});

test("two picks at once into one thread resume one: the checks and the resume share a step", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  const message = list?.message ?? "";
  await Promise.all([
    world.chat.as(OWNER).picks(message, FIRST),
    world.chat.as(OWNER).picks(message, THIRD),
  ]);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.sessionId, FIRST);
  assert.ok(world.said().includes(texts.RESUME_HELD));
});

test("a pick of a session another thread took meanwhile is refused and leaves the list", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  world.state.openThread(world.channel, "1780000000.000009", THIRD);
  await world.chat.as(OWNER).picks(list?.message ?? "", THIRD);
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.deepEqual(world.said().slice(-1), [
    fill(texts.RESUME_ELSEWHERE, { link: linkTo("1780000000.000009") }),
  ]);
  assert.equal(world.chat.lists().length, 1);
  assert.equal(world.faulty.rewrites.length, 0);
});

test("a pick into a thread that already holds a session is refused and leaves the list", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  world.state.openThread(ref.channel, ref.thread, FIRST);
  await world.chat.as(OWNER).picks(list?.message ?? "", THIRD);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.sessionId, FIRST);
  assert.deepEqual(world.said().slice(-1), [texts.RESUME_HELD]);
  assert.equal(world.chat.lists().length, 1);
});

test("a pick after the channel was bound elsewhere finds the session gone", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  await world.bound(world.docs);
  await world.chat.as(OWNER).picks(list?.message ?? "", THIRD);
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.deepEqual(world.said().slice(-1), [texts.RESUME_GONE]);
  assert.equal(world.chat.lists().length, 1);
});

/** A pick of `THIRD`, as a list would give it, but for the thread and channel named. */
function pick(world: ListsWorld, thread: ThreadRef | null, channel = world.channel): Promise<void> {
  return world.flows.picks.picked({
    type: "session",
    channel,
    sessionId: THIRD,
    thread,
    list: "msg-none",
  });
}

test("a pick that names no thread is a list from before it did", async (t) => {
  const world = await withSessions(t);
  await pick(world, null);
  assert.deepEqual(world.said(), [texts.RESUME_STALE]);
  assert.equal(world.state.channel(world.channel)?.threads.size, 0);
});

test("a pick from a channel that is not bound is told how to bind", async (t) => {
  const world = await withSessions(t);
  const elsewhere = world.chat.openChannel("elsewhere");
  await pick(world, { channel: elsewhere, thread: "1780000000.000009" }, elsewhere);
  assert.deepEqual(world.chat.texts(elsewhere), [
    fill(named(texts.UNBOUND, world.names), { root: world.root }),
  ]);
});

test("a pick is not trusted: the thread opens in the channel that was checked", async (t) => {
  const world = await withSessions(t);
  const elsewhere = world.chat.openChannel("elsewhere");
  await pick(world, { channel: elsewhere, thread: "1780000000.000009" });
  assert.equal(world.state.thread(world.channel, "1780000000.000009")?.sessionId, THIRD);
  assert.equal(world.state.channel(elsewhere), null);
});

test("a pick of a session the folder does not hold finds it gone", async (t) => {
  const world = await withSessions(t);
  world.remember(world.docs, "cccccccc-0000-4000-8000-000000000004", "Elsewhere", 1);
  await world.flows.picks.picked({
    type: "session",
    channel: world.channel,
    sessionId: "cccccccc-0000-4000-8000-000000000004",
    thread: { channel: world.channel, thread: "1780000000.000009" },
    list: "msg-none",
  });
  assert.deepEqual(world.said(), [texts.RESUME_GONE]);
});

test("when the confirmation fails the list is rewritten into the record, and the failure is told", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  world.faulty.sayFails = true;
  await world.chat.as(OWNER).picks(list?.message ?? "", THIRD);
  // The session is resumed either way.
  assert.equal(world.state.thread(ref.channel, ref.thread)?.sessionId, THIRD);
  assert.deepEqual(world.faulty.rewrites, [
    [
      list?.message,
      fill(texts.RESUME_LISTED, { title: "Rename the folder", link: linkTo(ref.thread) }),
    ],
  ]);
  assert.deepEqual(world.chat.lists(), []);
  const shown = world.chat.messages(world.channel).find((m) => m.id === list?.message);
  assert.ok(shown !== undefined && !shown.pressable && shown.kind === "notice");
  assert.deepEqual(world.said().slice(-1), [
    fill(named(texts.ERROR_REPLY, world.names), { error: "Error" }),
  ]);
});

test("when the chat refuses to remove the list it is rewritten into the record", async (t) => {
  const world = await withSessions(t);
  const ref = await world.word();
  await world.flows.resume.word(ref, "");
  const [list] = world.chat.lists();
  world.faulty.withdrawRefused = true;
  await world.chat.as(OWNER).picks(list?.message ?? "", THIRD);
  assert.deepEqual(world.faulty.rewrites, [
    [
      list?.message,
      fill(texts.RESUME_LISTED, { title: "Rename the folder", link: linkTo(ref.thread) }),
    ],
  ]);
  assert.deepEqual(world.chat.texts(ref.channel, ref.thread).slice(1), [
    fill(texts.RESUME_OK, { title: "Rename the folder" }),
  ]);
});

/** An agent that keeps no list of its sessions. */
class Unlisted extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, sessionListing: false };
}

// What the core says today for an agent without `sessionListing`: the list it posts is empty,
// and a typed target names nothing. No text says that the agent keeps no list.
test("an agent with no session listing gets an empty list and finds no target", async (t) => {
  const world = await ListsWorld.build(t, new Unlisted());
  await world.bound(world.app);
  world.remember(world.app, FIRST, "Fix the footer", 1_000);
  await world.flows.resume.word(await world.word(), "");
  const [list] = world.chat.lists();
  assert.ok(list?.list.type === "sessions");
  if (list?.list.type !== "sessions") return;
  assert.deepEqual(list.list.sessions, []);
  assert.equal(list.list.held, 0);
  await world.flows.resume.word(await world.word(), FIRST);
  assert.deepEqual(world.said().slice(-1), [
    fill(texts.RESUME_NONE, { directory: world.app, target: FIRST }),
  ]);
});
