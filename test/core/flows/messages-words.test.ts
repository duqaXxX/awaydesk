/**
 * The daemon's own words, typed as messages, over the memory chat: what each does in the
 * channel, in a session's thread and in a thread that holds no session, and what is answered.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { helpText } from "../../../src/core/commands.ts";
import { type GuideOffer, guideText } from "../../../src/core/guide.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { hold, PLAIN_COMMANDS, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld, NoCommands, PLAIN_NAMES, WithBypass } from "./messages-world.ts";

const identity = (text: string): string => text;

// --- !help and !guide

// The plain agent has no bypass mode and the memory chat no file upload: `!bypass` and `!open`
// are refused when typed, and the help does not list them.
const UNSERVED = new Set(["bypass", "open"]);

test("!help in the channel lists the daemon's words and says where the agent's commands are", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!help");
  assert.deepEqual(world.inChannel().slice(1), [
    helpText(null, "", identity, PLAIN_NAMES, true, UNSERVED),
  ]);
  assert.ok(world.inChannel().at(-1)?.includes(named(texts.HELP_UNBOUND, PLAIN_NAMES)));
  assert.deepEqual(await world.prompts(), []);
});

test("!help in a session's thread adds the commands the session offers, less those a thread refuses", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!help", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    helpText(PLAIN_COMMANDS, "", identity, PLAIN_NAMES, true, UNSERVED),
  );
  await world.says("!help count", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    helpText(PLAIN_COMMANDS, "count", identity, PLAIN_NAMES, true, UNSERVED),
  );
});

test("!help for an agent with no commands lists none", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new NoCommands() });
  const ref = await world.opened();
  await world.says("!help", ref.thread);
  const answer = world.shown(ref).at(-1) ?? "";
  assert.equal(answer, helpText(null, "", identity, PLAIN_NAMES, false, UNSERVED));
  assert.ok(!answer.includes(named(texts.HELP_AGENT, PLAIN_NAMES)));
  assert.ok(!answer.includes(named(texts.HELP_UNBOUND, PLAIN_NAMES)));
});

test("a mistyped word gets the full list", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!bypass maybe");
  assert.deepEqual(world.inChannel().slice(1), [
    helpText(null, "", identity, PLAIN_NAMES, true, UNSERVED),
  ]);
});

// What the plain agent and the memory chat can serve, written out.
const PLAIN_OFFER: GuideOffer = {
  folderTrust: false,
  models: false,
  efforts: true,
  bypass: false,
  commands: true,
  questions: true,
  backgroundTasks: false,
  sessionListing: true,
  fileUpload: false,
};

test("!guide is answered where it was typed", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!guide");
  assert.equal(world.inChannel().at(-1), guideText(PLAIN_NAMES, PLAIN_OFFER));
  await world.says("!guide", ref.thread);
  assert.equal(world.shown(ref).at(-1), guideText(PLAIN_NAMES, PLAIN_OFFER));
});

test("!guide offers what the agent and the chat declare", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass(), files: true });
  await world.says("!guide");
  assert.equal(
    world.inChannel().at(-1),
    guideText(PLAIN_NAMES, { ...PLAIN_OFFER, bypass: true, fileUpload: true }),
  );
});

// --- !bind and !resume

test("!bind with a folder binds the channel, and alone offers the folders", async (t) => {
  const world = await MessagesWorld.make(t);
  mkdirSync(join(world.folder, "docs"));
  await world.says("!bind docs");
  assert.equal(world.state.channel(world.channel)?.directory, join(world.folder, "docs"));
  assert.equal(
    world.inChannel().at(-1),
    fill(texts.BIND_OK, { directory: join(world.folder, "docs") }),
  );
  await world.says("!bind");
  const lists = world.chat.lists();
  assert.equal(lists.length, 1);
  assert.equal(lists[0]?.list.type, "folders");
});

test("!bind inside a session's thread, or with a folder in a thread without one, says it works in the channel", async (t) => {
  const world = await MessagesWorld.make(t);
  mkdirSync(join(world.folder, "docs"));
  const ref = await world.opened();
  const said = fill(texts.WORD_IN_THREAD, { word: "bind" });
  await world.says("!bind docs", ref.thread);
  await world.says("!bind", ref.thread);
  assert.deepEqual(
    world.shown(ref).filter((line) => line === said),
    [said, said],
  );
  const outside = world.chat.openThread(world.channel);
  await world.says("!bind docs", outside.thread);
  assert.equal(world.shown(outside).at(-1), said);
  assert.equal(world.state.channel(world.channel)?.directory, world.folder);
  await world.says("!bind", outside.thread);
  assert.equal(world.chat.lists().length, 1, "alone it lists the folders, as in the channel");
});

test("!resume offers the folder's sessions in the channel and is refused inside a thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const said = fill(texts.WORD_IN_THREAD, { word: "resume" });
  await world.says("!resume", ref.thread);
  assert.equal(world.shown(ref).at(-1), said);
  const outside = world.chat.openThread(world.channel);
  await world.says("!resume", outside.thread);
  assert.equal(world.shown(outside).at(-1), said);
  assert.deepEqual(world.chat.lists(), []);
  await world.says("!resume");
  assert.equal(world.chat.lists().length, 1);
  assert.equal(world.chat.lists()[0]?.list.type, "sessions");
});

// --- !bypass

test("!bypass belongs to a session", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  await world.says("!bypass on");
  assert.equal(world.inChannel().at(-1), texts.BYPASS_TOP_LEVEL);
});

test("!bypass switches a started session and keeps the choice", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = await world.opened();
  await world.says("!bypass on", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.BYPASS_ON_THREAD);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, true);
  await world.says("!bypass off", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.BYPASS_OFF_THREAD, PLAIN_NAMES));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, false);
  assert.deepEqual(world.chat.strayCalls(), [], "no reaction on a chat that has none");
});

test("!bypass before the setup is started changes nothing", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = world.chat.openThread(world.channel);
  world.sessions.open(ref.channel, ref.thread);
  await world.says("!bypass on", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.BYPASS_BEFORE_START);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, null);
});

test("!bypass for an agent with no bypass mode says so and stores nothing", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const before = world.state.thread(ref.channel, ref.thread)?.bypass;
  await world.says("!bypass on", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.BYPASS_UNAVAILABLE, PLAIN_NAMES));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, before);
  await world.says("!bypass off", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.BYPASS_UNAVAILABLE, PLAIN_NAMES));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, before);
  assert.notEqual(before, true);
});

test("a word that took effect is marked on the message only where the chat has reactions", async (t) => {
  const plain = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = await plain.opened();
  await plain.says("!bypass on", ref.thread);
  assert.deepEqual(plain.chat.strayCalls(), []);

  const reacting = await MessagesWorld.make(t, { agent: new WithBypass(), reactions: true });
  const there = await reacting.opened();
  const word = await reacting.says("!bypass on", there.thread);
  assert.ok(reacting.chat.strayCalls().includes(`acknowledge ${word.id}`));
});

// --- !stop

test("!stop in the channel stops what runs there, and says when nothing does", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!stop");
  assert.equal(world.inChannel().at(-1), texts.NOTHING_TO_STOP);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, true);
  await world.says("!stop");
  assert.equal(world.inChannel().at(-1), texts.STOPPED_CHANNEL);
  await world.settle();
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, false);
});

test("!stop in a session's thread answers with a post of the thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!stop", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.NOTHING_TO_STOP_THREAD);
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  await world.says("!stop", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.STOPPED_THREAD);
});

test("!stop in a thread that holds no session stops nothing and says where to send it", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  const outside = world.chat.openThread(world.channel);
  await world.says("!stop", outside.thread);
  assert.equal(world.shown(outside).at(-1), texts.STOP_OUTSIDE_SESSION);
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, true);
});

// --- !open

test("!open belongs to a session", async (t) => {
  const world = await MessagesWorld.make(t, { files: true });
  await world.says("!open notes.md");
  assert.equal(world.inChannel().at(-1), texts.OPEN_TOP_LEVEL);
  assert.deepEqual(world.fileCalls, []);
});

test("!open in a session's thread hands the folder and the words to a chat that can share a file", async (t) => {
  const world = await MessagesWorld.make(t, { files: true });
  const ref = await world.opened();
  await world.says("!open notes.md", ref.thread);
  await world.says("!open", ref.thread);
  assert.deepEqual(world.fileCalls, [
    [ref, world.folder, "notes.md"],
    [ref, world.folder, ""],
  ]);
});

test("!open in a chat that cannot share a file says so", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!open notes.md", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.OPEN_UNAVAILABLE, PLAIN_NAMES));
});

test("a failure of !open reaches the owner where the word was typed", async (t) => {
  const world = await MessagesWorld.make(t, { files: true, openFails: true });
  const ref = await world.opened();
  await world.says("!open notes.md", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "Error" }),
  );
});

// --- A failure of a word

test("a word that fails in the channel is answered in the channel, and in a thread under the word", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  t.mock.method(world.sessions, "sessionsOf", () => {
    throw new TypeError("boom");
  });
  const failed = fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "TypeError" });
  await world.says("!status");
  assert.equal(world.inChannel().at(-1), failed);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  t.mock.method(session, "status", async () => {
    throw new TypeError("boom");
  });
  await world.says("!status", ref.thread);
  assert.equal(world.shown(ref).at(-1), failed);
});
