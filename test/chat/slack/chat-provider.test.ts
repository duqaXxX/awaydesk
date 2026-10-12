/**
 * `SlackChat` as the daemon drives it: its name and capabilities, the escapes, the channel
 * lookup, the session index, and the connection it opens (`start`), closes (`stop`) and leaves
 * (`close`).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Receiver } from "@slack/bolt";
import type { ChatInbound } from "../../../src/chat/seam.ts";
import { ChannelGuard } from "../../../src/chat/slack/app/guards.ts";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import * as slackTexts from "../../../src/chat/slack/texts.ts";
import { SlackChat } from "../../../src/chat/slack/thread.ts";
import { AGENT, CHANNEL, rejected, THREAD } from "../../support/fake-slack.ts";
import { worldOf } from "../../support/slack-app.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

const NOBODY: ChatInbound = {
  message: async () => {},
  answer: async () => false,
  picked: async () => {},
};

test("the provider names itself and supports every part of the seam", () => {
  const { chat } = madeChat();
  assert.equal(chat.name, "Slack");
  assert.deepEqual(chat.capabilities, {
    nativeStreaming: true,
    reactions: true,
    activityLine: true,
    fileUpload: true,
  });
});

const OTHER_AGENT = {
  name: "Other Agent",
  words: {
    author: "Other",
    command: "other",
    examples: "`!one`, `!two`",
    newSession: ["fresh"],
    login: "enter",
    logout: "leave",
    terminal: "cd {directory} && other --resume {session}",
  },
};

test("the names are the agent's and the chat's, read when first needed and once", () => {
  let reads = 0;
  const { chat } = madeChat({
    agent: () => {
      reads += 1;
      return OTHER_AGENT;
    },
  });
  assert.equal(reads, 0, "the agent exists only after the provider was built");
  chat.thread({ channel: CHANNEL, thread: THREAD });
  chat.channel(CHANNEL);
  assert.equal(reads, 0);
  const expected = {
    agent: "Other Agent",
    author: "Other",
    cli: "other",
    chat: "Slack",
    examples: "`!one`, `!two`",
    login: "enter",
    logout: "leave",
    newSession: ["fresh"],
  };
  assert.deepEqual(chat.names(), expected);
  assert.deepEqual(chat.names(), expected);
  assert.equal(reads, 1);
});

test("a thread's answered question names the agent the provider was given", async () => {
  const { slack, chat } = madeChat({ agent: () => OTHER_AGENT });
  const thread = chat.thread({ channel: CHANNEL, thread: THREAD });
  const questions = [{ header: "", text: "Colour?", multiSelect: false, options: [] }];
  const request = {
    type: "question",
    requestId: "request-1",
    callId: "toolu_1",
    toolName: "AskUserQuestion",
    title: null,
    questions,
  } as const;
  const ts = await thread.ask("request-1", request, "a question");
  await thread.keepAnswers(ts, questions, { "Colour?": "Red" });
  const [asked] = slack.callsTo("chat.postMessage");
  assert.match(JSON.stringify(asked?.blocks), /Other Agent has a question/);
  const [update] = slack.callsTo("chat.update");
  assert.equal(update?.text, "User answered Other's questions:");
});

test("a notice escapes mrkdwn's three characters, a reference Markdown's marks", () => {
  const { chat } = madeChat();
  const text = "a <b> & *c* [d](e)";
  assert.equal(chat.escape(text, "notice"), "a &lt;b&gt; &amp; *c* [d](e)");
  assert.equal(chat.escape(text, "reference"), "a <b> \\& \\*c\\* \\[d\\]\\(e\\)");
});

test("a thread was opened at its ts, in seconds; a name that is no number says nothing", () => {
  const { chat } = madeChat();
  assert.equal(chat.openedAt({ channel: CHANNEL, thread: "1780000000.000100" }), 1780000000.0001);
  assert.equal(chat.openedAt({ channel: CHANNEL, thread: "" }), null);
  assert.equal(chat.openedAt({ channel: CHANNEL, thread: " " }), null);
  assert.equal(chat.openedAt({ channel: CHANNEL, thread: "not-a-ts" }), null);
});

test("a channel is gone only for channel_not_found", async () => {
  const { slack, chat } = madeChat();
  assert.equal(await chat.channelState(CHANNEL), "there");
  assert.deepEqual(slack.callsTo("conversations.info"), [{ channel: CHANNEL }]);
  slack.responses["conversations.info"] = rejected("channel_not_found");
  assert.equal(await chat.channelState(CHANNEL), "gone");
  slack.responses["conversations.info"] = rejected("ratelimited");
  await assert.rejects(
    chat.channelState(CHANNEL),
    (error: unknown) => error instanceof Error && error.name === "ratelimited",
  );
});

test("a provider with no Home has no session index and nothing to start", async () => {
  const { chat } = madeChat();
  assert.equal(chat.index, undefined);
  await assert.rejects(chat.start(NOBODY), /no app to open/);
  await chat.close(); // nothing to write one last time
});

/** A provider with the world's own parts as `start` opens them, and the receiver it opens. */
function started(world: ReturnType<typeof worldOf>, options: { stuck?: boolean } = {}) {
  const receiver = { started: 0, stopped: 0 };
  const socket: Receiver = {
    init: () => {},
    start: async () => {
      receiver.started += 1;
    },
    stop: async () => {
      receiver.stopped += 1;
      if (options.stuck) throw new Error("socket stuck");
    },
  };
  let cores = 0;
  const chat = new SlackChat({
    slack: world.slack,
    replies: world.slack,
    identity: world.identity,
    agent: () => AGENT,
    limiter: world.limiter,
    clock: world.slackClock,
    app: {
      core: () => {
        cores += 1;
        return world.core;
      },
      config: world.config,
      guard: new ChannelGuard(world.slack, world.identity),
      home: world.home,
      uploads: world.uploads,
      receiver: socket,
    },
  });
  return { chat, receiver, cores: () => cores };
}

