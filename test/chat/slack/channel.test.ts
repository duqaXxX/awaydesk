/**
 * `SlackChat.channel`: where a word typed in the channel is answered, outside any thread.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ListedSession } from "../../../src/agent/seam.ts";
import { ChatError } from "../../../src/chat/seam.ts";
import { bindBlocks } from "../../../src/chat/slack/bind.ts";
import { logger } from "../../../src/chat/slack/channel.ts";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import { resumeBlocks } from "../../../src/chat/slack/resume.ts";
import { CHANNEL, FakeClock, rejected, THREAD } from "../../support/fake-slack.ts";
import { NAMES } from "../../support/names.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

const MESSAGE = "1780000000.000009";

test("a notice is a normal post in the channel, small and grey", async () => {
  const { slack, chat } = madeChat();
  await chat.channel(CHANNEL).notice("This channel is bound to `app`.");
  assert.deepEqual(slack.callsTo("chat.postMessage"), [
    {
      channel: CHANNEL,
      text: "This channel is bound to `app`.",
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "This channel is bound to `app`." }],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    },
  ]);
});

test("a reference is a markdown block in the channel, split in chunks", async () => {
  const { slack, chat } = madeChat();
  await chat.channel(CHANNEL).say("# Status");
  assert.deepEqual(slack.callsTo("chat.postMessage"), [
    {
      channel: CHANNEL,
      text: "# Status",
      blocks: [{ type: "markdown", text: "# Status" }],
      unfurl_links: false,
      unfurl_media: false,
    },
  ]);
});

test("the channel's words reject with a ChatError named by Slack's code", async () => {
  const { slack, chat } = madeChat();
  slack.responses["chat.postMessage"] = rejected("is_archived");
  const refused = (error: unknown) => error instanceof ChatError && error.name === "is_archived";
  await assert.rejects(chat.channel(CHANNEL).notice("words"), refused);
  await assert.rejects(chat.channel(CHANNEL).say("words"), refused);
});

test("a list of folders is a post with a row for each", async () => {
  const { slack, chat } = madeChat();
  const list = {
    type: "folders",
    root: "/work",
    folders: ["/work/b", "/work/a"],
    bound: "/work/a",
  } as const;
  await chat.channel(CHANNEL).offer(list, "Folders under /work");
  assert.deepEqual(slack.callsTo("chat.postMessage"), [
    {
      channel: CHANNEL,
      text: "Folders under /work",
      blocks: JSON.parse(
        JSON.stringify(bindBlocks("/work", ["/work/b", "/work/a"], "/work/a", NAMES)),
      ),
      unfurl_links: false,
      unfurl_media: false,
    },
  ]);
});

test("a list of sessions is a post that names the thread the pick will live in", async () => {
  const clock = new FakeClock();
  clock.now = 1_780_000_000;
  const { slack, chat } = madeChat({ clock });
  const sessions: ListedSession[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Fix the tests",
      customTitle: null,
      branch: "main",
      size: 1024,
      lastModified: 1_779_990_000_000,
    },
  ];
  await chat.channel(CHANNEL).offer(
    {
      type: "sessions",
      folder: "/work/a",
      sessions,
      held: 2,
      thread: { channel: CHANNEL, thread: THREAD },
    },
    "Sessions of /work/a",
  );
  assert.deepEqual(slack.callsTo("chat.postMessage"), [
    {
      channel: CHANNEL,
      text: "Sessions of /work/a",
      blocks: JSON.parse(
        JSON.stringify(resumeBlocks("/work/a", sessions, 2, new Date(1_780_000_000_000), THREAD)),
      ),
      unfurl_links: false,
      unfurl_media: false,
    },
  ]);
});

test("withdraw deletes the list, and says so when Slack refuses", async (t) => {
  const { slack, chat } = madeChat();
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  assert.equal(await chat.channel(CHANNEL).withdraw(MESSAGE), true);
  assert.deepEqual(slack.callsTo("chat.delete"), [{ channel: CHANNEL, ts: MESSAGE }]);
  slack.responses["chat.delete"] = rejected("cant_delete_message");
  assert.equal(await chat.channel(CHANNEL).withdraw(MESSAGE), false);
  assert.deepEqual(warnings, [`could not delete a list in ${CHANNEL}: cant_delete_message`]);
});

test("rewrite turns the list into a notice", async () => {
  const { slack, chat } = madeChat();
  await chat.channel(CHANNEL).rewrite(MESSAGE, "Resumed `Fix the tests`.");
  assert.deepEqual(slack.callsTo("chat.update"), [
    {
      channel: CHANNEL,
      ts: MESSAGE,
      text: "Resumed `Fix the tests`.",
      blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: "Resumed `Fix the tests`." }] },
      ],
    },
  ]);
});

test("the channel does nothing once the provider stopped", async () => {
  const { slack, chat } = madeChat();
  await chat.stop();
  const channel = chat.channel(CHANNEL);
  await channel.notice("words");
  await channel.say("words");
  await channel.offer({ type: "folders", root: "/work", folders: [], bound: null }, "Folders");
  assert.deepEqual(slack.apiCalls, []);
});
