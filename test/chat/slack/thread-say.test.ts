/**
 * `SlackThread.say`: a reference at full size, in markdown blocks, split past a block's limit.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ChatError } from "../../../src/chat/seam.ts";
import { split } from "../../../src/chat/slack/reply/blocks.ts";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import { CHANNEL, OWNER, rejected, THREAD } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

test("say posts a markdown block in the thread", async () => {
  const { slack, thread } = madeChat();
  await thread.say("# Words\n\n- `!stop`");
  assert.deepEqual(slack.callsTo("chat.postMessage"), [
    {
      channel: CHANNEL,
      text: "# Words\n\n- `!stop`",
      blocks: [{ type: "markdown", text: "# Words\n\n- `!stop`" }],
      unfurl_links: false,
      unfurl_media: false,
      thread_ts: THREAD,
    },
  ]);
});

test("say for the owner alone posts an ephemeral message", async () => {
  const { slack, thread } = madeChat();
  await thread.say("the status", { ownerOnly: true });
  assert.deepEqual(slack.callsTo("chat.postEphemeral"), [
    {
      channel: CHANNEL,
      user: OWNER,
      text: "the status",
      blocks: [{ type: "markdown", text: "the status" }],
      thread_ts: THREAD,
    },
  ]);
  assert.deepEqual(slack.callsTo("chat.postMessage"), []);
});

test("a long reference continues in further messages, one per chunk", async () => {
  const { slack, thread } = madeChat();
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const chunks = split(long);
  assert.ok(chunks.length > 1);
  await thread.say(long);
  const posted = slack.callsTo("chat.postMessage");
  assert.deepEqual(
    posted.map((call) => (call.blocks as Array<{ text: string }>)[0]?.text),
    chunks,
  );
});

test("say rejects with a ChatError named by Slack's code", async () => {
  const { slack, thread } = madeChat();
  slack.responses["chat.postMessage"] = rejected("channel_not_found");
  await assert.rejects(
    thread.say("words"),
    (error: unknown) => error instanceof ChatError && error.name === "channel_not_found",
  );
});

test("say does nothing once the provider stopped", async () => {
  const { slack, chat, thread } = madeChat();
  await chat.stop();
  await thread.say("words");
  assert.deepEqual(slack.apiCalls, []);
});