test("start opens the connection, reading the core only then; stop closes it", async (t) => {
  const world = worldOf(t);
  const { chat, receiver, cores } = started(world);
  assert.equal(cores(), 0, "the core is read when the connection opens, not before");
  await chat.start(NOBODY);
  assert.equal(cores(), 1);
  assert.equal(receiver.started, 1);
  assert.equal(chat.stopped.aborted, false);
  await chat.stop();
  assert.equal(receiver.stopped, 1);
  assert.equal(chat.stopped.aborted, true);
});

test("stop stops what listens even when the connection will not close", async (t) => {
  const world = worldOf(t);
  const { chat } = started(world, { stuck: true });
  await chat.start(NOBODY);
  await assert.rejects(chat.stop(), /socket stuck/);
  assert.equal(chat.stopped.aborted, true);
});

test("the session index asks the Home tab to publish the sessions that changed", async (t) => {
  const world = worldOf(t);
  const { chat } = started(world);
  const index = chat.index;
  assert.ok(index);
  const asked: unknown[] = [];
  t.mock.method(world.home, "request", (changed?: unknown) => asked.push(changed));
  const ref = { channel: CHANNEL, thread: THREAD };
  index.refresh([ref]);
  index.refresh();
  assert.deepEqual(asked, [[ref], undefined]);
});

test("close writes the Home tab one last time", async (t) => {
  const world = worldOf(t);
  const { chat } = started(world);
  let closed = 0;
  t.mock.method(world.home, "close", async () => {
    closed += 1;
  });
  await chat.close();
  assert.equal(closed, 1);
});

test("openFile shares a file of the folder into the thread, or offers the picker", async (t) => {
  const world = worldOf(t);
  const { chat } = started(world);
  await chat.start(NOBODY);
  const folder = join(world.root, "app");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "notes.txt"), "hello\n");
  const ref = { channel: CHANNEL, thread: THREAD };
  await chat.openFile(ref, folder, "notes.txt");
  const [asked] = world.slack.callsTo("files.getUploadURLExternal");
  assert.ok(asked && asked.filename === "notes.txt" && asked.length === 6);
  const [done] = world.slack.callsTo("files.completeUploadExternal");
  assert.ok(done && done.channel_id === CHANNEL && done.thread_ts === THREAD);
  world.slack.apiCalls.length = 0;
  await chat.openFile(ref, folder, "");
  const [picker] = world.slack.callsTo("chat.postMessage");
  assert.ok(picker && picker.text === slackTexts.OPEN_FALLBACK && picker.thread_ts === THREAD);
  await chat.stop();
});

test("openFile before the connection is opened is a mistake", async () => {
  const { chat } = madeChat();
  await assert.rejects(
    chat.openFile({ channel: CHANNEL, thread: THREAD }, "/work", "a"),
    /not started/,
  );
});
